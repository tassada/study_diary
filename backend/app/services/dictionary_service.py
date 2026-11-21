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
from ..providers.deepseek_vlm import call_supervised_vlm_json
from ..providers.minio_store import minio_gateway
from ..schemas import (
    AsyncJobOut,
    DictionaryCharStrokeOut,
    DictionaryEntryOut,
    DictionaryLookupOut,
    DictionarySenseOut,
)
from .audit_logger import log_error, log_event
from .dsh_supervisor import audit_dsh_payload_completeness, job_supervisor
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

        gw = 360
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
            for dy in (-1, 0, 1):
                ny = y + dy
                if ny < 0 or ny >= gh:
                    continue
                for dx in (-1, 0, 1):
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
            if area >= 6:
                raw_boxes.append((min_x, min_y, max_x, max_y, area))

    raw_boxes.sort(key=lambda b: (b[1] // 16, b[0]))

    boxes_1000: list[list[int]] = []
    for bx1, by1, bx2, by2, _ in raw_boxes[:8]:
        x1 = max(0, min(1000, int(bx1 * 1000 / gw)))
        y1 = max(0, min(1000, int(by1 * 1000 / gh)))
        x2 = max(0, min(1000, int((bx2 + 1) * 1000 / gw)))
        y2 = max(0, min(1000, int((by2 + 1) * 1000 / gh)))
        if x2 > x1 and y2 > y1:
            boxes_1000.append([x1, y1, x2, y2])
    return boxes_1000


def parse_regions_1000(regions_json: str) -> list[list[int]]:
    try:
        parsed = json.loads(regions_json or "[]")
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    out: list[list[int]] = []
    for item in parsed[:8]:
        if isinstance(item, dict):
            raw = [item.get("x1"), item.get("y1"), item.get("x2"), item.get("y2")]
        elif isinstance(item, list) and len(item) == 4:
            raw = item
        else:
            continue
        try:
            x1, y1, x2, y2 = [max(0, min(1000, int(round(float(v))))) for v in raw]
        except (TypeError, ValueError):
            continue
        if x2 > x1 and y2 > y1:
            out.append([x1, y1, x2, y2])
    return out


def render_highlighted_preview_jpeg(
    base_jpeg_bytes: bytes,
    mask_png_bytes: bytes,
    boxes_1000: list[list[int]],
) -> bytes:
    with Image.open(BytesIO(base_jpeg_bytes)) as base_im, Image.open(BytesIO(mask_png_bytes)) as mask_im:
        base_rgba = base_im.convert("RGBA")
        bw, bh = base_rgba.size
        mask_alpha = mask_im.convert("RGBA").getchannel("A").resize((bw, bh), Image.Resampling.BILINEAR)
        tint = Image.new("RGBA", (bw, bh), (255, 220, 40, 0))
        scaled_alpha = mask_alpha.point(lambda a: min(130, int(a * 0.52)))
        tint.putalpha(scaled_alpha)
        merged = Image.alpha_composite(base_rgba, tint).convert("RGB")

        draw = ImageDraw.Draw(merged)
        for idx, (x1, y1, x2, y2) in enumerate(boxes_1000):
            px1 = int(x1 * bw / 1000)
            py1 = int(y1 * bh / 1000)
            px2 = int(x2 * bw / 1000)
            py2 = int(y2 * bh / 1000)
            draw.rectangle([px1, py1, px2, py2], outline=(225, 29, 72), width=4)
            badge_y = max(4, py1 - 24)
            draw.rectangle([px1, badge_y, px1 + 28, badge_y + 22], fill=(225, 29, 72))
            draw.text((px1 + 6, badge_y + 4), f"#{idx + 1}", fill=(255, 255, 255))

        out = BytesIO()
        merged.save(out, format="JPEG", quality=86)
        return out.getvalue()


def crop_box_with_padding_jpeg(
    source_jpeg_bytes: bytes,
    box_1000: list[int],
    pad_x_ratio: float,
    pad_y_ratio: float,
    min_side_px: int = 160,
) -> bytes:
    with Image.open(BytesIO(source_jpeg_bytes)) as im:
        rgb = im.convert("RGB")
        w, h = rgb.size
        x1, y1, x2, y2 = box_1000
        bw_1000 = max(12, x2 - x1)
        bh_1000 = max(12, y2 - y1)

        px1 = max(0, int((x1 - bw_1000 * pad_x_ratio) * w / 1000) - 6)
        py1 = max(0, int((y1 - bh_1000 * pad_y_ratio) * h / 1000) - 6)
        px2 = min(w, int((x2 + bw_1000 * pad_x_ratio) * w / 1000) + 6)
        py2 = min(h, int((y2 + bh_1000 * pad_y_ratio) * h / 1000) + 6)

        crop = rgb.crop((px1, py1, max(px1 + 8, px2), max(py1 + 8, py2)))
        cw, ch = crop.size
        if cw < min_side_px or ch < min_side_px:
            scale = max(min_side_px / max(1, cw), min_side_px / max(1, ch))
            crop = crop.resize(
                (max(1, round(cw * scale)), max(1, round(ch * scale))),
                Image.Resampling.BICUBIC,
            )
        canvas = Image.new("RGB", (crop.width + 32, crop.height + 32), (255, 255, 255))
        canvas.paste(crop, (16, 16))
        buf = BytesIO()
        canvas.save(buf, format="JPEG", quality=90)
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
    job_supervisor.heartbeat(job_id)
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
    job_supervisor.mark_started(job_id)
    try:
        raw_jpeg, _ = await minio_gateway.get_object_bytes(raw_image_key)
        annotated_jpeg, _ = await minio_gateway.get_object_bytes(preview_image_key)

        await update_dict_job(
            job_id,
            "dsh_running",
            f"DeepSeek-V4.1-Flash 正在直接审阅图中标记的 {max(1, len(boxes_1000))} 处字词...",
        )

        vlm_images: list[tuple[str, bytes]] = [
            ("已直接绘制红框/荧光涂色标记的全图", annotated_jpeg),
        ]
        crop_by_region: dict[int, str] = {}

        for idx, box in enumerate(boxes_1000[:6]):
            r_no = idx + 1
            clean_crop = crop_box_with_padding_jpeg(
                raw_jpeg,
                box,
                pad_x_ratio=0.10,
                pad_y_ratio=0.12,
            )
            marked_zoom = crop_box_with_padding_jpeg(
                annotated_jpeg,
                box,
                pad_x_ratio=0.45,
                pad_y_ratio=0.55,
            )
            crop_key = f"dictionary-crops/{child_id}/{lookup_id}/region-{r_no}.jpg"
            await minio_gateway.put_bytes(crop_key, clean_crop, "image/jpeg")
            crop_by_region[r_no] = crop_key
            vlm_images.append(
                (f"标记区域 #{r_no} 的带标记局部放大图（请只提取红框内部或荧光笔直接涂抹到的文字，严禁把框外/未涂色的邻词算进来）", marked_zoom)
            )

        async with AsyncSessionLocal() as db:
            child = await db.get(ChildModel, child_id)
            if not child:
                raise RuntimeError("儿童档案不存在")

        expected_regions = max(1, len(boxes_1000))
        user_instr = instruction.strip() or "请对图中红框圈出或荧光色涂抹的字词做精准中英双解查字典解析"

        vlm_prompt = (
            "你是专业的小学生多模态中英双解词典导师。请直接看上面传入的标记图片！\n"
            f"学生：{child.display_name}（{child.age}岁，{child.grade_label}）。\n"
            f"用户查词/翻译指令：「{user_instr}」\n"
            f"用户在图片像素上直接标记了 {expected_regions} 处目标（可能使用了【红色矩形框 #1/#2...】和/或【荧光色画笔涂抹】）。\n\n"
            "请严格遵守以下视觉识别与字典编纂铁律：\n"
            "1. 【像素级边界精准铁律（最重要）】：\n"
            "   - 只提取**物理上位于红色矩形框内部**或**被荧光颜色直接涂盖**的字词！\n"
            "   - 红框外面、荧光笔没有涂到的上下行文字或左右相邻单词（哪怕离得很近），绝对只是背景上下文，**严禁当作被查词返回**！\n"
            "   - 每一处独立标记区域对应返回 entries 中的 1 个条目（除非同一个大框/长涂抹里明确圈了多个并列独立单词且用户要求查多词，或圈了一整句话）。\n"
            "2. 【猜是否框偏/涂漏一半】：\n"
            "   - 只有当红框边线或荧光笔明显把**同一个单词或同一个成语/词语从中间切了一半**（例如单词 `listen` 只框到了 `lis`，或词语 `瞻仰` 只涂了 `瞻` 且上下文是连在一起的 `瞻仰`）时，才补全为完整词，将 `guessedCorrection` 设为 true 并在 `guessExplanation` 简短说明。\n"
            "   - 如果框内/涂抹处本身已经是一个完整独立的词（例如词表里的 `decide`，或标题 `新店预告`），`guessedCorrection` 必须为 false，直接查这个词本身，绝不要去猜它旁边或下一行没被框住的其他词！\n"
            "3. 【支持整句/短语翻译】：\n"
            "   - 如果某处红框或涂抹明显圈住了一整句话/长短语（或用户指令要求翻译句子），请把该完整句子作为条目返回：`headword` 填原句，`chineseWord` 填地道中文译文（或原中文句），`englishWord` 填对应英文译文（或原英文句），在 `senses[0]`（`pos`: \"整句精译\"）给出完整双语解释与句意点拨；若句中有 1 个核心难词也可额外附带一条该生词的字典卡。\n"
            "4. 【空白/纯图案实在猜不出时坦诚告知】：\n"
            "   - 如果某处红框或涂抹画在纯空白背景、插图或完全无法辨认的涂鸦上，绝不能瞎编字词！将该条目的 `unrecognized` 设为 true，`unrecognizedReason` 写明友好提示。\n"
            "5. 【完整中英双解字典要素】：\n"
            "   - `sourceLanguage`: 原文中文填 \"zh\"，英文填 \"en\"。\n"
            "   - `headword`: 被框/被涂的目标原词（纯字词，不带音标括号）。\n"
            "   - `chineseWord`: 中文词头（纯中文词，供点击发音只读词本身）。\n"
            "   - `pinyin`: 标准带声调拼音（如 \"yù gào\"）。\n"
            "   - `englishWord`: 英文词头（纯英文词或短语，供点击发音只读词本身）。\n"
            "   - `ipa`: 国际音标（如 \"/dɪˈsaɪd/\"）。\n"
            "   - `charStrokes`: 核心汉字笔画数组（单字 `char`、部首 `radical`、总笔画数 `totalStrokes`、标准笔顺 `strokeOrder`；查中文词条时必填）。\n"
            "   - `senses`: 按 `1, 2, 3, 4` 编号的常见字义/词义数组（每项含 `index`, `pos`, `zhMeaning`, `enMeaning`, `example`）。\n"
            "   - `synonyms`: 2~4 个同义词/近义词。\n"
            "   - `antonyms`: 1~3 个反义词（无反义词填 []）。\n\n"
            "严格只输出如下纯 JSON 对象：\n"
            "{\n"
            '  "entries": [\n'
            "    {\n"
            '      "regionIndex": 1,\n'
            '      "unrecognized": false,\n'
            '      "unrecognizedReason": null,\n'
            '      "paintedRawText": "框内/涂色处看到的原始文字",\n'
            '      "guessedCorrection": false,\n'
            '      "guessExplanation": null,\n'
            '      "sourceLanguage": "en",\n'
            '      "headword": "decide",\n'
            '      "chineseWord": "决定",\n'
            '      "pinyin": "jué dìng",\n'
            '      "englishWord": "decide",\n'
            '      "ipa": "/dɪˈsaɪd/",\n'
            '      "charStrokes": [\n'
            '        {"char": "决", "radical": "冫", "totalStrokes": 6, "strokeOrder": "点、提、横折、横、撇、捺"}\n'
            "      ],\n"
            '      "senses": [\n'
            '        {"index": 1, "pos": "v. 动词", "zhMeaning": "决定；下决心", "enMeaning": "to make a choice after thinking carefully", "example": "We decided to walk home. 我们决定走路回家。"}\n'
            "      ],\n"
            '      "synonyms": ["choose", "determine"],\n'
            '      "antonyms": ["hesitate"]\n'
            "    }\n"
            "  ]\n"
            "}"
        )

        vlm_json = await call_supervised_vlm_json(
            task_kind="dictionary_lookup",
            prompt_text=vlm_prompt,
            images=vlm_images,
            audit_fn=audit_dsh_payload_completeness,
            audit_context={"expectedCount": expected_regions},
        )
        raw_entries = vlm_json.get("entries") or []

        stored_entries: list[dict] = []
        for idx, raw_e in enumerate(raw_entries):
            r_idx = int(raw_e.get("regionIndex") or min(max(1, expected_regions), idx + 1))
            unrec = bool(raw_e.get("unrecognized", False))
            zh_word = str(raw_e.get("chineseWord") or "").strip()
            en_word = str(raw_e.get("englishWord") or "").strip()
            headword = str(raw_e.get("headword") or zh_word or en_word).strip()

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
                    "cropMinioKey": crop_by_region.get(r_idx) or crop_by_region.get(1),
                    "unrecognized": unrec,
                    "unrecognizedReason": raw_e.get("unrecognizedReason")
                    or ("这处标记没有识别出清晰字词，实在猜不出哦，请重框或重涂试试" if unrec else None),
                    "paintedRawText": str(raw_e.get("paintedRawText") or headword),
                    "guessedCorrection": bool(raw_e.get("guessedCorrection", False)),
                    "guessExplanation": raw_e.get("guessExplanation"),
                    "sourceLanguage": "en" if raw_e.get("sourceLanguage") == "en" else "zh",
                    "headword": headword,
                    "chineseWord": zh_word,
                    "pinyin": str(raw_e.get("pinyin") or ""),
                    "chineseTtsKey": None,
                    "englishWord": en_word,
                    "ipa": str(raw_e.get("ipa") or ""),
                    "englishTtsKey": None,
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
                job.progress_text = "多模态查词完成！"
                job.result_json = json.dumps({"lookupId": lookup_id}, ensure_ascii=False)
                job.finished_at = utc_now_iso()
            await db.commit()

        log_event(
            "dictionary.lookup_succeeded",
            f"DeepSeek-V4.1-Flash 查字典完成 (共 {len(stored_entries)} 项)",
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
            f"多模态查字典失败 (lookup={lookup_id})",
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
    finally:
        job_supervisor.mark_finished(job_id)


@dictionary_router.post(
    "/api/v1/children/{child_id}/dictionary/lookup",
    response_model=AsyncJobOut,
)
async def submit_dictionary_lookup(
    child_id: str,
    instruction: str = Form(""),
    regions_json: str = Form("[]"),
    annotated_file: UploadFile | None = File(default=None),
    image_file: UploadFile | None = File(default=None),
    mask_file: UploadFile | None = File(default=None),
    db: AsyncSession = Depends(get_db_session),
) -> AsyncJobOut:
    child = await db.get(ChildModel, child_id)
    if not child:
        raise HTTPException(status_code=404, detail="儿童档案不存在")

    annotated_bytes = await annotated_file.read() if annotated_file is not None else b""
    raw_img_bytes = await image_file.read() if image_file is not None else b""
    mask_png_bytes = await mask_file.read() if mask_file is not None else b""

    if not annotated_bytes and not raw_img_bytes:
        raise HTTPException(status_code=400, detail="请先上传照片并画框或涂色标记要查的字词")

    boxes_1000 = parse_regions_1000(regions_json)
    if not boxes_1000 and mask_png_bytes:
        boxes_1000 = extract_mask_boxes_1000(mask_png_bytes)

    if annotated_bytes:
        preview_jpeg, _, _ = normalize_homework_image(annotated_bytes, max_edge=1600)
        if raw_img_bytes:
            norm_jpeg, _, _ = normalize_homework_image(raw_img_bytes, max_edge=1600)
        else:
            norm_jpeg = preview_jpeg
    else:
        if not boxes_1000:
            raise HTTPException(status_code=400, detail="还没有画框或涂抹任何字词哦")
        norm_jpeg, _, _ = normalize_homework_image(raw_img_bytes, max_edge=1600)
        preview_jpeg = (
            render_highlighted_preview_jpeg(norm_jpeg, mask_png_bytes, boxes_1000)
            if mask_png_bytes
            else norm_jpeg
        )

    lookup_id = f"dict-{uuid.uuid4().hex[:12]}"
    raw_key = f"dictionary-raw/{child_id}/{lookup_id}.jpg"
    preview_key = f"dictionary-preview/{child_id}/{lookup_id}.jpg"
    await asyncio.gather(
        minio_gateway.put_bytes(raw_key, norm_jpeg, "image/jpeg"),
        minio_gateway.put_bytes(preview_key, preview_jpeg, "image/jpeg"),
    )

    region_count = max(1, len(boxes_1000))
    job_id = f"job-dict-{uuid.uuid4().hex[:10]}"
    job = AsyncJobModel(
        id=job_id,
        child_id=child_id,
        task_id=lookup_id,
        job_type="dictionary_lookup",
        status="queued",
        progress_text=f"已生成 {region_count} 处标记像素图，正在交由 DeepSeek-V4.1-Flash 解析...",
        created_at=utc_now_iso(),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    log_event(
        "dictionary.lookup_queued",
        f"提交多模态涂色/画框查字典 ({region_count} 处区域)",
        jobId=job_id,
        lookupId=lookup_id,
        childId=child_id,
        regionCount=region_count,
        pixelBaked=bool(annotated_bytes),
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
