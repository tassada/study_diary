import os
import httpx
from app.config import settings

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url
TEST_DATE = "2099-12-30"


def make_client() -> httpx.Client:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    return httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=30.0)


def test_attention_segments_upsert_and_daily_report() -> None:
    task_id: str | None = None
    with make_client() as client:
        try:
            cid = client.get("/api/v1/children").raise_for_status().json()[0]["id"]
            created = client.post(
                f"/api/v1/children/{cid}/tasks/batch",
                json={
                    "targetDate": TEST_DATE,
                    "rawTranscript": "测试专注度分段上报",
                    "drafts": [
                        {
                            "draftId": "att-1",
                            "title": "专注度自动化巡检任务",
                            "plannedStartTime": "18:00",
                            "timerMode": "countdown",
                            "plannedDurationMinutes": 10,
                            "subject": "math",
                            "categoryTags": ["专注巡检"],
                            "difficulty": 2,
                            "rewardStars": 20,
                            "scoringRubric": {"focus": 30, "completeness": 30, "accuracy": 40},
                            "scoreHint": "测试",
                        }
                    ],
                },
            ).raise_for_status().json()
            task_id = created[0]["id"]

            res1 = client.post(
                f"/api/v1/tasks/{task_id}/attention-segments",
                json={
                    "segments": [
                        {
                            "segmentIndex": 0,
                            "startOffsetSec": 0,
                            "durationSec": 60,
                            "presentSec": 60,
                            "focusedSec": 50,
                            "distractedSec": 10,
                            "drowsySec": 0,
                            "nearPostureSec": 0,
                            "awaySec": 0,
                            "avgDistanceCm": 42,
                            "dominantState": "focused",
                        }
                    ]
                },
            ).raise_for_status().json()
            assert res1["savedCount"] == 1

            res2 = client.post(
                f"/api/v1/tasks/{task_id}/attention-segments",
                json={
                    "segments": [
                        {
                            "segmentIndex": 0,
                            "startOffsetSec": 0,
                            "durationSec": 60,
                            "presentSec": 60,
                            "focusedSec": 55,
                            "distractedSec": 5,
                            "drowsySec": 0,
                            "nearPostureSec": 0,
                            "awaySec": 0,
                            "avgDistanceCm": 44,
                            "dominantState": "focused",
                        },
                        {
                            "segmentIndex": 1,
                            "startOffsetSec": 60,
                            "durationSec": 60,
                            "presentSec": 30,
                            "focusedSec": 15,
                            "distractedSec": 10,
                            "drowsySec": 0,
                            "nearPostureSec": 5,
                            "awaySec": 30,
                            "avgDistanceCm": 36,
                            "dominantState": "away",
                        },
                    ]
                },
            ).raise_for_status().json()
            assert res2["savedCount"] == 2

            daily = client.get(
                f"/api/v1/parent/attention/{cid}/daily",
                params={"date": TEST_DATE},
            ).raise_for_status().json()

            assert daily["totalTrackedSec"] == 120
            assert daily["presentSec"] == 90
            assert daily["focusedSec"] == 70
            assert daily["distractedSec"] == 15
            assert daily["nearPostureSec"] == 5
            assert daily["awaySec"] == 30
            assert daily["presentRatePct"] == 75
            assert daily["focusRatePct"] == 58
            assert 40 <= daily["avgDistanceCm"] <= 42
            assert len(daily["tasks"][0]["segments"]) == 2
        finally:
            if task_id:
                client.delete(f"/api/v1/tasks/{task_id}", params={"actor": "parent"})
