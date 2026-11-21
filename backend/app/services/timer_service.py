from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..config import settings
from ..models import TaskModel, utc_now_iso
from .audit_logger import log_event, log_warn

CN_TZ = timezone(timedelta(hours=8))


def now_cn_hhmm() -> str:
    return datetime.now(CN_TZ).strftime("%H:%M")


def parse_iso_utc(iso_str: str | None) -> datetime | None:
    if not iso_str:
        return None
    dt = datetime.fromisoformat(iso_str)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


async def enforce_idle_auto_pause_for_child(db: AsyncSession, child_id: str) -> None:
    res = await db.execute(
        select(TaskModel).where(
            TaskModel.child_id == child_id,
            TaskModel.status == "in_progress",
        )
    )
    running_tasks = list(res.scalars().all())
    if not running_tasks:
        return

    now = datetime.now(timezone.utc)
    changed = False
    for task in running_tasks:
        last_hb = parse_iso_utc(task.last_heartbeat_at) or parse_iso_utc(task.active_started_at)
        seg_start = parse_iso_utc(task.active_started_at)
        if last_hb and (now - last_hb).total_seconds() >= settings.idle_auto_pause_sec:
            capped_end = last_hb
            if seg_start and capped_end > seg_start:
                delta = int((capped_end - seg_start).total_seconds())
                task.actual_duration_sec += max(0, min(delta, settings.idle_auto_pause_sec))
            task.status = "paused"
            task.pause_count += 1
            task.active_started_at = None
            task.auto_paused_reason = "超过90分钟无操作交互，系统已自动暂停保护"
            task.updated_at = utc_now_iso()
            changed = True
            log_warn(
                "timer.idle_auto_paused",
                f"任务超过90分钟无交互自动暂停: {task.title}",
                childId=task.child_id,
                taskId=task.id,
                actualDurationSec=task.actual_duration_sec,
                pauseCount=task.pause_count,
            )

    if changed:
        await db.commit()


def compute_live_actual_seconds(task: TaskModel) -> int:
    base = task.actual_duration_sec
    if task.status == "in_progress" and task.active_started_at:
        seg_start = parse_iso_utc(task.active_started_at)
        if seg_start:
            elapsed = int((datetime.now(timezone.utc) - seg_start).total_seconds())
            return base + max(0, min(elapsed, settings.idle_auto_pause_sec))
    return base


async def start_task_timer(db: AsyncSession, task: TaskModel) -> TaskModel:
    await enforce_idle_auto_pause_for_child(db, task.child_id)

    if task.status in {"completed", "voided"}:
        raise HTTPException(status_code=400, detail="已完成或已作废的任务不能再次开启计时")

    other_res = await db.execute(
        select(TaskModel).where(
            TaskModel.child_id == task.child_id,
            TaskModel.status == "in_progress",
            TaskModel.id != task.id,
        )
    )
    other_active = other_res.scalar_one_or_none()
    if other_active is not None:
        raise HTTPException(
            status_code=409,
            detail=f"同一时间只能有一个任务在计时，请先暂停或完成「{other_active.title}」",
        )

    now_iso = utc_now_iso()
    if task.status != "in_progress":
        if not task.timer_locked or not task.planned_start_time.strip():
            task.planned_start_time = now_cn_hhmm()
        task.status = "in_progress"
        task.timer_locked = True
        task.active_started_at = now_iso
        task.last_heartbeat_at = now_iso
        task.auto_paused_reason = None
        task.updated_at = now_iso
        await db.commit()
        await db.refresh(task)
        log_event(
            "timer.started",
            f"开始学习计时: {task.title}",
            childId=task.child_id,
            taskId=task.id,
            plannedStartTime=task.planned_start_time,
            timerMode=task.timer_mode,
            plannedDurationSec=task.planned_duration_sec,
            resumedFromSec=task.actual_duration_sec,
        )
    return task


async def heartbeat_task_timer(db: AsyncSession, task: TaskModel) -> TaskModel:
    await enforce_idle_auto_pause_for_child(db, task.child_id)
    await db.refresh(task)
    if task.status == "in_progress":
        task.last_heartbeat_at = utc_now_iso()
        await db.commit()
        await db.refresh(task)
    return task


async def pause_task_timer(db: AsyncSession, task: TaskModel) -> TaskModel:
    await enforce_idle_auto_pause_for_child(db, task.child_id)
    await db.refresh(task)
    if task.status != "in_progress":
        return task

    now = datetime.now(timezone.utc)
    seg_start = parse_iso_utc(task.active_started_at)
    if seg_start and now > seg_start:
        delta = int((now - seg_start).total_seconds())
        task.actual_duration_sec += max(0, min(delta, settings.idle_auto_pause_sec))

    task.status = "paused"
    task.pause_count += 1
    task.active_started_at = None
    task.last_heartbeat_at = now.isoformat()
    task.updated_at = now.isoformat()
    await db.commit()
    await db.refresh(task)
    log_event(
        "timer.paused",
        f"暂停学习计时: {task.title}",
        childId=task.child_id,
        taskId=task.id,
        actualDurationSec=task.actual_duration_sec,
        pauseCount=task.pause_count,
    )
    return task


async def settle_timer_for_submission(db: AsyncSession, task: TaskModel) -> TaskModel:
    await enforce_idle_auto_pause_for_child(db, task.child_id)
    await db.refresh(task)
    now = datetime.now(timezone.utc)
    changed = False
    if not task.planned_start_time.strip():
        task.planned_start_time = now_cn_hhmm()
        changed = True
    if task.status == "in_progress":
        seg_start = parse_iso_utc(task.active_started_at)
        if seg_start and now > seg_start:
            delta = int((now - seg_start).total_seconds())
            task.actual_duration_sec += max(1, min(delta, settings.idle_auto_pause_sec))
        task.active_started_at = None
        task.last_heartbeat_at = now.isoformat()
        task.timer_locked = True
        changed = True
    elif task.actual_duration_sec == 0:
        task.actual_duration_sec = 60
        task.timer_locked = True
        changed = True
    if changed:
        task.updated_at = now.isoformat()
        await db.commit()
        await db.refresh(task)
    return task
