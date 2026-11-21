import asyncio
from datetime import datetime, timedelta, timezone
import os
from unittest.mock import patch
import uuid
import httpx
from app.config import settings
from app.models import AsyncJobModel, ChildModel
from app.services.dsh_supervisor import (
    JobSupervisorWatchdog,
    audit_dsh_payload_completeness,
    has_unfinished_cliffhanger,
    run_supervised_dsh_task,
)

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url


def make_client() -> httpx.Client:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    return httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=30.0)


def test_supervisor_detects_cliffhanger_and_completes_via_second_session() -> None:
    dangling = (
        "同学，你的“24点”思路很灵活，巧填等式也完全正确！"
        "不过有三道题的小陷阱没躲过：配对组数、比较大小、凑整拆数。"
        "这三处正是海星老师要陪你一起攻克的地方，我们一道一道来！"
    )
    assert has_unfinished_cliffhanger(dangling) is True

    closed = (
        "同学，你的“24点”两道不同算式思路很灵活，巧填等式61和38也完全正确！"
        "扣分集中在奇数配对算错组数、比较大小未拆分以及凑整未把6拆成1+2+3，"
        "对照下方三张精讲卡订正重传就能把分数追回来，加油！"
    )
    assert has_unfinished_cliffhanger(closed) is False

    bad_payload = {
        "score": 60,
        "quickPraise": dangling,
        "masteredMistakeIds": [],
        "newMistakes": [],
    }
    issues = audit_dsh_payload_completeness(
        "homework_review",
        bad_payload,
        context={"uploadKind": "initial"},
    )
    assert len(issues) >= 2

    repaired_payload = {
        "score": 60,
        "quickPraise": closed,
        "masteredMistakeIds": [],
        "newMistakes": [
            {
                "imageId": "img-1",
                "box": [100, 100, 500, 300],
                "questionTitle": "奇数数列求和组数错误",
                "wrongSnippet": "100×50=5000",
                "errorCause": "50个奇数两两配对只有25对",
                "correctSteps": ["第一步：计算项数50个", "第二步：50÷2=25对，100×25=2500"],
                "practiceQuestion": "1+3+5+...+19=?",
                "practiceAnswer": "10个数5对，20×5=100",
            }
        ],
    }

    call_log: list[dict] = []

    async def fake_run_dsh(_child: ChildModel, prompt: str, session_id: str | None = None):
        call_log.append({"prompt": prompt, "session_id": session_id})
        if len(call_log) == 1:
            return bad_payload, "sess-worker-1"
        return repaired_payload, "sess-supervisor-2"

    fake_child = ChildModel(
        id="child_unit_sup",
        display_name="测试生",
        birth_date="2017-05-01",
        gender="女",
        age=9,
        grade_label="小学四年级",
        title_badge="星仙子",
        avatar_key="duoduo",
        theme_pink="#EC5F9B",
        daily_goal_minutes=60,
        star_coins=100,
    )

    async def _exercise():
        with patch("app.services.dsh_supervisor.run_dsh_for_child", side_effect=fake_run_dsh):
            out, final_sess = await run_supervised_dsh_task(
                fake_child,
                task_kind="homework_review",
                task_prompt="请批阅数学口算作业",
                context={"uploadKind": "initial"},
            )
            return out, final_sess

    final_json, final_sess_id = asyncio.run(_exercise())
    assert len(call_log) == 2
    assert call_log[0]["session_id"] is None
    assert call_log[1]["session_id"] is None
    assert "独立监督与补全会话" in call_log[1]["prompt"]
    assert final_sess_id == "sess-supervisor-2"
    assert has_unfinished_cliffhanger(final_json["quickPraise"]) is False
    assert len(final_json["newMistakes"]) == 1


def test_watchdog_thread_dispatches_orphaned_job() -> None:
    recovered_ids: list[str] = []

    async def _run_watchdog_check():
        loop = asyncio.get_running_loop()
        watchdog = JobSupervisorWatchdog(check_interval_sec=0.12, stall_timeout_sec=1.0)

        old_iso = (datetime.now(timezone.utc) - timedelta(seconds=20)).isoformat()
        fake_orphan = AsyncJobModel(
            id="job-orphan-unit",
            child_id="child_unit",
            task_id="task-unit",
            job_type="homework_review",
            status="dsh_running",
            progress_text="半途中断",
            created_at=old_iso,
        )

        class FakeScalarResult:
            def all(self):
                return [fake_orphan]

        class FakeExecResult:
            def scalars(self):
                return FakeScalarResult()

        class FakeSessionCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def execute(self, _stmt):
                return FakeExecResult()

        async def fake_dispatcher(job: AsyncJobModel) -> None:
            recovered_ids.append(job.id)
            watchdog.mark_finished(job.id)

        with patch("app.services.dsh_supervisor.AsyncSessionLocal", return_value=FakeSessionCtx()):
            watchdog.start(loop, fake_dispatcher)
            try:
                for _ in range(15):
                    await asyncio.sleep(0.08)
                    if recovered_ids:
                        break
            finally:
                watchdog.stop()

    asyncio.run(_run_watchdog_check())
    assert recovered_ids == ["job-orphan-unit"]


def test_live_lazy_tts_on_demand_and_cache_hit() -> None:
    auth_headers = {"Authorization": f"Bearer {settings.admin_token}"}
    temp_child_id: str | None = None

    with make_client() as client:
        try:
            created = client.post(
                "/api/v1/admin/children",
                headers=auth_headers,
                json={
                    "displayName": "按需语音测试号",
                    "birthDate": "2017-07-07",
                    "gender": "女",
                    "age": 9,
                    "gradeLabel": "小学四年级",
                    "dailyGoalMinutes": 60,
                },
            ).raise_for_status().json()
            temp_child_id = created["id"]

            parsed = client.post(
                f"/api/v1/children/{temp_child_id}/tasks/voice-parse",
                json={"transcript": "今天做20分钟数学口算练习", "targetDate": "2099-12-27"},
            ).raise_for_status().json()
            assert parsed["ttsAudioUrl"] is None

            unique_phrase = f"星莓按需播报测试 {uuid.uuid4().hex[:6]}"
            first_play = client.post(
                "/api/v1/tts/speak",
                data={"text": unique_phrase},
            ).raise_for_status().json()
            assert first_play["cached"] is False
            wav = client.get(first_play["audioUrl"]).raise_for_status().content
            assert wav[:4] == b"RIFF"

            second_play = client.post(
                "/api/v1/tts/speak",
                data={"text": unique_phrase},
            ).raise_for_status().json()
            assert second_play["cached"] is True
            assert second_play["audioUrl"] == first_play["audioUrl"]
        finally:
            if temp_child_id:
                client.delete(
                    f"/api/v1/admin/children/{temp_child_id}",
                    headers=auth_headers,
                )
