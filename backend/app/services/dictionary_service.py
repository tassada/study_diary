import asyncio
from collections import deque
from io import BytesIO
import json
import re
import time
import uuid
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from PIL import Image, ImageDraw
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import AsyncSessionLocal, get_db_session
from ..models import AsyncJobModel, ChildModel, DictionaryLookupModel, utc_now_iso
from ..providers.deepseek_tools import recognize_image_via_deepseek_ocr
from ..providers.minio_store import minio_gateway
from ..schemas import (
    AsyncJobOut,
    DictionaryCharStrokeOut,
    DictionaryEntryOut,
    DictionaryLookupOut,
    DictionarySenseOut,
)
from .audit_logger import log_error, log_event
from .dsh_supervisor import run_supervised_dsh_task
from .image_pipeline import normalize_homework_image
from .tts_cache_service import get_or_synthesize_tts_key

dictionary_router = APIRouter()


def media_url(minio_key: str | None) -> str | None:
    if not minio_key:
        return None
    return f"/api/v1/media/{minio_key}"


def clean_headword_for_tts(raw_word: str) -> str:
    s = re.sub(r"\([^)]*\)|（[^）]*）|\[[^\]]*\]|/[^/]*/", "", raw_word or "")
    s = s.split(";")[0].split("；")[0].split(",")[0].split("，")[0].strip()
    return s[:48]


def extract_mask_boxes_1000(mask_png_bytes: bytes) -> list[list[int]]:
    with Image.open(BytesIO(mask_png_bytes)) as raw_mask:
        rgba = raw_mask.convert("RGBA")
        mw, mh = rgba.size
        if mw <= 0 or mh <= 0:
            return []

        gw = 220
        gh = max(1, round(gw * mh / mw))
        small_alpha = rgba.getchannel("A").resize((gw, gh), Image.Resampling.BILINEAR)
        alpha_bytes = small_alpha.tobytes()

    active = [[False] * gw for _ in range(gh)]
    has_any = False
    for y in range(gh):
        row_off = y * gw
        for x in range(gw):
            if alpha_bytes[row_off + x] > 28:
                active[y][x] = True
                has_any = True

    if not has_any:
        return []

    dilated = [[False] * gw for _ in range(gh)]
    for y in range(gh):
        for x in range(gw):
            if not active[y][x]:
                continue
            for dy in range(-1, 2):
                ny = y + dy
                if ny < 0 or ny >= gh:
                    continue
                for dx in range(-3, 4):
                    nx = x + dx
                    if 0 <= nx < gw:
                        dilated[ny][nx] = True

    visited = [[False] * gw for _ in range(gh)]
    raw_boxes: list[tuple[int, int, int, int, int]] = []

    for y in range(gh):
        for x in range(gw):
            if not dilated[y][x] or visited[y][x]:
                continue
            q: deque[tuple[int, int]] = deque([(x, y)])
            visited[y][x] = True
            min_x = max_x = x
            min_y = max_y = y
            area = 0
            while q:
                cx, cy = q.popleft()
                area += 1
                if cx < min_x:
                    min_x = cx
                if cx > max_x:
                    max_x = cx
                if cy < min_y:
                    min_y = cy
                if cy > max_y:
                    max_y = cy
                for ndy in (-1, 0, 1):
                    for ndx in (-1, 0, 1):
                        nx, ny = cx + ndx, cy + ndy
                        if 0 <= nx < gw and 0 <= ny < gh and dilated[ny][nx] and not visited[ny][nx]:
                            visited[ny][nx] = True
                            q.append((nx, ny))
            if area >= 4:
                raw_boxes.append((min_x, min_y, max_x, max_y, area))

    raw_boxes.sort(key=lambda b: (b[1] // 10, b[0]))

    boxes_1000: list[list[int]] = []
    for bx1, by1, bx2, by2, _ in raw_boxes[:8]:
        x1 = max(0, min(1000, int(bx1 * 1000 / gw)))
        y1 = max(0, min(1000, int(by1 * 1000 / gh)))
        x2 = max(0, min(1000, int((bx2 + 1) * 1000 / gw)))
        y2 = max(0, min(1000, int((by2 + 1) * 1000 / gh)))
        if x2 > x1 and y2 > y1:
            boxes_1000.append([x1, y1, x2, y2])
    return boxes_1000


def render_highlighted_preview_jpeg(
    base_jpeg_bytes: bytes,
    mask_png_bytes: bytes,
    boxes_1000: list[list[int]],
) -> bytes:
    with Image.open(BytesIO(base_jpeg_bytes)) as base_im, Image.open(BytesIO(mask_png_bytes)) as mask_im:
        base_rgba = base_im.convert("RGBA")
        bw, bh = base_rgba.size
        mask_alpha = mask_im.convert("RGBA").getchannel("A").resize((bw, bh), Image.Resampling.BILINEAR)
        tint = Image.new("RGBA", (bw, bh), (255, 92, 168, 0))
        scaled_alpha = mask_alpha.point(lambda a: min(125, int(a * 0.48)))
        tint.putalpha(scaled_alpha)
        merged = Image.alpha_composite(base_rgba, tint).convert("RGB")

        draw = ImageDraw.Draw(merged)
        for idx, (x1, y1, x2, y2) in enumerate(boxes_1000):
            px1 = int(x1 * bw / 1000)
            py1 = int(y1 * bh / 1000)
            px2 = int(x2 * bw / 1000)
            py2 = int(y2 * bh / 1000)
            draw.rectangle([px1, py1, px2, py2], outline=(201, 42, 106), width=3)
            badge_y = max(4, py1 - 24)
            draw.rectangle([px1, badge_y, px1 + 26, badge_y + 22], fill=(236, 95, 155))
            draw.text((px1 + 7, badge_y + 4), str(idx + 1), fill=(255, 255, 255))

        out = BytesIO()
        merged.save(out, format="JPEG", quality=86)
        return out.getvalue()


def crop_box_with_padding_jpeg(
    base_jpeg_bytes: bytes,
    box_1000: list[int],
    pad_x_ratio: float,
    pad_y_ratio: float,
    min_side_px: int = 96,
) -> bytes:
    with Image.open(BytesIO(base_jpeg_bytes)) as im:
        rgb = im.convert("RGB")
        w, h = rgb.size
        x1, y1, x2, y2 = box_1000
        bw_1000 = max(12, x2 - x1)
        bh_1000 = max(12, y2 - y1)

        px1 = max(0, int((x1 - bw_1000 * pad_x_ratio) * w / 1000) - 8)
        py1 = max(0, int((y1 - bh_1000 * pad_y_ratio) * h / 1000) - 8)
        px2 = min(w, int((x2 + bw_1000 * pad_x_ratio) * w / 1000) + 8)
        py2 = min(h, int((y2 + bh_1000 * pad_y_ratio) * h / 1000) + 8)

        crop = rgb.crop((px1, py1, max(px1 + 8, px2), max(py1 + 8, py2)))
        cw, ch = crop.size
        if cw < min_side_px or ch < min_side_px:
            scale = max(min_side_px / max(1, cw), min_side_px / max(1, ch))
            crop = crop.resize(
                (max(1, round(cw * scale)), max(1, round(ch * scale))),
                Image.Resampling.BICUBIC,
            )
        canvas = Image.new("RGB", (crop.width + 48, crop.height + 48), (255, 255, 255))
        canvas.paste(crop, (24, 24))
        buf = BytesIO()
        canvas.save(buf, format="JPEG", quality=92)
        return buf.getvalue()


def serialize_lookup_row(row: DictionaryLookupModel) -> DictionaryLookupOut:
    raw_entries = json.loads(row.entries_json or "[]")
    entries_out: list[DictionaryEntryOut] = []
    for item in raw_entries:
        strokes = [DictionaryCharStrokeOut(**s) for s in (item.get("charStrokes") or [])]
        senses = [DictionarySenseOut(**s) for s in (item.get("senses") or [])]
        entries_out.append(
            DictionaryEntryOut(
                entryId=str(item.get("entryId") or uuid.uuid4().hex[:10]),
                regionIndex=int(item.get("regionIndex") or 1),
                cropImageUrl=media_url(item.get("cropMinioKey")),
                unrecognized=bool(item.get("unrecognized", False)),
                unrecognizedReason=item.get("unrecognizedReason"),
                paintedRawText=str(item.get("paintedRawText") or ""),
                guessedCorrection=bool(item.get("guessedCorrection", False)),
                guessExplanation=item.get("guessExplanation"),
                sourceLanguage=str(item.get("sourceLanguage") or "zh"),
                headword=str(item.get("headword") or ""),
                chineseWord=str(item.get("chineseWord") or ""),
                pinyin=str(item.get("pinyin") or ""),
                chineseAudioUrl=media_url(item.get("chineseTtsKey")),
                englishWord=str(item.get("englishWord") or ""),
                ipa=str(item.get("ipa") or ""),
                englishAudioUrl=media_url(item.get("englishTtsKey")),
                charStrokes=strokes,
                senses=senses,
                synonyms=[str(x) for x in (item.get("synonyms") or [])],
                antonyms=[str(x) for x in (item.get("antonyms") or [])],
            )
        )
    return DictionaryLookupOut(
        id=row.id,
        childId=row.child_id,
        instruction=row.instruction,
        rawImageUrl=media_url(row.raw_image_key) or "",
        previewImageUrl=media_url(row.preview_image_key) or "",
        entries=entries_out,
        createdAt=row.created_at,
    )


async def update_dict_job(job_id: str, status: str, progress_text: str) -> None:
    async with AsyncSessionLocal() as db:
        job = await db.get(AsyncJobModel, job_id)
        if job:
            job.status = status
            job.progress_text = progress_text
            await db.commit()


async def execute_dictionary_lookup_job(
    job_id: str,
    lookup_id: str,
    child_id: str,
    raw_image_key: str,
    preview_image_key: str,
    boxes_1000: list[list[int]],
    instruction: str,
) -> None:
    started = time.perf_counter()
    try:
        raw_jpeg, _ = await minio_gateway.get_object_bytes(raw_image_key)
        await update_dict_job(
            job_id,
            "ocr_running",
            f"正在识别涂抹的 {len(boxes_1000)} 处文字与上下文...",
        )

        sem = asyncio.Semaphore(3)
        region_crops_meta: list[dict] = []

        async def _ocr_one_region(idx: int, box: list[int]) -> dict:
            tight_jpeg = crop_box_with_padding_jpeg(raw_jpeg, box, pad_x_ratio=0.14, pad_y_ratio=0.18)
            ctx_jpeg = crop_box_with_padding_jpeg(raw_jpeg, box, pad_x_ratio=1.6, pad_y_ratio=1.1)
            crop_key = f"dictionary-crops/{child_id}/{lookup_id}/region-{idx + 1}.jpg"
            await minio_gateway.put_bytes(crop_key, tight_jpeg, "image/jpeg")

            async with sem:
                tight_ocr, ctx_ocr = await asyncio.gather(
                    recognize_image_via_deepseek_ocr(tight_jpeg, f"dict_tight_{idx + 1}.jpg"),
                    recognize_image_via_deepseek_ocr(ctx_jpeg, f"dict_ctx_{idx + 1}.jpg"),
                )
            return {
                "regionIndex": idx + 1,
                "box1000": box,
                "cropMinioKey": crop_key,
                "tightOcrText": tight_ocr["plain_text"].strip(),
                "contextOcrText": ctx_ocr["plain_text"].strip(),
            }

        region_crops_meta = list(
            await asyncio.gather(
                *[_ocr_one_region(idx, box) for idx, box in enumerate(boxes_1000)]
            )
        )

        await update_dict_job(
            job_id,
            "dsh_running",
            "海星老师正在整理中英双解字典卡（笔画、拼音、音标、同反义词）...",
        )

        async with AsyncSessionLocal() as db:
            child = await db.get(ChildModel, child_id)
            if not child:
                raise RuntimeError("儿童档案不存在")

        prompt_regions = [
            {
                "regionIndex": r["regionIndex"],
                "paintedTightOcr": r["tightOcrText"],
                "surroundingContextOcr": r["contextOcrText"],
            }
            for r in region_crops_meta
        ]
        user_instr = instruction.strip() or "请对涂抹出来的字词做标准中英双解查字典解析"

        dsh_prompt = (
            "任务类型：小学生拍照涂抹查字典 / 中英双解词典（请直接输出纯 JSON，不要读写额外文件以最快速度响应）。\n"
            f"学生：{child.display_name}（{child.age}岁，{child.grade_label}）。\n"
            f"用户附加查词指令：「{user_instr}」\n"
            f"涂抹区域识别列表（共 {len(prompt_regions)} 处，`paintedTightOcr` 是手指画笔正下方识别出的字符，`surroundingContextOcr` 是该涂抹处周边的整词/整句上下文）：\n"
            f"{json.dumps(prompt_regions, ensure_ascii=False, indent=2)}\n\n"
            "请严格遵守以下字典编纂规则：\n"
            "1. 每一处涂抹区域对应返回 entries 数组中的 1 个字典条目（若某处长条涂抹明显同时涂了多个独立待查生词，也可拆分为多条并保留对应 regionIndex）。\n"
            "2. 【猜是否画错 / 涂偏补全】：对比 `paintedTightOcr` 与 `surroundingContextOcr`。如果孩子少涂了半个单词（例如只涂到 'diction'，上下文是 'dictionary'）、少涂了双音节词/成语的一半、或多涂进了旁边标点/相邻无关半字，请智能猜出真正想查的完整字词作为 `headword`，将 `guessedCorrection` 设为 true，并在 `guessExplanation` 用温和简短的话说明（如：\"涂抹处为「diction」，结合句子猜你想查完整单词「dictionary」\"）。若涂抹准确则 `guessedCorrection` 为 false。\n"
            "3. 【实在猜不出时坦诚告知】：如果 `paintedTightOcr` 为空或乱码，且结合上下文也无法判断孩子到底涂了哪个字词（例如涂在空白处、纯插图或字迹完全模糊），绝不能瞎编字词！此时必须将该条目的 `unrecognized` 设为 true，`unrecognizedReason` 写明友好提示（如：\"这处涂抹没有识别到清晰的字词，实在猜不出哦，请擦掉重涂准一点或重拍一张更清晰的照片试试\"），其余词典字段留空即可。\n"
            "4. 【中英两种一起返回 + 完整字典要素】：对于所有成功识别或猜出的条目（无论原词是中文还是英文），都必须同时给出中文与英文对照：\n"
            "   - `sourceLanguage`: 原词是中文填 \"zh\"，原词是英文填 \"en\"。\n"
            "   - `headword`: 被查原词本身（纯字词，不含音标拼音）。\n"
            "   - `chineseWord`: 中文词头（查中文时即被查词本身；查英文时填最核心对应的一个中文词，纯中文供独立点读，不要带括号解释）。\n"
            "   - `pinyin`: `chineseWord` 的标准带声调拼音（如 \"zhān yǎng\"）。\n"
            "   - `englishWord`: 英文词头（查英文时即被查词本身；查中文时填最地道对应的一个英文单词或短语，纯英文供独立点读，不要带斜杠或中文）。\n"
            "   - `ipa`: `englishWord` 的标准国际音标（如 \"/mæɡˈnɪfɪsnt/\"）。\n"
            "   - `charStrokes`: 汉字笔画数组。当查中文（或对应中文含重点生字）时，列出每个核心汉字的 `char`（单字）、`radical`（部首）、`totalStrokes`（总笔画数整数）、`strokeOrder`（按顺序列出标准笔顺，如 \"竖、横折、横、横、横...\"）。查中文时此数组不能为空！\n"
            "   - `senses`: 按字典义项 `1, 2, 3, 4` 编号的分条字义/词义数组（多义字词给 2~4 个常见义项，单义词给 1~2 个真实义项，不胡编），每项包含 `index`（1,2,3...）、`pos`（词性，如 \"v. 动词\" / \"n. 名词\" / \"adj. 形容词\"）、`zhMeaning`（清晰易懂的中文释义）、`enMeaning`（简明英文释义）、`example`（简短例句）。\n"
            "   - `synonyms`: 同义词/近义词字符串数组（2~4个）。\n"
            "   - `antonyms`: 反义词字符串数组（1~3个；若专有名词或具体物品确无反义词可填 []）。\n\n"
            "严格返回如下纯 JSON 对象：\n"
            "{\n"
            '  "entries": [\n'
            "    {\n"
            '      "regionIndex": 1,\n'
            '      "unrecognized": false,\n'
            '      "unrecognizedReason": null,\n'
            '      "paintedRawText": "涂抹处原始字符",\n'
            '      "guessedCorrection": false,\n'
            '      "guessExplanation": null,\n'
            '      "sourceLanguage": "zh",\n'
            '      "headword": "瞻仰",\n'
            '      "chineseWord": "瞻仰",\n'
            '      "pinyin": "zhān yǎng",\n'
            '      "englishWord": "revere",\n'
            '      "ipa": "/rɪˈvɪə(r)/",\n'
            '      "charStrokes": [\n'
            '        {"char": "瞻", "radical": "目", "totalStrokes": 17, "strokeOrder": "竖、横折、横、横、横、撇、横撇、撇、点、点、横、撇、竖、横、横、横、竖弯钩"}\n'
            "      ],\n"
            '      "senses": [\n'
            '        {"index": 1, "pos": "v. 动词", "zhMeaning": "怀着崇敬的心情观看", "enMeaning": "look at with reverence and respect", "example": "少先队员们怀着崇敬的心情瞻仰人民英雄纪念碑。"}\n'
            "      ],\n"
            '      "synonyms": ["敬仰", "仰望"],\n'
            '      "antonyms": ["轻视", "鄙视"]\n'
            "    }\n"
            "  ]\n"
            "}"
        )

        dsh_json, _ = await run_supervised_dsh_task(
            child,
            task_kind="dictionary_lookup",
            task_prompt=dsh_prompt,
            context={"expectedCount": len(region_crops_meta)},
        )
        raw_entries = dsh_json.get("entries") or []

        crop_by_region = {r["regionIndex"]: r["cropMinioKey"] for r in region_crops_meta}
        tight_by_region = {r["regionIndex"]: r["tightOcrText"] for r in region_crops_meta}
        stored_entries: list[dict] = []

        for idx, raw_e in enumerate(raw_entries):
            r_idx = int(raw_e.get("regionIndex") or (idx + 1))
            unrec = bool(raw_e.get("unrecognized", False))
            zh_word = str(raw_e.get("chineseWord") or "").strip()
            en_word = str(raw_e.get("englishWord") or "").strip()
            headword = str(raw_e.get("headword") or zh_word or en_word).strip()

            zh_tts_key: str | None = None
            en_tts_key: str | None = None

            strokes_norm = []
            for st in raw_e.get("charStrokes") or []:
                if not st.get("char"):
                    continue
                strokes_norm.append(
                    {
                        "char": str(st.get("char"))[:4],
                        "radical": str(st.get("radical") or "—"),
                        "totalStrokes": max(1, int(st.get("totalStrokes") or 1)),
                        "strokeOrder": str(st.get("strokeOrder") or ""),
                    }
                )

            senses_norm = []
            for s_i, sn in enumerate(raw_e.get("senses") or []):
                senses_norm.append(
                    {
                        "index": int(sn.get("index") or (s_i + 1)),
                        "pos": str(sn.get("pos") or ""),
                        "zhMeaning": str(sn.get("zhMeaning") or ""),
                        "enMeaning": str(sn.get("enMeaning") or ""),
                        "example": str(sn.get("example") or ""),
                    }
                )

            stored_entries.append(
                {
                    "entryId": f"dentry-{uuid.uuid4().hex[:10]}",
                    "regionIndex": r_idx,
                    "cropMinioKey": crop_by_region.get(r_idx),
                    "unrecognized": unrec,
                    "unrecognizedReason": raw_e.get("unrecognizedReason")
                    or ("这处涂抹没有识别出清晰字词，实在猜不出哦，请擦掉重涂或重拍试试" if unrec else None),
                    "paintedRawText": str(
                        raw_e.get("paintedRawText") or tight_by_region.get(r_idx) or ""
                    ),
                    "guessedCorrection": bool(raw_e.get("guessedCorrection", False)),
                    "guessExplanation": raw_e.get("guessExplanation"),
                    "sourceLanguage": "en" if raw_e.get("sourceLanguage") == "en" else "zh",
                    "headword": headword,
                    "chineseWord": zh_word,
                    "pinyin": str(raw_e.get("pinyin") or ""),
                    "chineseTtsKey": zh_tts_key,
                    "englishWord": en_word,
                    "ipa": str(raw_e.get("ipa") or ""),
                    "englishTtsKey": en_tts_key,
                    "charStrokes": strokes_norm,
                    "senses": senses_norm,
                    "synonyms": [str(x) for x in (raw_e.get("synonyms") or [])],
                    "antonyms": [str(x) for x in (raw_e.get("antonyms") or [])],
                }
            )

        async with AsyncSessionLocal() as db:
            lookup_row = DictionaryLookupModel(
                id=lookup_id,
                child_id=child_id,
                instruction=user_instr,
                raw_image_key=raw_image_key,
                preview_image_key=preview_image_key,
                entries_json=json.dumps(stored_entries, ensure_ascii=False),
                created_at=utc_now_iso(),
            )
            db.add(lookup_row)

            job = await db.get(AsyncJobModel, job_id)
            if job:
                job.status = "succeeded"
                job.progress_text = "查词完成！"
                job.result_json = json.dumps({"lookupId": lookup_id}, ensure_ascii=False)
                job.finished_at = utc_now_iso()
            await db.commit()

        log_event(
            "dictionary.lookup_succeeded",
            f"涂抹查字典完成 (共 {len(stored_entries)} 项)",
            jobId=job_id,
            lookupId=lookup_id,
            childId=child_id,
            regionCount=len(boxes_1000),
            words=[e["headword"] for e in stored_entries if not e["unrecognized"]],
            unrecognizedCount=sum(1 for e in stored_entries if e["unrecognized"]),
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
    except Exception as exc:
        log_error(
            "dictionary.lookup_failed",
            f"涂抹查字典失败 (lookup={lookup_id})",
            exc=exc,
            jobId=job_id,
            lookupId=lookup_id,
            childId=child_id,
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        async with AsyncSessionLocal() as db:
            job = await db.get(AsyncJobModel, job_id)
            if job:
                job.status = "failed"
                job.progress_text = "查字典解析失败"
                job.error_detail = str(exc)
                job.finished_at = utc_now_iso()
                await db.commit()


@dictionary_router.post(
    "/api/v1/children/{child_id}/dictionary/lookup",
    response_model=AsyncJobOut,
)
async def submit_dictionary_lookup(
    child_id: str,
    instruction: str = Form(""),
    image_file: UploadFile = File(...),
    mask_file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db_session),
) -> AsyncJobOut:
    child = await db.get(ChildModel, child_id)
    if not child:
        raise HTTPException(status_code=404, detail="儿童档案不存在")

    raw_img_bytes = await image_file.read()
    mask_png_bytes = await mask_file.read()
    if not raw_img_bytes or not mask_png_bytes:
        raise HTTPException(status_code=400, detail="请先上传照片并用画笔涂抹要查的字词")

    boxes_1000 = extract_mask_boxes_1000(mask_png_bytes)
    if not boxes_1000:
        raise HTTPException(status_code=400, detail="还没有涂抹任何字词哦，请先选画笔涂在想查的字词上")

    norm_jpeg, _, _ = normalize_homework_image(raw_img_bytes, max_edge=1600)
    preview_jpeg = render_highlighted_preview_jpeg(norm_jpeg, mask_png_bytes, boxes_1000)

    lookup_id = f"dict-{uuid.uuid4().hex[:12]}"
    raw_key = f"dictionary-raw/{child_id}/{lookup_id}.jpg"
    preview_key = f"dictionary-preview/{child_id}/{lookup_id}.jpg"
    await asyncio.gather(
        minio_gateway.put_bytes(raw_key, norm_jpeg, "image/jpeg"),
        minio_gateway.put_bytes(preview_key, preview_jpeg, "image/jpeg"),
    )

    job_id = f"job-dict-{uuid.uuid4().hex[:10]}"
    job = AsyncJobModel(
        id=job_id,
        child_id=child_id,
        task_id=lookup_id,
        job_type="dictionary_lookup",
        status="queued",
        progress_text=f"已框定 {len(boxes_1000)} 处涂抹区域，正在启动查词...",
        created_at=utc_now_iso(),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    log_event(
        "dictionary.lookup_queued",
        f"提交涂抹查字典 ({len(boxes_1000)} 处区域)",
        jobId=job_id,
        lookupId=lookup_id,
        childId=child_id,
        regionCount=len(boxes_1000),
        instruction=instruction[:100],
    )

    asyncio.create_task(
        execute_dictionary_lookup_job(
            job_id=job_id,
            lookup_id=lookup_id,
            child_id=child_id,
            raw_image_key=raw_key,
            preview_image_key=preview_key,
            boxes_1000=boxes_1000,
            instruction=instruction,
        )
    )

    return AsyncJobOut(
        id=job.id,
        childId=job.child_id,
        taskId=job.task_id,
        evalDate=job.eval_date,
        jobType=job.job_type,
        status=job.status,
        progressText=job.progress_text,
        errorDetail=job.error_detail,
        createdAt=job.created_at,
        finishedAt=job.finished_at,
    )


@dictionary_router.get(
    "/api/v1/dictionary/lookups/{lookup_id}",
    response_model=DictionaryLookupOut,
)
async def get_dictionary_lookup_detail(
    lookup_id: str,
    db: AsyncSession = Depends(get_db_session),
) -> DictionaryLookupOut:
    row = await db.get(DictionaryLookupModel, lookup_id)
    if not row:
        raise HTTPException(status_code=404, detail="查词记录不存在")
    return serialize_lookup_row(row)


@dictionary_router.get(
    "/api/v1/children/{child_id}/dictionary/history",
    response_model=list[DictionaryLookupOut],
)
async def list_dictionary_history(
    child_id: str,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db_session),
) -> list[DictionaryLookupOut]:
    res = await db.execute(
        select(DictionaryLookupModel)
        .where(DictionaryLookupModel.child_id == child_id)
        .order_by(DictionaryLookupModel.created_at.desc())
        .limit(limit)
    )
    rows = list(res.scalars().all())
    return [serialize_lookup_row(r) for r in rows]


@dictionary_router.delete("/api/v1/dictionary/lookups/{lookup_id}")
async def delete_dictionary_lookup(
    lookup_id: str,
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    row = await db.get(DictionaryLookupModel, lookup_id)
    if not row:
        raise HTTPException(status_code=404, detail="查词记录不存在")
    await db.delete(row)
    await db.commit()
    return {"deleted": True, "lookupId": lookup_id}


@dictionary_router.post("/api/v1/dictionary/pronounce")
async def pronounce_headword_only(word: str = Form(...)) -> dict:
    only_word = clean_headword_for_tts(word)
    if not only_word:
        raise HTTPException(status_code=400, detail="待朗读词条为空")
    key, cached = await get_or_synthesize_tts_key(
        only_word,
        voice_id="stella",
        prefix="dict-word",
    )
    return {"word": only_word, "audioUrl": media_url(key), "cached": cached}
