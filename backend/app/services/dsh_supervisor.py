import asyncio
from datetime import datetime, timezone
import json
import threading
import time
from typing import Any, Callable, Coroutine
from sqlalchemy import select
from ..database import AsyncSessionLocal
from ..models import AsyncJobModel, ChildModel, TaskModel, utc_now_iso
from ..providers.dsh_agent import run_dsh_for_child
from .audit_logger import log_error, log_event, log_warn

CLIFFHANGER_SUFFIXES = (
    "一道一道来",
    "一道道来",
    "一起来看",
    "一起来看看",
    "下面我们看",
    "下面来看看",
    "接下来看",
    "接下来我们",
    "具体如下",
    "如下所示",
    "请看下面",
)


def strip_terminal_punct(text: str) -> str:
    return text.strip().rstrip("。！？!?…~～.，,：:；; ")


def has_unfinished_cliffhanger(text: str) -> bool:
    s = text.strip()
    if not s:
        return True
    if s[-1] in {":", "：", "，", ",", "、", "…"} or s.endswith("..."):
        return True
    core = strip_terminal_punct(s)
    return any(core.endswith(sfx) for sfx in CLIFFHANGER_SUFFIXES)


def audit_dsh_payload_completeness(
    task_kind: str,
    payload: dict[str, Any] | None,
    context: dict[str, Any] | None = None,
) -> list[str]:
    ctx = context or {}
    if not isinstance(payload, dict) or not payload:
        return ["DSH 返回为空或非 JSON 对象"]

    issues: list[str] = []

    if task_kind == "homework_review":
        raw_score = payload.get("score")
        if raw_score is None:
            issues.append("缺少 score 评分字段")
        else:
            try:
                sc = int(raw_score)
            except (TypeError, ValueError):
                sc = -1
                issues.append("score 不是有效整数")
            praise = str(payload.get("quickPraise") or "").strip()
            if len(praise) < 24:
                issues.append("quickPraise 评语过短或未写完")
            elif has_unfinished_cliffhanger(praise):
                issues.append(
                    f"quickPraise 结尾像是未说完的半截引子（「{praise[-16:]}」），必须改写为首尾完整、独立可读的总结评语"
                )

            mistakes = payload.get("newMistakes")
            upload_kind = str(ctx.get("uploadKind") or "initial")
            if not isinstance(mistakes, list):
                issues.append("newMistakes 必须为数组")
            else:
                if upload_kind == "initial" and 0 <= sc < 92 and len(mistakes) == 0:
                    issues.append(f"得分仅 {sc} 分但 newMistakes 为空，未列出扣分错题讲解")
                for idx, m in enumerate(mistakes):
                    if not isinstance(m, dict):
                        issues.append(f"newMistakes[{idx}] 不是对象")
                        continue
                    for req_k in ("questionTitle", "wrongSnippet", "errorCause"):
                        if not str(m.get(req_k) or "").strip():
                            issues.append(f"newMistakes[{idx}] 缺少 {req_k}")
                    steps = m.get("correctSteps")
                    if not isinstance(steps, list) or len([x for x in steps if str(x).strip()]) < 2:
                        issues.append(f"newMistakes[{idx}] 的 correctSteps 至少需要 2 步完整解析")
                    if not str(m.get("practiceQuestion") or "").strip() or not str(
                        m.get("practiceAnswer") or ""
                    ).strip():
                        issues.append(f"newMistakes[{idx}] 缺少举一反三巩固题或参考答案")

    elif task_kind == "daily_eval":
        if payload.get("totalScore") is None:
            issues.append("缺少 totalScore")
        dims = payload.get("dimensionScores")
        if not isinstance(dims, dict) or any(
            k not in dims for k in ("completion", "focus", "quality", "habit")
        ):
            issues.append("dimensionScores 缺少四维分项")
        sentences = payload.get("childCommentarySentences")
        if not isinstance(sentences, list) or len([s for s in sentences if str(s).strip()]) < 3:
            issues.append("childCommentarySentences 少于 3 句完整讲评")
        if len(str(payload.get("parentSummary") or "").strip()) < 16:
            issues.append("parentSummary 家长学情总结未写完")
        tips = payload.get("tomorrowTips")
        if not isinstance(tips, list) or len([t for t in tips if str(t).strip()]) < 1:
            issues.append("tomorrowTips 缺少明日可执行建议")

    elif task_kind == "voice_parse":
        if not str(payload.get("spokenReply") or "").strip():
            issues.append("缺少 spokenReply")
        drafts = payload.get("drafts")
        if not isinstance(drafts, list) or len(drafts) == 0:
            issues.append("drafts 任务草稿数组为空")

    elif task_kind == "dictionary_lookup":
        entries = payload.get("entries")
        expected_min = int(ctx.get("expectedCount") or 1)
        if not isinstance(entries, list) or len(entries) < expected_min:
            issues.append(f"entries 数量不足（期望至少 {expected_min} 项）")

    return issues


async def run_supervised_dsh_task(
    child: ChildModel,
    task_kind: str,
    task_prompt: str,
    context: dict[str, Any] | None = None,
    max_supervisor_rounds: int = 2,
) -> tuple[dict[str, Any], str | None]:
    first_error: Exception | None = None
    candidate_json: dict[str, Any] | None = None
    worker_session_id: str | None = None

    try:
        candidate_json, worker_session_id = await run_dsh_for_child(
            child,
            task_prompt,
            session_id=None,
        )
    except Exception as exc:
        first_error = exc
        log_warn(
            "dsh.worker_session_failed",
            f"DSH 主工作会话异常，交由监督会话接管续跑 ({task_kind})",
            childId=child.id,
            taskKind=task_kind,
            errorDetail=str(exc),
        )

    issues = (
        [f"主工作会话执行异常: {first_error}"]
        if first_error is not None
        else audit_dsh_payload_completeness(task_kind, candidate_json, context=context)
    )

    if not issues and candidate_json is not None:
        log_event(
            "dsh.supervisor_verified",
            f"DSH 监督校验一次通过 ({task_kind})",
            childId=child.id,
            taskKind=task_kind,
            workerSessionId=worker_session_id,
        )
        return candidate_json, worker_session_id

    supervisor_session_id: str | None = None
    for round_idx in range(1, max_supervisor_rounds + 1):
        partial_dump = (
            json.dumps(candidate_json, ensure_ascii=False)[:3500]
            if candidate_json is not None
            else "（上一工作会话未返回完整 JSON）"
        )
        issues_bullet = "\n".join(f"- {it}" for it in issues)
        repair_prompt = (
            f"【独立监督与补全会话 · 第 {round_idx} 轮】\n"
            f"你正在监督并收口学生「{child.display_name}」的 `{task_kind}` 任务，确保任务100%完整做完、绝不半截停顿。\n\n"
            f"=== 原始任务要求 ===\n{task_prompt}\n\n"
            f"=== 上一工作会话输出草稿 ===\n{partial_dump}\n\n"
            f"=== 监督器检测到的未完成/不合规问题 ===\n{issues_bullet}\n\n"
            "请先核对当前工作目录下的 `MEMORY.md`（若尚未写入本次要点请补写），"
            "然后修正并补全上述所有缺失项（特别是评语必须首尾完整自洽，不得出现“我们一道一道来”等没说完的悬空结尾），"
            "最后严格只输出完整的纯 JSON 对象。"
        )
        try:
            candidate_json, supervisor_session_id = await run_dsh_for_child(
                child,
                repair_prompt,
                session_id=None,
            )
            issues = audit_dsh_payload_completeness(task_kind, candidate_json, context=context)
            if not issues and candidate_json is not None:
                log_event(
                    "dsh.supervisor_repaired",
                    f"DSH 独立监督会话成功补全任务 ({task_kind}, round={round_idx})",
                    childId=child.id,
                    taskKind=task_kind,
                    workerSessionId=worker_session_id,
                    supervisorSessionId=supervisor_session_id,
                    round=round_idx,
                )
                return candidate_json, supervisor_session_id
        except Exception as sup_exc:
            issues = [f"监督会话第 {round_idx} 轮异常: {sup_exc}"]
            log_warn(
                "dsh.supervisor_round_failed",
                f"DSH 监督会话第 {round_idx} 轮报错 ({task_kind})",
                childId=child.id,
                taskKind=task_kind,
                round=round_idx,
                errorDetail=str(sup_exc),
            )

    if candidate_json is not None:
        log_warn(
            "dsh.supervisor_best_effort",
            f"DSH 监督会话达到上限，返回已修复最佳结果 ({task_kind})",
            childId=child.id,
            taskKind=task_kind,
            remainingIssues=issues,
        )
        return candidate_json, supervisor_session_id or worker_session_id

    err_msg = "; ".join(issues) or "DSH 主会话与监督会话均未能完成任务"
    err = RuntimeError(err_msg)
    log_error(
        "dsh.supervisor_exhausted",
        f"DSH 监督重试耗尽失败 ({task_kind})",
        exc=err,
        childId=child.id,
        taskKind=task_kind,
    )
    raise err


JobDispatcher = Callable[[AsyncJobModel], Coroutine[Any, Any, None]]


class JobSupervisorWatchdog:
    def __init__(self, check_interval_sec: float = 10.0, stall_timeout_sec: float = 180.0) -> None:
        self._check_interval_sec = check_interval_sec
        self._stall_timeout_sec = stall_timeout_sec
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._dispatcher: JobDispatcher | None = None
        self._active_heartbeats: dict[str, float] = {}
        self._recovery_counts: dict[str, int] = {}

    def mark_started(self, job_id: str) -> None:
        with self._lock:
            self._active_heartbeats[job_id] = time.monotonic()

    def heartbeat(self, job_id: str) -> None:
        with self._lock:
            self._active_heartbeats[job_id] = time.monotonic()

    def mark_finished(self, job_id: str) -> None:
        with self._lock:
            self._active_heartbeats.pop(job_id, None)

    def start(self, loop: asyncio.AbstractEventLoop, dispatcher: JobDispatcher) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._loop = loop
            self._dispatcher = dispatcher
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._thread_main,
                name="StudyDiaryJobSupervisor",
                daemon=True,
            )
            self._thread.start()
        log_event("supervisor.watchdog_started", "后台任务监督线程已启动")

    def stop(self) -> None:
        self._stop_event.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=3.0)
        log_event("supervisor.watchdog_stopped", "后台任务监督线程已停止")

    def _thread_main(self) -> None:
        while not self._stop_event.wait(self._check_interval_sec):
            if self._loop is None or self._loop.is_closed() or self._dispatcher is None:
                continue
            fut = asyncio.run_coroutine_threadsafe(self._scan_and_recover(), self._loop)
            try:
                fut.result(timeout=25.0)
            except Exception as exc:
                log_warn(
                    "supervisor.scan_warn",
                    f"监督线程巡检异常: {exc}",
                )

    async def _scan_and_recover(self) -> None:
        if self._dispatcher is None:
            return
        async with AsyncSessionLocal() as db:
            res = await db.execute(
                select(AsyncJobModel).where(
                    AsyncJobModel.status.in_(["queued", "ocr_running", "dsh_running", "tts_running"]),
                    AsyncJobModel.job_type.in_(["homework_review", "daily_eval"]),
                )
            )
            open_jobs = list(res.scalars().all())

        if not open_jobs:
            return

        now_mono = time.monotonic()
        now_utc = datetime.now(timezone.utc)

        for job in open_jobs:
            with self._lock:
                hb = self._active_heartbeats.get(job.id)
                attempts = self._recovery_counts.get(job.id, 0)

            should_recover = False
            reason = ""
            if hb is None:
                try:
                    created_dt = datetime.fromisoformat(job.created_at)
                    if created_dt.tzinfo is None:
                        created_dt = created_dt.replace(tzinfo=timezone.utc)
                    age_sec = (now_utc - created_dt).total_seconds()
                except Exception:
                    age_sec = 30.0
                if age_sec >= 8.0:
                    should_recover = True
                    reason = f"检测到无活跃协程的孤立任务 (age={round(age_sec, 1)}s)"
            elif (now_mono - hb) >= self._stall_timeout_sec:
                should_recover = True
                reason = f"检测到任务心跳停滞超过 {int(self._stall_timeout_sec)}s"

            if not should_recover:
                continue

            if attempts >= 2:
                async with AsyncSessionLocal() as db:
                    j_row = await db.get(AsyncJobModel, job.id)
                    if j_row and j_row.status not in {"succeeded", "failed"}:
                        j_row.status = "failed"
                        j_row.progress_text = "监督线程多次续跑仍未完成，请点击重试"
                        j_row.error_detail = f"{reason}（已达监督重试上限）"
                        j_row.finished_at = utc_now_iso()
                        await db.commit()
                self.mark_finished(job.id)
                continue

            with self._lock:
                self._recovery_counts[job.id] = attempts + 1
                self._active_heartbeats[job.id] = now_mono

            log_warn(
                "supervisor.job_recovering",
                f"监督线程接管并拉起新会话续跑任务: {job.id} ({job.job_type})",
                jobId=job.id,
                jobType=job.job_type,
                taskId=job.task_id,
                attempt=attempts + 1,
                reason=reason,
            )
            asyncio.create_task(self._dispatcher(job))


job_supervisor = JobSupervisorWatchdog()


async def dispatch_recovered_job(job: AsyncJobModel) -> None:
    from .async_worker import execute_daily_evaluation_job, execute_homework_review_job

    if job.job_type == "homework_review" and job.task_id:
        upload_kind = "initial"
        async with AsyncSessionLocal() as db:
            t = await db.get(TaskModel, job.task_id)
            if t and t.status == "completed":
                upload_kind = "correction"
        await execute_homework_review_job(job.id, job.task_id, upload_kind)
    elif job.job_type == "daily_eval" and job.eval_date:
        await execute_daily_evaluation_job(job.id, job.child_id, job.eval_date)
