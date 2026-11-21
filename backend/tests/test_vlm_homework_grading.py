from io import BytesIO
import json
import os
from pathlib import Path
import time
import httpx
from PIL import Image, ImageDraw, ImageFont
import pytest
from app.config import settings
from app.services.dsh_supervisor import has_unfinished_cliffhanger

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


def test_live_vlm_sideways_worksheet_auto_upright_and_grading() -> None:
    auth_headers = {"Authorization": f"Bearer {settings.admin_token}"}
    temp_child_id: str | None = None

    upright = Image.new("RGB", (980, 1340), "#FFFEF9")
    draw = ImageDraw.Draw(upright)
    draw.rectangle([32, 32, 948, 1308], outline="#334155", width=4)
    title_font = load_font(44)
    item_font = load_font(38)
    hand_font = load_font(42)

    draw.text((220, 80), "三年级数学限时计算小练习", fill="#0F172A", font=title_font)
    draw.line([70, 155, 910, 155], fill="#94A3B8", width=2)

    draw.text((90, 240), "第1题： 24 × 5 = _______", fill="#1E293B", font=item_font)
    draw.text((435, 234), "120", fill="#1D4ED8", font=hand_font)

    draw.text((90, 430), "第2题： 100 - 38 = _______", fill="#1E293B", font=item_font)
    draw.text((460, 424), "62", fill="#1D4ED8", font=hand_font)

    draw.text((90, 620), "第3题： 45 + 27 = _______", fill="#1E293B", font=item_font)
    draw.text((450, 614), "62", fill="#DC2626", font=hand_font)
    draw.text((90, 690), "（竖式草稿：个位 5+7=12 写2，十位直接算成 4+2=6）", fill="#475569", font=load_font(28))

    sideways = upright.rotate(90, expand=True)
    assert sideways.width > sideways.height
    sideways_buf = BytesIO()
    sideways.save(sideways_buf, format="JPEG", quality=90)

    with make_client(240.0) as client:
        created_child = client.post(
            "/api/v1/admin/children",
            headers=auth_headers,
            json={
                "displayName": "试卷多模态测试生",
                "birthDate": "2017-10-12",
                "gender": "女",
                "age": 9,
                "gradeLabel": "小学三年级",
                "dailyGoalMinutes": 60,
            },
        ).raise_for_status().json()
        temp_child_id = created_child["id"]

        try:
            test_date = "2099-11-21"
            created_tasks = client.post(
                f"/api/v1/children/{temp_child_id}/tasks/batch",
                json={
                    "targetDate": test_date,
                    "rawTranscript": "三年级数学限时计算小练习",
                    "drafts": [
                        {
                            "draftId": "d-vlm-1",
                            "title": "三年级数学限时计算小练习",
                            "timerMode": "countdown",
                            "plannedDurationMinutes": 15,
                            "subject": "math",
                            "categoryTags": ["四则运算"],
                            "difficulty": 2,
                            "rewardStars": 20,
                            "scoringRubric": {"focus": 30, "completeness": 30, "accuracy": 40},
                            "scoreHint": "独立100分制",
                        }
                    ],
                },
            ).raise_for_status().json()
            task_id = created_tasks[0]["id"]

            client.post(f"/api/v1/tasks/{task_id}/timer/start").raise_for_status()
            client.post(
                f"/api/v1/tasks/{task_id}/images/upload",
                data={"upload_kind": "initial"},
                files=[("files", ("sideways_math.jpg", sideways_buf.getvalue(), "image/jpeg"))],
            ).raise_for_status()

            job = client.post(
                f"/api/v1/tasks/{task_id}/submit",
                json={
                    "uploadKind": "initial",
                    "summaryVoiceText": "老师我做完了三道计算题，请帮我批改",
                },
            ).raise_for_status().json()

            deadline = time.monotonic() + 180.0
            finished = None
            while time.monotonic() < deadline:
                cur = client.get(f"/api/v1/jobs/{job['id']}").raise_for_status().json()
                if cur["status"] == "succeeded":
                    finished = cur
                    break
                if cur["status"] == "failed":
                    pytest.fail(f"Homework VLM review failed: {cur.get('errorDetail')}")
                time.sleep(2.0)

            assert finished is not None

            tasks_after = client.get(
                f"/api/v1/children/{temp_child_id}/timeline",
                params={"date": test_date},
            ).raise_for_status().json()
            graded = next(t for t in tasks_after if t["id"] == task_id)

            assert graded["status"] == "completed"
            assert 50 <= graded["earnedScore"] <= 95
            assert graded["praiseAudioUrl"] is None
            assert has_unfinished_cliffhanger(graded["aiQuickPraise"] or "") is False

            assert len(graded["images"]) == 1
            img_info = graded["images"][0]
            assert img_info["width"] < img_info["height"], f"Expected upright width < height, got {img_info}"
            assert img_info["ocrStatus"] == "done"

            mistakes = graded["mistakes"]
            assert len(mistakes) >= 1, json.dumps(graded, ensure_ascii=False)
            combined_m = json.dumps(mistakes, ensure_ascii=False)
            assert "45" in combined_m and ("72" in combined_m or "进位" in combined_m)
            assert mistakes[0]["ttsAudioUrl"] is None
            if mistakes[0]["cropImageUrl"]:
                crop_resp = client.get(mistakes[0]["cropImageUrl"]).raise_for_status()
                assert len(crop_resp.content) > 1000
        finally:
            if temp_child_id:
                client.delete(f"/api/v1/admin/children/{temp_child_id}", headers=auth_headers)
