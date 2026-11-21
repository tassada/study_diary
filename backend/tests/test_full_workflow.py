import asyncio
from datetime import datetime, timedelta, timezone
from io import BytesIO
import os
from pathlib import Path
import time
import httpx
from PIL import Image, ImageDraw, ImageFont
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.database import Base
from app.models import TaskModel
from app.services.timer_service import enforce_idle_auto_pause_for_child

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url
REMOTE_HTTP_CERT_URL = os.environ.get("STUDY_DIARY_TEST_CERT_URL", "")
TEST_DATE = "2026-11-22"


def load_cjk_font(size: int):
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def build_oversized_homework_jpeg(kind: str) -> bytes:
    if kind == "page1_mistake":
        img = Image.new("RGB", (2200, 1650), "#FFFEF9")
        draw = ImageDraw.Draw(img)
        draw.rectangle([60, 60, 2140, 1590], outline="#4A2B44", width=5)
        draw.text((120, 120), "四年级数学综合练习（第1页） 姓名：星莓同学", fill="#332230", font=load_cjk_font(48))
        draw.text((120, 290), "一、直接写出得数：", fill="#332230", font=load_cjk_font(40))
        draw.text((140, 390), "1) 125 × 8 = 1000     2) 450 ÷ 15 = 30", fill="#1E3A8A", font=load_cjk_font(40))
        draw.text((120, 540), "二、竖式与简便计算：", fill="#332230", font=load_cjk_font(40))
        draw.text((140, 650), "3) 48 × 25 = 1100  （进位漏加1）", fill="#B91C1C", font=load_cjk_font(42))
        draw.text((140, 790), "4) 24 × 15 = 360", fill="#1E3A8A", font=load_cjk_font(40))
    elif kind == "page2_word_problem":
        img = Image.new("RGB", (2000, 1500), "#FFFEF9")
        draw = ImageDraw.Draw(img)
        draw.rectangle([60, 60, 1940, 1440], outline="#4A2B44", width=5)
        draw.text((120, 120), "四年级数学综合练习（第2页） 姓名：星莓同学", fill="#332230", font=load_cjk_font(46))
        draw.text((120, 300), "三、解决问题：", fill="#332230", font=load_cjk_font(40))
        draw.text((120, 420), "5) 果园摘了16筐苹果，每筐重25千克，一共重多少千克？", fill="#332230", font=load_cjk_font(38))
        draw.text((150, 540), "解：16 × 25 = 400（千克） 答：一共重400千克。", fill="#1E3A8A", font=load_cjk_font(40))
    else:
        img = Image.new("RGB", (1800, 1300), "#FFFEF9")
        draw = ImageDraw.Draw(img)
        draw.rectangle([50, 50, 1750, 1250], outline="#15803D", width=5)
        draw.text((110, 110), "错题订正专页  姓名：星莓同学", fill="#166534", font=load_cjk_font(46))
        draw.text((110, 280), "订正第3题：48 × 25", fill="#332230", font=load_cjk_font(40))
        draw.text((110, 400), "正确解答：48 × 25 = 12 × (4 × 25) = 12 × 100 = 1200", fill="#15803D", font=load_cjk_font(40))
        draw.text((110, 530), "除法验算：1200 ÷ 25 = 48，已完全掌握进位规则！", fill="#15803D", font=load_cjk_font(40))

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def wait_for_async_job(client: httpx.Client, job_id: str, timeout_sec: float = 240.0) -> dict:
    deadline = time.monotonic() + timeout_sec
    observed_statuses: list[str] = []
    while time.monotonic() < deadline:
        resp = client.get(f"/api/v1/jobs/{job_id}")
        resp.raise_for_status()
        job = resp.json()
        if not observed_statuses or observed_statuses[-1] != job["status"]:
            observed_statuses.append(job["status"])
        if job["status"] == "succeeded":
            return job
        if job["status"] == "failed":
            pytest.fail(f"Async job {job_id} failed explicitly: {job.get('errorDetail')}")
        time.sleep(2.0)
    pytest.fail(f"Async job {job_id} timed out after {timeout_sec}s; statuses={observed_statuses}")


def test_idle_90_minute_auto_pause_unit_invariant(tmp_path: Path) -> None:
    async def _run() -> None:
        db_file = tmp_path / "idle_guard.db"
        test_engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}", future=True)
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
        stale_ts = (datetime.now(timezone.utc) - timedelta(seconds=5410)).isoformat()

        async with maker() as session:
            stale_task = TaskModel(
                id="task-idle-check",
                child_id="child_demo",
                task_date=TEST_DATE,
                title="防挂机熔断测试任务",
                planned_start_time="16:00",
                timer_mode="stopwatch",
                timer_locked=True,
                planned_duration_sec=1200,
                actual_duration_sec=300,
                pause_count=0,
                subject="math",
                status="in_progress",
                active_started_at=stale_ts,
                last_heartbeat_at=stale_ts,
            )
            session.add(stale_task)
            await session.commit()

            await enforce_idle_auto_pause_for_child(session, "child_demo")
            refreshed = await session.get(TaskModel, "task-idle-check")
            assert refreshed is not None
            assert refreshed.status == "paused"
            assert refreshed.pause_count == 1
            assert refreshed.active_started_at is None
            assert refreshed.auto_paused_reason is not None
            assert "90分钟" in refreshed.auto_paused_reason
            assert refreshed.actual_duration_sec == 300

        await test_engine.dispose()

    asyncio.run(_run())


def test_end_to_end_production_workflow() -> None:
    created_task_ids: list[str] = []
    client = httpx.Client(base_url=REMOTE_HTTPS_BASE, verify=False, timeout=240.0)

    try:
        health = client.get("/api/v1/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        if REMOTE_HTTP_CERT_URL:
            cert_resp = httpx.get(REMOTE_HTTP_CERT_URL, timeout=15.0)
            assert cert_resp.status_code == 200
            assert "BEGIN CERTIFICATE" in cert_resp.text

        children = client.get("/api/v1/children").raise_for_status().json()
        assert len(children) >= 1
        primary = children[0]
        child_id = primary["id"]
        assert primary["displayName"] == settings.default_child_name
        assert primary["birthDate"] == settings.default_child_birth_date
        assert primary["gender"] == settings.default_child_gender
        assert primary["age"] == settings.default_child_age
        assert primary["gradeLabel"] == settings.default_child_grade

        existing_test_day = client.get(
            f"/api/v1/children/{child_id}/timeline",
            params={"date": TEST_DATE},
        ).raise_for_status().json()
        for old_t in existing_test_day:
            client.delete(f"/api/v1/tasks/{old_t['id']}", params={"actor": "parent"})

        spoken_plan = "今天下午四点半先做四年级数学两位数乘两位数练习二十分钟，五点钟背英语第三课单词十五分钟"
        tts_out = client.post("/api/v1/tts/speak", data={"text": spoken_plan}).raise_for_status().json()
        tts_wav_resp = client.get(tts_out["audioUrl"]).raise_for_status()
        wav_bytes = tts_wav_resp.content
        assert wav_bytes[:4] == b"RIFF" and len(wav_bytes) > 8000

        asr_out = client.post(
            "/api/v1/asr/transcribe",
            data={"child_id": child_id},
            files={"file": ("voice_plan.wav", wav_bytes, "audio/wav")},
        ).raise_for_status().json()
        assert len(asr_out["transcript"]) >= 8
        assert asr_out["durationMs"] > 1000
        archived_asr = client.get(asr_out["audioUrl"]).raise_for_status()
        assert archived_asr.content[:4] == b"RIFF"

        parsed = client.post(
            f"/api/v1/children/{child_id}/tasks/voice-parse",
            json={"transcript": asr_out["transcript"], "targetDate": TEST_DATE},
        ).raise_for_status().json()
        assert len(parsed["drafts"]) >= 2
        assert parsed["ttsAudioUrl"] is None
        for d in parsed["drafts"]:
            rubric = d["scoringRubric"]
            assert rubric["focus"] + rubric["completeness"] + rubric["accuracy"] == 100
            assert 1 <= d["difficulty"] <= 3
            assert d["rewardStars"] > 0

        refined = client.post(
            f"/api/v1/children/{child_id}/tasks/voice-parse",
            json={
                "transcript": "把第一个数学任务改成二十五分钟，变成三星难度",
                "targetDate": TEST_DATE,
                "existingDrafts": parsed["drafts"],
                "isRefinement": True,
            },
        ).raise_for_status().json()
        assert refined["drafts"][0]["plannedDurationMinutes"] == 25
        assert refined["drafts"][0]["difficulty"] == 3

        extra_temp_draft = {
            **refined["drafts"][-1],
            "draftId": "temp-deletable",
            "title": "待删除未开始测试任务",
            "plannedStartTime": "20:30",
        }
        batch_created = client.post(
            f"/api/v1/children/{child_id}/tasks/batch",
            json={
                "targetDate": TEST_DATE,
                "rawTranscript": asr_out["transcript"],
                "voiceMinioKey": asr_out["audioMinioKey"],
                "drafts": [*refined["drafts"][:2], extra_temp_draft],
            },
        ).raise_for_status().json()
        assert len(batch_created) == 3
        created_task_ids.extend(t["id"] for t in batch_created)

        t_math, t_eng, t_temp = batch_created[0], batch_created[1], batch_created[2]

        del_pending = client.delete(f"/api/v1/tasks/{t_temp['id']}", params={"actor": "child"})
        assert del_pending.status_code == 200

        mode_sw1 = client.patch(
            f"/api/v1/tasks/{t_math['id']}/mode",
            json={"timerMode": "stopwatch"},
        )
        assert mode_sw1.status_code == 200 and mode_sw1.json()["timerMode"] == "stopwatch"
        mode_sw2 = client.patch(
            f"/api/v1/tasks/{t_math['id']}/mode",
            json={"timerMode": "countdown"},
        )
        assert mode_sw2.status_code == 200 and mode_sw2.json()["timerMode"] == "countdown"

        started = client.post(f"/api/v1/tasks/{t_math['id']}/timer/start").raise_for_status().json()
        assert started["status"] == "in_progress"
        assert started["timerLocked"] is True

        mutex_conflict = client.post(f"/api/v1/tasks/{t_eng['id']}/timer/start")
        assert mutex_conflict.status_code == 409

        locked_mode_conflict = client.patch(
            f"/api/v1/tasks/{t_math['id']}/mode",
            json={"timerMode": "stopwatch"},
        )
        assert locked_mode_conflict.status_code == 409

        kid_delete_forbidden = client.delete(
            f"/api/v1/tasks/{t_math['id']}",
            params={"actor": "child"},
        )
        assert kid_delete_forbidden.status_code == 403

        time.sleep(1.3)
        hb = client.post(f"/api/v1/tasks/{t_math['id']}/timer/heartbeat").raise_for_status().json()
        assert hb["status"] == "in_progress"

        paused1 = client.post(f"/api/v1/tasks/{t_math['id']}/timer/pause").raise_for_status().json()
        assert paused1["status"] == "paused"
        assert paused1["pauseCount"] == 1
        assert paused1["actualDurationSec"] >= 1

        resumed = client.post(f"/api/v1/tasks/{t_math['id']}/timer/start").raise_for_status().json()
        assert resumed["status"] == "in_progress"
        time.sleep(1.1)
        paused2 = client.post(f"/api/v1/tasks/{t_math['id']}/timer/pause").raise_for_status().json()
        assert paused2["pauseCount"] == 2
        assert paused2["actualDurationSec"] >= 2

        img1_raw = build_oversized_homework_jpeg("page1_mistake")
        img2_raw = build_oversized_homework_jpeg("page2_word_problem")
        uploaded_imgs = client.post(
            f"/api/v1/tasks/{t_math['id']}/images/upload",
            data={"upload_kind": "initial"},
            files=[
                ("files", ("math_p1.jpg", img1_raw, "image/jpeg")),
                ("files", ("math_p2.jpg", img2_raw, "image/jpeg")),
            ],
        ).raise_for_status().json()
        assert len(uploaded_imgs) == 2
        for uim in uploaded_imgs:
            assert uim["width"] <= 1600 and uim["height"] <= 1600
            assert uim["ocrStatus"] == "pending"
            img_fetch = client.get(uim["imageUrl"]).raise_for_status()
            assert img_fetch.headers["content-type"].startswith("image/jpeg")

        review_job_1 = client.post(
            f"/api/v1/tasks/{t_math['id']}/submit",
            json={
                "uploadKind": "initial",
                "summaryVoiceText": "两页数学题都做完了，第3题48乘25进位我有点拿不准",
            },
        ).raise_for_status().json()
        wait_for_async_job(client, review_job_1["id"])

        timeline_1 = client.get(
            f"/api/v1/children/{child_id}/timeline",
            params={"date": TEST_DATE},
        ).raise_for_status().json()
        math_done = next(x for x in timeline_1 if x["id"] == t_math["id"])
        assert math_done["status"] == "completed"
        assert math_done["initialScore"] is not None and 0 < math_done["initialScore"] <= 100
        assert math_done["earnedScore"] == math_done["initialScore"]
        assert math_done["praiseAudioUrl"] is None

        assert len(math_done["images"]) == 2
        ocr_ts_page1 = math_done["images"][0]["ocrProcessedAt"]
        ocr_ts_page2 = math_done["images"][1]["ocrProcessedAt"]
        assert math_done["images"][0]["ocrStatus"] == "done" and ocr_ts_page1 is not None
        assert math_done["images"][1]["ocrStatus"] == "done" and ocr_ts_page2 is not None
        assert "1100" in math_done["images"][0]["ocrPlainText"] or "48" in math_done["images"][0]["ocrPlainText"]

        assert len(math_done["mistakes"]) >= 1
        m0 = math_done["mistakes"][0]
        assert m0["masteryStatus"] == "open"
        assert m0["practiceQuestion"] != "" and m0["practiceAnswer"] != ""
        assert m0["diagramImageUrl"] is not None
        diag_resp = client.get(m0["diagramImageUrl"]).raise_for_status()
        assert "<svg" in diag_resp.text
        if m0["cropImageUrl"]:
            crop_resp = client.get(m0["cropImageUrl"]).raise_for_status()
            assert len(crop_resp.content) > 800
        assert m0["ttsAudioUrl"] is None
        on_demand_m = client.post(
            "/api/v1/tts/speak",
            data={"text": "", "bind_kind": "mistake_explain", "bind_id": m0["id"]},
        ).raise_for_status().json()
        tts_m_resp = client.get(on_demand_m["audioUrl"]).raise_for_status()
        assert tts_m_resp.content[:4] == b"RIFF"

        eval_job = client.post(
            f"/api/v1/children/{child_id}/evaluations/{TEST_DATE}/generate"
        ).raise_for_status().json()
        wait_for_async_job(client, eval_job["id"])

        daily_ev = client.get(
            f"/api/v1/children/{child_id}/evaluations/{TEST_DATE}"
        ).raise_for_status().json()
        assert daily_ev is not None
        dims = daily_ev["dimensionScores"]
        assert 0 <= dims["completion"] <= 30
        assert 0 <= dims["focus"] <= 25
        assert 0 <= dims["quality"] <= 30
        assert 0 <= dims["habit"] <= 15
        assert len(daily_ev["childCommentarySentences"]) >= 3
        assert daily_ev["ttsAudioUrl"] is None
        assert daily_ev["hasNewProgress"] is False

        cal_check = client.get(
            f"/api/v1/children/{child_id}/calendar",
            params={"start": "2026-11-01", "end": "2026-11-30"},
        ).raise_for_status().json()
        assert cal_check["days"][TEST_DATE]["evalScore"] == daily_ev["totalScore"]

        corr_raw = build_oversized_homework_jpeg("correction")
        up_corr = client.post(
            f"/api/v1/tasks/{t_math['id']}/images/upload",
            data={"upload_kind": "correction"},
            files=[("files", ("math_correction.jpg", corr_raw, "image/jpeg"))],
        ).raise_for_status().json()
        assert len(up_corr) == 1 and up_corr[0]["ocrStatus"] == "pending"

        review_job_2 = client.post(
            f"/api/v1/tasks/{t_math['id']}/submit",
            json={
                "uploadKind": "correction",
                "summaryVoiceText": "我把48乘25重新订正成1200并且用除法验算对啦！",
            },
        ).raise_for_status().json()
        wait_for_async_job(client, review_job_2["id"])

        timeline_2 = client.get(
            f"/api/v1/children/{child_id}/timeline",
            params={"date": TEST_DATE},
        ).raise_for_status().json()
        math_revised = next(x for x in timeline_2 if x["id"] == t_math["id"])
        assert len(math_revised["images"]) == 3
        assert math_revised["images"][0]["ocrProcessedAt"] == ocr_ts_page1
        assert math_revised["images"][1]["ocrProcessedAt"] == ocr_ts_page2
        assert math_revised["images"][2]["ocrStatus"] == "done"
        assert math_revised["images"][2]["ocrProcessedAt"] is not None
        assert "1200" in math_revised["images"][2]["ocrPlainText"]
        assert "text  " not in math_revised["images"][2]["ocrPlainText"]

        assert math_revised["revisionCount"] == 1
        assert math_revised["earnedScore"] > math_revised["initialScore"]
        assert any(m["masteryStatus"] == "mastered" for m in math_revised["mistakes"])

        daily_ev_after = client.get(
            f"/api/v1/children/{child_id}/evaluations/{TEST_DATE}"
        ).raise_for_status().json()
        assert daily_ev_after["hasNewProgress"] is True

        parent_list = client.get(f"/api/v1/parent/tasks/{child_id}").raise_for_status().json()
        assert any(x["id"] == t_math["id"] for x in parent_list)

    finally:
        for tid in created_task_ids:
            try:
                client.delete(f"/api/v1/tasks/{tid}", params={"actor": "parent"})
            except Exception:
                pass
        client.close()
