from io import BytesIO
import json
import os
from pathlib import Path
import time
import httpx
from PIL import Image, ImageDraw, ImageFont
import pytest
from app.config import settings
from app.services.dictionary_service import (
    clean_headword_for_tts,
    extract_mask_boxes_1000,
    parse_regions_1000,
)

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url


def load_font(size: int):
    for p in [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def make_client(timeout_sec: float = 240.0) -> httpx.Client:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    return httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=timeout_sec)


def to_box_1000(px_box: list[int], w: int, h: int) -> list[int]:
    return [
        max(0, min(1000, round(px_box[0] * 1000 / w))),
        max(0, min(1000, round(px_box[1] * 1000 / h))),
        max(0, min(1000, round(px_box[2] * 1000 / w))),
        max(0, min(1000, round(px_box[3] * 1000 / h))),
    ]


def draw_pixel_badge(draw: ImageDraw.ImageDraw, idx: int, x: int, y: int) -> None:
    by = max(4, y - 26)
    draw.rectangle([x, by, x + 34, by + 24], fill=(225, 29, 72), outline=(255, 255, 255), width=2)
    draw.text((x + 6, by + 4), f"#{idx}", fill=(255, 255, 255))


def wait_for_job(client: httpx.Client, job_id: str, timeout_sec: float = 180.0) -> dict:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        cur = client.get(f"/api/v1/jobs/{job_id}").raise_for_status().json()
        if cur["status"] == "succeeded":
            return cur
        if cur["status"] == "failed":
            pytest.fail(f"Job {job_id} failed: {cur.get('errorDetail')}")
        time.sleep(1.5)
    pytest.fail(f"Job {job_id} timed out after {timeout_sec}s")


def test_clean_headword_and_regions_unit() -> None:
    assert clean_headword_for_tts("magnificent /mæɡˈnɪfɪsnt/ (adj. 壮丽的)") == "magnificent"
    assert clean_headword_for_tts("瞻仰（zhān yǎng）；仰望") == "瞻仰"

    parsed = parse_regions_1000('[[120, 80, 260, 140], {"x1": 300, "y1": 400, "x2": 720, "y2": 480}]')
    assert parsed == [[120, 80, 260, 140], [300, 400, 720, 480]]

    mask = Image.new("RGBA", (1200, 800), (0, 0, 0, 0))
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([180, 120, 320, 175], radius=12, fill=(255, 230, 0, 255))
    draw.rounded_rectangle([420, 360, 680, 415], radius=12, fill=(255, 230, 0, 255))
    buf = BytesIO()
    mask.save(buf, format="PNG")
    boxes = extract_mask_boxes_1000(buf.getvalue())
    assert len(boxes) == 2
    assert boxes[0][1] < boxes[1][1]


def test_live_dictionary_pixel_baked_box_and_brush_modes() -> None:
    auth_headers = {"Authorization": f"Bearer {settings.admin_token}"}
    temp_child_id: str | None = None

    with make_client(240.0) as client:
        created = client.post(
            "/api/v1/admin/children",
            headers=auth_headers,
            json={
                "displayName": "字典自动测试生",
                "birthDate": "2017-09-01",
                "gender": "女",
                "age": 9,
                "gradeLabel": "小学三年级",
                "dailyGoalMinutes": 60,
            },
        ).raise_for_status().json()
        temp_child_id = created["id"]

        try:
            w, h = 1400, 900
            font_en = load_font(42)
            font_zh = load_font(48)

            raw_box_page = Image.new("RGB", (w, h), "#FFFEF9")
            rdraw = ImageDraw.Draw(raw_box_page)
            rdraw.rectangle([36, 36, w - 36, h - 36], outline="#4A2B44", width=3)

            rdraw.text((90, 110), "Choose the word from the box that completes each sentence:", fill="#222222", font=font_en)
            bank_y = 185
            w1_prefix = "   "
            w1_target = "decide"
            w1_neighbors = "    listen    opens    talks"
            rdraw.text((90, bank_y), w1_prefix + w1_target + w1_neighbors, fill="#1E3A8A", font=font_en)
            bx1 = 90 + int(rdraw.textlength(w1_prefix, font=font_en)) - 6
            bx2 = bx1 + int(rdraw.textlength(w1_target, font=font_en)) + 12
            box1_px = [bx1, bank_y - 6, bx2, bank_y + 52]

            sent_y = 430
            sent_text = "Anna was ready to paint her own pysanky egg."
            rdraw.text((90, sent_y), sent_text, fill="#1F2937", font=font_en)
            sx2 = 90 + int(rdraw.textlength(sent_text, font=font_en)) + 10
            box2_px = [82, sent_y - 8, sx2, sent_y + 54]

            annotated_box_page = raw_box_page.convert("RGBA")
            tint_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            tdraw = ImageDraw.Draw(tint_layer)
            for bpx in (box1_px, box2_px):
                tdraw.rectangle(bpx, fill=(255, 230, 0, 38), outline=(225, 29, 72, 255), width=5)
            annotated_box_rgb = Image.alpha_composite(annotated_box_page, tint_layer).convert("RGB")
            adraw = ImageDraw.Draw(annotated_box_rgb)
            draw_pixel_badge(adraw, 1, box1_px[0], box1_px[1])
            draw_pixel_badge(adraw, 2, box2_px[0], box2_px[1])

            raw_box_buf = BytesIO()
            raw_box_page.save(raw_box_buf, format="JPEG", quality=90)
            ann_box_buf = BytesIO()
            annotated_box_rgb.save(ann_box_buf, format="JPEG", quality=90)

            box_regions_1000 = [to_box_1000(box1_px, w, h), to_box_1000(box2_px, w, h)]
            box_job = client.post(
                f"/api/v1/children/{temp_child_id}/dictionary/lookup",
                data={
                    "instruction": "请精准解析框出的单词与整句",
                    "regions_json": json.dumps(box_regions_1000),
                },
                files={
                    "image_file": ("raw_box.jpg", raw_box_buf.getvalue(), "image/jpeg"),
                    "annotated_file": ("annotated_box.jpg", ann_box_buf.getvalue(), "image/jpeg"),
                },
            ).raise_for_status().json()

            done_box_job = wait_for_job(client, box_job["id"])
            box_detail = client.get(
                f"/api/v1/dictionary/lookups/{done_box_job['taskId']}"
            ).raise_for_status().json()
            box_entries = box_detail["entries"]
            assert len(box_entries) == 2, json.dumps(box_entries, ensure_ascii=False)

            e_decide = box_entries[0]
            assert e_decide["unrecognized"] is False
            assert e_decide["headword"].strip().lower() == "decide", json.dumps(e_decide, ensure_ascii=False)
            assert "listen" not in e_decide["headword"].lower()
            assert "completes" not in e_decide["headword"].lower()
            assert e_decide["guessedCorrection"] is False
            assert e_decide["ipa"] != ""
            assert e_decide["chineseWord"] != ""
            assert e_decide["englishAudioUrl"] is None

            e_sent = box_entries[1]
            assert e_sent["unrecognized"] is False
            assert "pysanky" in (e_sent["headword"] + e_sent["englishWord"]).lower()
            combined_zh = e_sent["chineseWord"] + " ".join(s["zhMeaning"] for s in e_sent["senses"])
            assert ("安娜" in combined_zh or "Anna" in combined_zh) and ("彩蛋" in combined_zh or "蛋" in combined_zh)

            raw_brush_page = Image.new("RGB", (w, h), "#FFFDF8")
            bdraw = ImageDraw.Draw(raw_brush_page)
            bdraw.rectangle([70, 80, 920, 310], fill="#1E293B", outline="#0F172A", width=3)
            poster_line1 = "新店预告"
            poster_line2 = "九眼桥新店装修中，敬请期待试营业"
            bdraw.text((130, 115), poster_line1, fill="#FFFFFF", font=font_zh)
            bdraw.text((130, 198), poster_line2, fill="#CBD5E1", font=load_font(36))
            p1_end = 130 + int(bdraw.textlength(poster_line1, font=font_zh))
            stroke1_px = [124, 112, p1_end + 6, 170]

            line_partial_prefix = "Please look up the word in a "
            line_partial_painted = "diction"
            line_partial_rest = "ary carefully."
            py = 470
            bdraw.text(
                (90, py),
                line_partial_prefix + line_partial_painted + line_partial_rest,
                fill="#14532D",
                font=font_en,
            )
            px_start = 90 + int(bdraw.textlength(line_partial_prefix, font=font_en))
            px_end = px_start + int(bdraw.textlength(line_partial_painted, font=font_en))
            stroke2_px = [px_start - 2, py - 4, px_end, py + 48]

            ann_brush_rgba = raw_brush_page.convert("RGBA")
            hl_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            hdraw = ImageDraw.Draw(hl_layer)
            hdraw.rounded_rectangle(stroke1_px, radius=18, fill=(255, 230, 0, 118))
            hdraw.rounded_rectangle(stroke2_px, radius=16, fill=(255, 230, 0, 118))
            ann_brush_rgb = Image.alpha_composite(ann_brush_rgba, hl_layer).convert("RGB")
            ab_draw = ImageDraw.Draw(ann_brush_rgb)
            draw_pixel_badge(ab_draw, 1, stroke1_px[0], stroke1_px[1])
            draw_pixel_badge(ab_draw, 2, stroke2_px[0], stroke2_px[1])

            raw_brush_buf = BytesIO()
            raw_brush_page.save(raw_brush_buf, format="JPEG", quality=90)
            ann_brush_buf = BytesIO()
            ann_brush_rgb.save(ann_brush_buf, format="JPEG", quality=90)

            brush_regions_1000 = [to_box_1000(stroke1_px, w, h), to_box_1000(stroke2_px, w, h)]
            brush_job = client.post(
                f"/api/v1/children/{temp_child_id}/dictionary/lookup",
                data={
                    "instruction": "请只查荧光笔涂到的字词",
                    "regions_json": json.dumps(brush_regions_1000),
                },
                files={
                    "image_file": ("raw_brush.jpg", raw_brush_buf.getvalue(), "image/jpeg"),
                    "annotated_file": ("annotated_brush.jpg", ann_brush_buf.getvalue(), "image/jpeg"),
                },
            ).raise_for_status().json()

            done_brush_job = wait_for_job(client, brush_job["id"])
            brush_detail = client.get(
                f"/api/v1/dictionary/lookups/{done_brush_job['taskId']}"
            ).raise_for_status().json()
            brush_entries = brush_detail["entries"]
            assert len(brush_entries) == 2, json.dumps(brush_entries, ensure_ascii=False)

            e_poster = brush_entries[0]
            assert e_poster["unrecognized"] is False
            assert "新店预告" in (e_poster["headword"] + e_poster["chineseWord"]), json.dumps(
                e_poster, ensure_ascii=False
            )
            assert "装修" not in e_poster["headword"]
            assert "试营业" not in e_poster["headword"]
            assert e_poster["pinyin"] != ""
            assert len(e_poster["charStrokes"]) >= 1

            e_guess = brush_entries[1]
            assert e_guess["unrecognized"] is False
            assert "dictionary" in (e_guess["headword"] + e_guess["englishWord"]).lower(), json.dumps(
                e_guess, ensure_ascii=False
            )
            assert e_guess["guessedCorrection"] is True
        finally:
            if temp_child_id:
                client.delete(f"/api/v1/admin/children/{temp_child_id}", headers=auth_headers)
