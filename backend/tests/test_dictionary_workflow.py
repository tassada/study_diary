from io import BytesIO
import json
import os
from pathlib import Path
import time
import httpx
from PIL import Image, ImageDraw, ImageFont
import pytest
from app.config import settings
from app.services.dictionary_service import clean_headword_for_tts, extract_mask_boxes_1000

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


def wav_duration_seconds(wav_bytes: bytes) -> float:
    assert wav_bytes[:4] == b"RIFF" and wav_bytes[8:12] == b"WAVE"
    byte_rate = int.from_bytes(wav_bytes[28:32], "little")
    assert byte_rate > 0
    return max(0.0, (len(wav_bytes) - 44) / byte_rate)


def test_clean_headword_and_mask_extraction_unit() -> None:
    assert clean_headword_for_tts("magnificent /mæɡˈnɪfɪsnt/ (adj. 壮丽的)") == "magnificent"
    assert clean_headword_for_tts("瞻仰（zhān yǎng）；仰望") == "瞻仰"

    mask = Image.new("RGBA", (1200, 800), (0, 0, 0, 0))
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([180, 120, 320, 175], radius=12, fill=(255, 61, 139, 255))
    draw.rounded_rectangle([420, 360, 680, 415], radius=12, fill=(255, 61, 139, 255))
    buf = BytesIO()
    mask.save(buf, format="PNG")
    boxes = extract_mask_boxes_1000(buf.getvalue())
    assert len(boxes) == 2
    assert boxes[0][1] < boxes[1][1]


def test_live_dictionary_multiword_bilingual_guess_and_unrecognized() -> None:
    w, h = 1500, 1050
    page = Image.new("RGB", (w, h), "#FFFEF9")
    pdraw = ImageDraw.Draw(page)
    pdraw.rectangle([40, 40, w - 40, h - 40], outline="#4A2B44", width=4)

    font = load_font(44)
    mask = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    mdraw = ImageDraw.Draw(mask)

    line1_prefix = "1. 同学们怀着崇敬的心情"
    line1_target = "瞻仰"
    line1_suffix = "人民英雄纪念碑。"
    y1 = 130
    pdraw.text((90, y1), line1_prefix + line1_target + line1_suffix, fill="#222222", font=font)
    x1_start = 90 + int(pdraw.textlength(line1_prefix, font=font))
    x1_end = x1_start + int(pdraw.textlength(line1_target, font=font))
    mdraw.rounded_rectangle([x1_start - 4, y1 - 4, x1_end + 4, y1 + 52], radius=14, fill=(255, 61, 139, 255))

    line2_prefix = "2. The ancient palace looks "
    line2_target = "magnificent"
    line2_suffix = " today."
    y2 = 300
    pdraw.text((90, y2), line2_prefix + line2_target + line2_suffix, fill="#1E3A8A", font=font)
    x2_start = 90 + int(pdraw.textlength(line2_prefix, font=font))
    x2_end = x2_start + int(pdraw.textlength(line2_target, font=font))
    mdraw.rounded_rectangle([x2_start - 4, y2 - 4, x2_end + 4, y2 + 52], radius=14, fill=(255, 61, 139, 255))

    line3_prefix = "3. Please look up the word in a "
    line3_painted_half = "diction"
    line3_unpainted_tail = "ary carefully."
    y3 = 470
    pdraw.text(
        (90, y3),
        line3_prefix + line3_painted_half + line3_unpainted_tail,
        fill="#15803D",
        font=font,
    )
    x3_start = 90 + int(pdraw.textlength(line3_prefix, font=font))
    x3_end = x3_start + int(pdraw.textlength(line3_painted_half, font=font))
    mdraw.rounded_rectangle([x3_start - 2, y3 - 4, x3_end, y3 + 52], radius=14, fill=(255, 61, 139, 255))

    mdraw.rounded_rectangle([1120, 790, 1340, 860], radius=18, fill=(255, 61, 139, 255))

    img_buf = BytesIO()
    page.save(img_buf, format="JPEG", quality=92)
    mask_buf = BytesIO()
    mask.save(mask_buf, format="PNG")

    lookup_id_to_clean: str | None = None
    with make_client(240.0) as client:
        try:
            cid = client.get("/api/v1/children").raise_for_status().json()[0]["id"]
            job = client.post(
                f"/api/v1/children/{cid}/dictionary/lookup",
                data={"instruction": "查出涂抹的字词，给出中英双解、笔画和音标"},
                files={
                    "image_file": ("book_page.jpg", img_buf.getvalue(), "image/jpeg"),
                    "mask_file": ("mask.png", mask_buf.getvalue(), "image/png"),
                },
            ).raise_for_status().json()

            deadline = time.monotonic() + 240.0
            finished_job = None
            while time.monotonic() < deadline:
                cur = client.get(f"/api/v1/jobs/{job['id']}").raise_for_status().json()
                if cur["status"] == "succeeded":
                    finished_job = cur
                    break
                if cur["status"] == "failed":
                    pytest.fail(f"Dictionary job failed: {cur.get('errorDetail')}")
                time.sleep(2.0)

            assert finished_job is not None
            lookup_id = finished_job["taskId"]
            lookup_id_to_clean = lookup_id

            detail = client.get(f"/api/v1/dictionary/lookups/{lookup_id}").raise_for_status().json()
            entries = detail["entries"]
            assert len(entries) >= 4

            zh_entry = next(
                (e for e in entries if not e["unrecognized"] and "瞻仰" in (e["chineseWord"] + e["headword"])),
                None,
            )
            assert zh_entry is not None, json.dumps(entries, ensure_ascii=False)
            assert zh_entry["pinyin"] != ""
            assert len(zh_entry["charStrokes"]) >= 1
            assert zh_entry["charStrokes"][0]["totalStrokes"] >= 10
            assert len(zh_entry["senses"]) >= 1
            assert len(zh_entry["synonyms"]) >= 1
            assert zh_entry["englishWord"] != ""
            assert zh_entry["ipa"] != ""

            en_entry = next(
                (
                    e
                    for e in entries
                    if not e["unrecognized"] and "magnificent" in (e["englishWord"] + e["headword"]).lower()
                ),
                None,
            )
            assert en_entry is not None, json.dumps(entries, ensure_ascii=False)
            assert en_entry["ipa"] != ""
            assert en_entry["chineseWord"] != ""
            assert len(en_entry["senses"]) >= 1

            guess_entry = next(
                (
                    e
                    for e in entries
                    if not e["unrecognized"] and "dictionary" in (e["englishWord"] + e["headword"]).lower()
                ),
                None,
            )
            assert guess_entry is not None, json.dumps(entries, ensure_ascii=False)
            assert guess_entry["guessedCorrection"] is True

            blank_entry = next((e for e in entries if e["unrecognized"] is True), None)
            assert blank_entry is not None, json.dumps(entries, ensure_ascii=False)
            assert blank_entry["unrecognizedReason"]

            assert en_entry["englishAudioUrl"] is None
            assert zh_entry["chineseAudioUrl"] is None

            en_pron = client.post(
                "/api/v1/dictionary/pronounce",
                data={"word": en_entry["englishWord"]},
            ).raise_for_status().json()
            en_wav = client.get(en_pron["audioUrl"]).raise_for_status().content
            en_dur = wav_duration_seconds(en_wav)
            assert 0.2 <= en_dur <= 4.0, f"Expected word-only audio, got {en_dur:.2f}s"

            zh_pron = client.post(
                "/api/v1/dictionary/pronounce",
                data={"word": zh_entry["chineseWord"]},
            ).raise_for_status().json()
            zh_wav = client.get(zh_pron["audioUrl"]).raise_for_status().content
            zh_dur = wav_duration_seconds(zh_wav)
            assert 0.2 <= zh_dur <= 4.0, f"Expected word-only audio, got {zh_dur:.2f}s"
        finally:
            if lookup_id_to_clean:
                client.delete(f"/api/v1/dictionary/lookups/{lookup_id_to_clean}")
