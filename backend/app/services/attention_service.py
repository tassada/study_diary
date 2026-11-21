import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_db_session
from ..models import TaskAttentionSegmentModel, TaskModel, utc_now_iso
from .audit_logger import log_event

attention_router = APIRouter()


class AttentionSegmentIn(BaseModel):
    segmentIndex: int = Field(..., ge=0)
    startOffsetSec: int = Field(default=0, ge=0)
    durationSec: int = Field(..., ge=1, le=600)
    presentSec: int = Field(default=0, ge=0)
    focusedSec: int = Field(default=0, ge=0)
    distractedSec: int = Field(default=0, ge=0)
    drowsySec: int = Field(default=0, ge=0)
    nearPostureSec: int = Field(default=0, ge=0)
    awaySec: int = Field(default=0, ge=0)
    avgDistanceCm: int = Field(default=0, ge=0, le=300)
    dominantState: str = Field(default="focused", max_length=24)


class AttentionBatchUploadIn(BaseModel):
    segments: list[AttentionSegmentIn] = Field(default_factory=list)


class AttentionSegmentOut(BaseModel):
    segmentIndex: int
    startOffsetSec: int
    durationSec: int
    presentSec: int
    focusedSec: int
    distractedSec: int
    drowsySec: int
    nearPostureSec: int
    awaySec: int
    avgDistanceCm: int
    dominantState: str


class TaskAttentionSummaryOut(BaseModel):
    taskId: str
    title: str
    subject: str
    plannedStartTime: str
    updatedAt: str
    status: str
    trackedSec: int
    presentSec: int
    focusedSec: int
    distractedSec: int
    drowsySec: int
    nearPostureSec: int
    awaySec: int
    avgDistanceCm: int
    focusRatePct: int
    presentRatePct: int
    segments: list[AttentionSegmentOut]


class DailyAttentionReportOut(BaseModel):
    childId: str
    date: str
    totalTrackedSec: int
    presentSec: int
    focusedSec: int
    distractedSec: int
    drowsySec: int
    nearPostureSec: int
    awaySec: int
    avgDistanceCm: int
    presentRatePct: int
    focusRatePct: int
    tasks: list[TaskAttentionSummaryOut]


@attention_router.post("/api/v1/tasks/{task_id}/attention-segments")
async def upload_task_attention_segments(
    task_id: str,
    payload: AttentionBatchUploadIn,
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    if not payload.segments:
        return {"savedCount": 0, "taskId": task_id}

    existing_res = await db.execute(
        select(TaskAttentionSegmentModel).where(TaskAttentionSegmentModel.task_id == task_id)
    )
    existing_by_idx = {r.segment_index: r for r in existing_res.scalars().all()}

    for seg in payload.segments:
        row = existing_by_idx.get(seg.segmentIndex)
        if row:
            row.start_offset_sec = seg.startOffsetSec
            row.duration_sec = seg.durationSec
            row.present_sec = seg.presentSec
            row.focused_sec = seg.focusedSec
            row.distracted_sec = seg.distractedSec
            row.drowsy_sec = seg.drowsySec
            row.near_posture_sec = seg.nearPostureSec
            row.away_sec = seg.awaySec
            row.avg_distance_cm = seg.avgDistanceCm
            row.dominant_state = seg.dominantState
        else:
            db.add(
                TaskAttentionSegmentModel(
                    id=f"attseg-{uuid.uuid4().hex[:12]}",
                    child_id=task.child_id,
                    task_id=task.id,
                    task_date=task.task_date,
                    segment_index=seg.segmentIndex,
                    start_offset_sec=seg.startOffsetSec,
                    duration_sec=seg.durationSec,
                    present_sec=seg.presentSec,
                    focused_sec=seg.focusedSec,
                    distracted_sec=seg.distractedSec,
                    drowsy_sec=seg.drowsySec,
                    near_posture_sec=seg.nearPostureSec,
                    away_sec=seg.awaySec,
                    avg_distance_cm=seg.avgDistanceCm,
                    dominant_state=seg.dominantState,
                    created_at=utc_now_iso(),
                )
            )

    await db.commit()
    log_event(
        "attention.segments_saved",
        f"保存专注度分段统计 ({len(payload.segments)} 段): {task.title}",
        childId=task.child_id,
        taskId=task.id,
        segmentCount=len(payload.segments),
    )
    return {"savedCount": len(payload.segments), "taskId": task_id}


@attention_router.get(
    "/api/v1/parent/attention/{child_id}/daily",
    response_model=DailyAttentionReportOut,
)
async def get_daily_attention_report(
    child_id: str,
    date: str = Query(...),
    db: AsyncSession = Depends(get_db_session),
) -> DailyAttentionReportOut:
    t_res = await db.execute(
        select(TaskModel)
        .where(
            TaskModel.child_id == child_id,
            TaskModel.task_date == date,
            TaskModel.status != "voided",
        )
        .order_by(
            case((TaskModel.planned_start_time == "", 1), else_=0).asc(),
            TaskModel.planned_start_time.asc(),
            TaskModel.id.asc(),
        )
    )
    tasks = list(t_res.scalars().all())

    s_res = await db.execute(
        select(TaskAttentionSegmentModel)
        .where(
            TaskAttentionSegmentModel.child_id == child_id,
            TaskAttentionSegmentModel.task_date == date,
        )
        .order_by(TaskAttentionSegmentModel.segment_index.asc())
    )
    all_segs = list(s_res.scalars().all())

    segs_by_task: dict[str, list[TaskAttentionSegmentModel]] = {}
    for s in all_segs:
        segs_by_task.setdefault(s.task_id, []).append(s)

    task_summaries: list[TaskAttentionSummaryOut] = []
    day_tracked = 0
    day_present = 0
    day_focused = 0
    day_distracted = 0
    day_drowsy = 0
    day_near = 0
    day_away = 0
    dist_weighted_sum = 0
    dist_weight_sec = 0

    for t in tasks:
        tsegs = segs_by_task.get(t.id, [])
        t_tracked = sum(x.duration_sec for x in tsegs)
        t_present = sum(x.present_sec for x in tsegs)
        t_focused = sum(x.focused_sec for x in tsegs)
        t_distracted = sum(x.distracted_sec for x in tsegs)
        t_drowsy = sum(x.drowsy_sec for x in tsegs)
        t_near = sum(x.near_posture_sec for x in tsegs)
        t_away = sum(x.away_sec for x in tsegs)

        t_dist_sum = sum(x.avg_distance_cm * x.present_sec for x in tsegs if x.avg_distance_cm > 0)
        t_dist_sec = sum(x.present_sec for x in tsegs if x.avg_distance_cm > 0)
        t_avg_dist = round(t_dist_sum / t_dist_sec) if t_dist_sec > 0 else 0

        day_tracked += t_tracked
        day_present += t_present
        day_focused += t_focused
        day_distracted += t_distracted
        day_drowsy += t_drowsy
        day_near += t_near
        day_away += t_away
        dist_weighted_sum += t_dist_sum
        dist_weight_sec += t_dist_sec

        task_summaries.append(
            TaskAttentionSummaryOut(
                taskId=t.id,
                title=t.title,
                subject=t.subject,
                plannedStartTime=t.planned_start_time,
                updatedAt=t.updated_at,
                status=t.status,
                trackedSec=t_tracked,
                presentSec=t_present,
                focusedSec=t_focused,
                distractedSec=t_distracted,
                drowsySec=t_drowsy,
                nearPostureSec=t_near,
                awaySec=t_away,
                avgDistanceCm=t_avg_dist,
                focusRatePct=round(t_focused * 100 / t_tracked) if t_tracked > 0 else 0,
                presentRatePct=round(t_present * 100 / t_tracked) if t_tracked > 0 else 0,
                segments=[
                    AttentionSegmentOut(
                        segmentIndex=x.segment_index,
                        startOffsetSec=x.start_offset_sec,
                        durationSec=x.duration_sec,
                        presentSec=x.present_sec,
                        focusedSec=x.focused_sec,
                        distractedSec=x.distracted_sec,
                        drowsySec=x.drowsy_sec,
                        nearPostureSec=x.near_posture_sec,
                        awaySec=x.away_sec,
                        avgDistanceCm=x.avg_distance_cm,
                        dominantState=x.dominant_state,
                    )
                    for x in tsegs
                ],
            )
        )

    day_avg_dist = round(dist_weighted_sum / dist_weight_sec) if dist_weight_sec > 0 else 0
    return DailyAttentionReportOut(
        childId=child_id,
        date=date,
        totalTrackedSec=day_tracked,
        presentSec=day_present,
        focusedSec=day_focused,
        distractedSec=day_distracted,
        drowsySec=day_drowsy,
        nearPostureSec=day_near,
        awaySec=day_away,
        avgDistanceCm=day_avg_dist,
        presentRatePct=round(day_present * 100 / day_tracked) if day_tracked > 0 else 0,
        focusRatePct=round(day_focused * 100 / day_tracked) if day_tracked > 0 else 0,
        tasks=task_summaries,
    )
