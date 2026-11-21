from io import BytesIO
import os
from pathlib import Path
import subprocess
import tempfile
import time
import httpx
from PIL import Image, ImageDraw, ImageFont
import pytest
from app.config import settings

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url
TEST_DATE_A = "2026-11-25"
TEST_DATE_B = "2026-11-26"


def load_font(size: int):
    for p in [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def render_sheet(lines: list[tuple[str, str]]) -> bytes:
    img = Image.new("RGB", (1500, 1050), "#FFFEF9")
    draw = ImageDraw.Draw(img)
    draw.rectangle([45, 45, 1455, 1005], outline="#4A2B44", width=4)
    y = 100
    for idx, (txt, color) in enumerate(lines):
        f = load_font(44 if idx == 0 else 38)
        draw.text((90, y), txt, fill=color, font=f)
        y += 120
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def transcode_wav_to(wav_bytes: bytes, ext: str, codec_args: list[str]) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        in_wav = Path(tmp) / "src.wav"
        out_file = Path(tmp) / f"encoded{ext}"
        in_wav.write_bytes(wav_bytes)
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", str(in_wav), *codec_args, str(out_file)],
            capture_output=True,
            check=False,
        )
        assert proc.returncode == 0 and out_file.exists(), proc.stderr.decode("utf-8", "ignore")
        return out_file.read_bytes()


def make_client(timeout_sec: float = 240.0) -> httpx.Client:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    return httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=timeout_sec)


def wait_job(client: httpx.Client, job_id: str, timeout_sec: float = 240.0) -> dict:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        try:
            job = client.get(f"/api/v1/jobs/{job_id}").raise_for_status().json()
        except httpx.TransportError:
            time.sleep(2.0)
            continue
        if job["status"] == "succeeded":
            return job
        if job["status"] == "failed":
            pytest.fail(f"Job {job_id} failed: {job.get('errorDetail')}")
        time.sleep(2.0)
    pytest.fail(f"Job {job_id} timed out")


def test_non_wav_m4a_and_webm_ffmpeg_transcode_asr() -> None:
    with make_client(120.0) as client:
        child = client.get("/api/v1/children").raise_for_status().json()[0]
        cid = child["id"]

        tts = client.post(
            "/api/v1/tts/speak",
            data={"text": "晚上七点半用正计时自由阅读昆虫记二十分钟"},
        ).raise_for_status().json()
        wav_bytes = client.get(tts["audioUrl"]).raise_for_status().content

        m4a_bytes = transcode_wav_to(wav_bytes, ".m4a", ["-c:a", "aac", "-b:a", "64k"])
        assert m4a_bytes[:4] != b"RIFF"
        asr_m4a = client.post(
            "/api/v1/asr/transcribe",
            data={"child_id": cid},
            files={"file": ("ipad_safari_recording.m4a", m4a_bytes, "audio/mp4")},
        ).raise_for_status().json()
        assert "阅读" in asr_m4a["transcript"] or "昆虫" in asr_m4a["transcript"]
        saved_m4a_wav = client.get(asr_m4a["audioUrl"]).raise_for_status().content
        assert saved_m4a_wav[:4] == b"RIFF"

        webm_bytes = transcode_wav_to(wav_bytes, ".webm", ["-c:a", "libopus", "-b:a", "48k"])
        assert webm_bytes[:4] != b"RIFF"
        asr_webm = client.post(
            "/api/v1/asr/transcribe",
            data={"child_id": cid},
            files={"file": ("android_chrome_recording.webm", webm_bytes, "audio/webm")},
        ).raise_for_status().json()
        assert "阅读" in asr_webm["transcript"] or "昆虫" in asr_webm["transcript"]


def test_stopwatch_f5_recovery_supplement_upload_and_tomorrow_tips_pipeline() -> None:
    created_ids: list[str] = []
    client = make_client(240.0)
    try:
        cid = client.get("/api/v1/children").raise_for_status().json()[0]["id"]
        for d_str in [TEST_DATE_A, TEST_DATE_B]:
            for old in client.get(f"/api/v1/children/{cid}/timeline", params={"date": d_str}).json():
                client.delete(f"/api/v1/tasks/{old['id']}", params={"actor": "parent"})

        created = client.post(
            f"/api/v1/children/{cid}/tasks/batch",
            json={
                "targetDate": TEST_DATE_A,
                "rawTranscript": "晚上七点用正计时做阅读摘抄与词汇练习十五分钟",
                "drafts": [
                    {
                        "draftId": "sw-1",
                        "title": "课外阅读好词摘抄练习",
                        "plannedStartTime": "19:00",
                        "timerMode": "stopwatch",
                        "plannedDurationMinutes": 15,
                        "subject": "reading",
                        "categoryTags": ["自主阅读", "好词摘抄"],
                        "difficulty": 2,
                        "rewardStars": 30,
                        "scoringRubric": {"focus": 30, "completeness": 30, "accuracy": 40},
                        "scoreHint": "星星正计时专注阅读摘抄可得满分100分",
                    }
                ],
            },
        ).raise_for_status().json()
        task = created[0]
        created_ids.append(task["id"])
        assert task["timerMode"] == "stopwatch"

        client.post(f"/api/v1/tasks/{task['id']}/timer/start").raise_for_status()
        time.sleep(2.3)

        recovered_tl = client.get(
            f"/api/v1/children/{cid}/timeline",
            params={"date": TEST_DATE_A},
        ).raise_for_status().json()
        recovered_task = next(x for x in recovered_tl if x["id"] == task["id"])
        assert recovered_task["status"] == "in_progress"
        assert recovered_task["timerLocked"] is True
        assert recovered_task["actualDurationSec"] >= 2

        p1 = render_sheet(
            [
                ("四年级阅读摘抄本（第1页） 姓名：星莓同学", "#332230"),
                ("好词积累：波光粼粼、漫天繁星、聚精会神", "#1E3A8A"),
                ("仿写句子：夏夜的星空像缀满宝石的丝绒毯。", "#1E3A8A"),
            ]
        )
        client.post(
            f"/api/v1/tasks/{task['id']}/images/upload",
            data={"upload_kind": "initial"},
            files=[("files", ("reading_p1.jpg", p1, "image/jpeg"))],
        ).raise_for_status()

        j1 = client.post(
            f"/api/v1/tasks/{task['id']}/submit",
            json={"uploadKind": "initial", "summaryVoiceText": "我摘抄了三个四字词语和一个比喻句"},
        ).raise_for_status().json()
        wait_job(client, j1["id"])

        tl_after_init = client.get(
            f"/api/v1/children/{cid}/timeline",
            params={"date": TEST_DATE_A},
        ).raise_for_status().json()
        done_init = next(x for x in tl_after_init if x["id"] == task["id"])
        assert done_init["status"] == "completed"
        assert done_init["revisionCount"] == 0
        p1_ocr_ts = done_init["images"][0]["ocrProcessedAt"]
        assert p1_ocr_ts is not None

        p2_supp = render_sheet(
            [
                ("四年级阅读摘抄本（第2页补拍） 姓名：星莓同学", "#332230"),
                ("读后感想：小蜘蛛夏洛用智慧和真诚守护了朋友威尔伯。", "#15803D"),
            ]
        )
        client.post(
            f"/api/v1/tasks/{task['id']}/images/upload",
            data={"upload_kind": "supplement"},
            files=[("files", ("reading_p2_supp.jpg", p2_supp, "image/jpeg"))],
        ).raise_for_status()

        j2 = client.post(
            f"/api/v1/tasks/{task['id']}/submit",
            json={"uploadKind": "supplement", "summaryVoiceText": "刚才漏拍了第2页读后感，现在补传上来啦"},
        ).raise_for_status().json()
        wait_job(client, j2["id"])

        tl_after_supp = client.get(
            f"/api/v1/children/{cid}/timeline",
            params={"date": TEST_DATE_A},
        ).raise_for_status().json()
        done_supp = next(x for x in tl_after_supp if x["id"] == task["id"])
        assert len(done_supp["images"]) == 2
        assert done_supp["images"][0]["ocrProcessedAt"] == p1_ocr_ts
        assert done_supp["images"][1]["ocrStatus"] == "done"
        assert done_supp["revisionCount"] == 0

        ev_job = client.post(
            f"/api/v1/children/{cid}/evaluations/{TEST_DATE_A}/generate"
        ).raise_for_status().json()
        wait_job(client, ev_job["id"])
        ev = client.get(f"/api/v1/children/{cid}/evaluations/{TEST_DATE_A}").raise_for_status().json()
        assert len(ev["tomorrowTips"]) >= 1

        parsed_tomorrow = client.post(
            f"/api/v1/children/{cid}/tasks/voice-parse",
            json={
                "transcript": "，".join(ev["tomorrowTips"]),
                "targetDate": TEST_DATE_B,
            },
        ).raise_for_status().json()
        assert len(parsed_tomorrow["drafts"]) >= 1

        tomorrow_created = client.post(
            f"/api/v1/children/{cid}/tasks/batch",
            json={
                "targetDate": TEST_DATE_B,
                "rawTranscript": "；".join(ev["tomorrowTips"]),
                "drafts": parsed_tomorrow["drafts"],
            },
        ).raise_for_status().json()
        assert len(tomorrow_created) >= 1
        created_ids.extend(x["id"] for x in tomorrow_created)

    finally:
        client.close()
        with make_client(60.0) as cleanup_client:
            for tid in created_ids:
                resp = cleanup_client.delete(f"/api/v1/tasks/{tid}", params={"actor": "parent"})
                assert resp.status_code in (200, 404), resp.text
