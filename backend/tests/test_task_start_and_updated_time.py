from datetime import datetime, timedelta, timezone
import os
import re
import time
import httpx
from app.config import settings

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url
CN_TZ = timezone(timedelta(hours=8))


def make_client() -> httpx.Client:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    return httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=30.0)


def test_task_schedule_uses_click_start_and_tracks_only_updated_at() -> None:
    auth_headers = {"Authorization": f"Bearer {settings.admin_token}"}
    temp_child_id: str | None = None
    test_date = "2099-12-29"

    with make_client() as client:
        try:
            created_child = client.post(
                "/api/v1/admin/children",
                headers=auth_headers,
                json={
                    "displayName": "排期计时验证号",
                    "birthDate": "2017-09-01",
                    "gender": "女",
                    "age": 9,
                    "gradeLabel": "小学四年级",
                    "dailyGoalMinutes": 60,
                },
            ).raise_for_status().json()
            temp_child_id = created_child["id"]

            created_tasks = client.post(
                f"/api/v1/children/{temp_child_id}/tasks/batch",
                json={
                    "targetDate": test_date,
                    "rawTranscript": "语文生字练习和数学计算练习",
                    "drafts": [
                        {
                            "draftId": "d-1",
                            "title": "语文生字默写",
                            "plannedStartTime": "16:30",
                            "timerMode": "countdown",
                            "plannedDurationMinutes": 20,
                            "subject": "chinese",
                            "categoryTags": ["生字默写"],
                            "difficulty": 2,
                            "rewardStars": 30,
                            "scoringRubric": {"focus": 30, "completeness": 30, "accuracy": 40},
                            "scoreHint": "独立100分制",
                        },
                        {
                            "draftId": "d-2",
                            "title": "数学竖式闯关",
                            "timerMode": "stopwatch",
                            "plannedDurationMinutes": 25,
                            "subject": "math",
                            "categoryTags": ["竖式计算"],
                            "difficulty": 2,
                            "rewardStars": 30,
                            "scoringRubric": {"focus": 30, "completeness": 30, "accuracy": 40},
                            "scoreHint": "独立100分制",
                        },
                    ],
                },
            ).raise_for_status().json()

            assert len(created_tasks) == 2
            t1, t2 = created_tasks[0], created_tasks[1]
            assert t1["plannedStartTime"] == ""
            assert t2["plannedStartTime"] == ""
            assert "completedAt" not in t1
            assert t1["updatedAt"] != ""
            assert t2["updatedAt"] != ""

            time.sleep(0.05)
            started_t2 = client.post(f"/api/v1/tasks/{t2['id']}/timer/start").raise_for_status().json()
            first_click_hhmm = started_t2["plannedStartTime"]
            assert re.fullmatch(r"\d{2}:\d{2}", first_click_hhmm) is not None

            now_cn = datetime.now(CN_TZ)
            valid_hhmms = {
                (now_cn - timedelta(minutes=1)).strftime("%H:%M"),
                now_cn.strftime("%H:%M"),
                (now_cn + timedelta(minutes=1)).strftime("%H:%M"),
            }
            assert first_click_hhmm in valid_hhmms
            assert started_t2["updatedAt"] > t2["updatedAt"]

            timeline = client.get(
                f"/api/v1/children/{temp_child_id}/timeline",
                params={"date": test_date},
            ).raise_for_status().json()
            assert [row["id"] for row in timeline] == [t2["id"], t1["id"]]
            assert timeline[0]["plannedStartTime"] == first_click_hhmm
            assert timeline[1]["plannedStartTime"] == ""

            time.sleep(0.05)
            paused_t2 = client.post(f"/api/v1/tasks/{t2['id']}/timer/pause").raise_for_status().json()
            assert paused_t2["plannedStartTime"] == first_click_hhmm
            assert paused_t2["updatedAt"] > started_t2["updatedAt"]

            time.sleep(0.05)
            resumed_t2 = client.post(f"/api/v1/tasks/{t2['id']}/timer/start").raise_for_status().json()
            assert resumed_t2["plannedStartTime"] == first_click_hhmm
            assert resumed_t2["updatedAt"] > paused_t2["updatedAt"]

            att_report = client.get(
                f"/api/v1/parent/attention/{temp_child_id}/daily",
                params={"date": test_date},
            ).raise_for_status().json()
            assert [row["taskId"] for row in att_report["tasks"]] == [t2["id"], t1["id"]]
            assert att_report["tasks"][0]["plannedStartTime"] == first_click_hhmm
            assert att_report["tasks"][0]["updatedAt"] == resumed_t2["updatedAt"]
        finally:
            if temp_child_id:
                client.delete(
                    f"/api/v1/admin/children/{temp_child_id}",
                    headers=auth_headers,
                )
