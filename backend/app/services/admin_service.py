import json
import secrets
import time
import uuid
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession
from ..config import settings
from ..database import get_db_session
from ..models import (
    ChildModel,
    DailyEvalModel,
    DictionaryLookupModel,
    MistakeModel,
    TaskAttentionSegmentModel,
    TaskImageModel,
    TaskModel,
    utc_now_iso,
)
from ..providers.dsh_agent import ensure_child_agent_files
from ..providers.minio_store import minio_gateway
from ..schemas import ChildProfileOut, DailyEvaluationOut, DictionaryLookupOut, TaskOut
from .attention_service import DailyAttentionReportOut, get_daily_attention_report
from .audit_logger import log_event, log_warn, read_recent_events
from .dictionary_service import serialize_lookup_row
from .image_pipeline import rotate_jpeg_clockwise, rotate_ocr_boxes_clockwise
from .timer_service import enforce_idle_auto_pause_for_child

admin_router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def extract_bearer_token(authorization: str | None, x_admin_token: str | None) -> str:
    if x_admin_token and x_admin_token.strip():
        return x_admin_token.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


def require_admin_token(
    authorization: str | None = Header(default=None),
    x_admin_token: str | None = Header(default=None),
) -> None:
    expected = settings.admin_token.strip()
    if not expected:
        raise HTTPException(status_code=503, detail="服务端尚未配置 ADMIN_TOKEN")
    provided = extract_bearer_token(authorization, x_admin_token)
    if not provided or not secrets.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        log_warn("admin.auth_failed", "管理后台 Token 校验未通过")
        raise HTTPException(status_code=401, detail="管理后台预设 Token 无效或已过期")


class AdminAuthVerifyOut(BaseModel):
    authenticated: bool
    serverTime: str


class CreateChildIn(BaseModel):
    displayName: str = Field(..., min_length=1, max_length=32)
    birthDate: str = Field(..., min_length=8, max_length=16)
    gender: str = Field(default="女", max_length=8)
    age: int = Field(default=9, ge=3, le=18)
    gradeLabel: str = Field(default="小学四年级", max_length=32)
    titleBadge: str = Field(default="星莓魔法学院 · 伴学小学员", max_length=64)
    avatarKey: str = Field(default="duoduo", max_length=32)
    dailyGoalMinutes: int = Field(default=75, ge=10, le=300)


@admin_router.post("/auth/verify", response_model=AdminAuthVerifyOut)
async def verify_admin_login(_auth: None = Depends(require_admin_token)) -> AdminAuthVerifyOut:
    log_event("admin.login_ok", "管理员通过预设 Token 登录管理后台")
    return AdminAuthVerifyOut(authenticated=True, serverTime=utc_now_iso())


@admin_router.get("/children")
async def admin_list_children(
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> list[dict]:
    c_res = await db.execute(select(ChildModel).order_by(ChildModel.created_at.asc()))
    children = list(c_res.scalars().all())
    out: list[dict] = []

    for c in children:
        await enforce_idle_auto_pause_for_child(db, c.id)
        t_res = await db.execute(
            select(TaskModel).where(
                TaskModel.child_id == c.id,
                TaskModel.status != "voided",
            )
        )
        tasks = list(t_res.scalars().all())
        completed = [t for t in tasks if t.status == "completed"]
        running_task = next((t for t in tasks if t.status == "in_progress"), None)

        m_res = await db.execute(
            select(MistakeModel).where(MistakeModel.child_id == c.id)
        )
        mistakes = list(m_res.scalars().all())
        open_mistakes = sum(1 for m in mistakes if m.mastery_status == "open")
        mastered_mistakes = sum(1 for m in mistakes if m.mastery_status == "mastered")

        d_res = await db.execute(
            select(DictionaryLookupModel).where(DictionaryLookupModel.child_id == c.id)
        )
        dict_count = len(list(d_res.scalars().all()))

        scored = [t.earned_score for t in completed if t.earned_score is not None]
        avg_score = round(sum(scored) / len(scored)) if scored else None

        out.append(
            {
                "profile": ChildProfileOut(
                    id=c.id,
                    displayName=c.display_name,
                    birthDate=c.birth_date,
                    gender=c.gender,
                    age=c.age,
                    gradeLabel=c.grade_label,
                    titleBadge=c.title_badge,
                    avatarKey=c.avatar_key,
                    themePink=c.theme_pink,
                    dailyGoalMinutes=c.daily_goal_minutes,
                    starCoins=c.star_coins,
                ).model_dump(),
                "stats": {
                    "totalTasks": len(tasks),
                    "completedTasks": len(completed),
                    "totalFocusMinutes": round(sum(t.actual_duration_sec for t in tasks) / 60),
                    "avgScore": avg_score,
                    "openMistakes": open_mistakes,
                    "masteredMistakes": mastered_mistakes,
                    "dictionaryLookups": dict_count,
                    "activeTaskTitle": running_task.title if running_task else None,
                    "activeTaskDate": running_task.task_date if running_task else None,
                },
            }
        )
    return out


@admin_router.post("/children", response_model=ChildProfileOut)
async def admin_create_child(
    req: CreateChildIn,
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> ChildProfileOut:
    cid = f"child_{uuid.uuid4().hex[:10]}"
    row = ChildModel(
        id=cid,
        display_name=req.displayName.strip(),
        birth_date=req.birthDate.strip(),
        gender=req.gender.strip(),
        age=req.age,
        grade_label=req.gradeLabel.strip(),
        title_badge=req.titleBadge.strip(),
        avatar_key=req.avatarKey.strip(),
        theme_pink="#EC5F9B",
        daily_goal_minutes=req.dailyGoalMinutes,
        star_coins=100,
        created_at=utc_now_iso(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    ensure_child_agent_files(row)
    log_event("admin.child_created", f"管理员新增儿童档案: {row.display_name}", childId=row.id)
    return ChildProfileOut(
        id=row.id,
        displayName=row.display_name,
        birthDate=row.birth_date,
        gender=row.gender,
        age=row.age,
        gradeLabel=row.grade_label,
        titleBadge=row.title_badge,
        avatarKey=row.avatar_key,
        themePink=row.theme_pink,
        dailyGoalMinutes=row.daily_goal_minutes,
        starCoins=row.star_coins,
    )


@admin_router.delete("/children/{child_id}")
async def admin_delete_non_builtin_child(
    child_id: str,
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    if child_id == settings.default_child_id:
        raise HTTPException(status_code=403, detail="内置主档案受保护不可删除")
    row = await db.get(ChildModel, child_id)
    if not row:
        raise HTTPException(status_code=404, detail="儿童档案不存在")
    await db.delete(row)
    await db.commit()
    log_event("admin.child_deleted", f"管理员移除儿童档案: {row.display_name}", childId=child_id)
    return {"deleted": True, "childId": child_id}


@admin_router.get("/children/{child_id}/tasks", response_model=list[TaskOut])
async def admin_list_child_tasks(
    child_id: str,
    date: str | None = Query(default=None),
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> list[TaskOut]:
    from ..main import serialize_task

    await enforce_idle_auto_pause_for_child(db, child_id)
    stmt = select(TaskModel).where(
        TaskModel.child_id == child_id,
        TaskModel.status != "voided",
    )
    if date:
        stmt = stmt.where(TaskModel.task_date == date)
    stmt = stmt.order_by(
        TaskModel.task_date.desc(),
        case((TaskModel.planned_start_time == "", 1), else_=0).asc(),
        TaskModel.planned_start_time.asc(),
        TaskModel.id.asc(),
    )
    res = await db.execute(stmt)
    rows = list(res.scalars().all())
    return [await serialize_task(db, r) for r in rows]


@admin_router.get("/children/{child_id}/evaluations", response_model=list[DailyEvaluationOut])
async def admin_list_child_evaluations(
    child_id: str,
    limit: int = Query(default=30, ge=1, le=120),
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> list[DailyEvaluationOut]:
    res = await db.execute(
        select(DailyEvalModel)
        .where(DailyEvalModel.child_id == child_id)
        .order_by(DailyEvalModel.eval_date.desc())
        .limit(limit)
    )
    rows = list(res.scalars().all())
    return [
        DailyEvaluationOut(
            childId=ev.child_id,
            evalDate=ev.eval_date,
            totalScore=ev.total_score,
            dimensionScores=json.loads(ev.dimension_scores_json),
            badgeRank=ev.badge_rank,
            badgeTitle=ev.badge_title,
            childCommentarySentences=json.loads(ev.child_sentences_json),
            ttsAudioUrl=f"/api/v1/media/{ev.tts_minio_key}" if ev.tts_minio_key else None,
            parentSummary=ev.parent_summary,
            weakPoints=json.loads(ev.weak_points_json),
            tomorrowTips=json.loads(ev.tomorrow_tips_json),
            hasNewProgress=False,
            updatedAt=ev.updated_at,
        )
        for ev in rows
    ]


@admin_router.get("/children/{child_id}/memory")
async def admin_get_child_dsh_memory(
    child_id: str,
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    child = await db.get(ChildModel, child_id)
    if not child:
        raise HTTPException(status_code=404, detail="儿童档案不存在")
    ws = ensure_child_agent_files(child)
    agents_md = (ws / "AGENTS.md").read_text(encoding="utf-8") if (ws / "AGENTS.md").exists() else ""
    memory_md = (ws / "MEMORY.md").read_text(encoding="utf-8") if (ws / "MEMORY.md").exists() else ""
    mistakes_raw = (
        (ws / "mistakes.jsonl").read_text(encoding="utf-8")
        if (ws / "mistakes.jsonl").exists()
        else ""
    )
    return {
        "childId": child_id,
        "dshSessionId": child.dsh_tutor_session_id,
        "agentsMd": agents_md,
        "memoryMd": memory_md,
        "mistakesJsonl": mistakes_raw,
    }


@admin_router.get("/children/{child_id}/attention", response_model=DailyAttentionReportOut)
async def admin_get_child_daily_attention(
    child_id: str,
    date: str = Query(...),
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> DailyAttentionReportOut:
    return await get_daily_attention_report(child_id=child_id, date=date, db=db)


@admin_router.get("/children/{child_id}/attention-dates")
async def admin_list_child_attention_dates(
    child_id: str,
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> list[dict]:
    res = await db.execute(
        select(TaskAttentionSegmentModel)
        .where(TaskAttentionSegmentModel.child_id == child_id)
        .order_by(TaskAttentionSegmentModel.task_date.desc())
    )
    segs = list(res.scalars().all())
    by_date: dict[str, dict] = {}
    for s in segs:
        d = by_date.setdefault(
            s.task_date,
            {"date": s.task_date, "trackedSec": 0, "presentSec": 0, "focusedSec": 0},
        )
        d["trackedSec"] += s.duration_sec
        d["presentSec"] += s.present_sec
        d["focusedSec"] += s.focused_sec
    return list(by_date.values())


@admin_router.get("/children/{child_id}/dictionary", response_model=list[DictionaryLookupOut])
async def admin_list_child_dictionary(
    child_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> list[DictionaryLookupOut]:
    res = await db.execute(
        select(DictionaryLookupModel)
        .where(DictionaryLookupModel.child_id == child_id)
        .order_by(DictionaryLookupModel.created_at.desc())
        .limit(limit)
    )
    return [serialize_lookup_row(r) for r in res.scalars().all()]


@admin_router.get("/logs")
async def admin_get_system_logs(
    level: str = Query(default="all"),
    limit: int = Query(default=150, ge=1, le=500),
    child_id: str | None = Query(default=None),
    _auth: None = Depends(require_admin_token),
) -> dict:
    return read_recent_events(level_filter=level, limit=limit, child_id=child_id)


@admin_router.post("/tasks/{task_id}/void")
async def admin_void_task(
    task_id: str,
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    task.status = "voided"
    task.active_started_at = None
    task.updated_at = utc_now_iso()
    await db.commit()
    log_event("admin.task_voided", f"管理员在后台作废任务: {task.title}", childId=task.child_id, taskId=task_id)
    return {"voided": True, "taskId": task_id}


class RotateMediaRequest(BaseModel):
    degreesCw: int = Field(..., description="90, 180, or 270")


async def rotate_task_image_in_store(
    db: AsyncSession,
    image_id: str,
    degrees_cw: int,
    actor: str,
) -> dict:
    deg = degrees_cw % 360
    if deg not in {90, 180, 270}:
        raise HTTPException(status_code=400, detail="旋转角度仅支持 90、180 或 270 度")
    img_row = await db.get(TaskImageModel, image_id)
    if not img_row:
        raise HTTPException(status_code=404, detail="作业图片不存在")
    raw_bytes, _ = await minio_gateway.get_object_bytes(img_row.minio_key)
    rotated_bytes, new_w, new_h = rotate_jpeg_clockwise(raw_bytes, deg)
    await minio_gateway.put_bytes(img_row.minio_key, rotated_bytes, "image/jpeg")
    img_row.width = new_w
    img_row.height = new_h
    img_row.file_size = len(rotated_bytes)
    boxes = json.loads(img_row.ocr_boxes_json or "[]")
    if boxes:
        img_row.ocr_boxes_json = json.dumps(
            rotate_ocr_boxes_clockwise(boxes, deg),
            ensure_ascii=False,
        )
    await db.commit()
    bust = int(time.time() * 1000)
    log_event(
        "homework.image_rotated",
        f"手动旋转放正作业原图 ({deg}°): {image_id}",
        actor=actor,
        childId=img_row.child_id,
        taskId=img_row.task_id,
        imageId=image_id,
        degreesCw=deg,
    )
    return {
        "imageId": image_id,
        "width": new_w,
        "height": new_h,
        "imageUrl": f"/api/v1/media/{img_row.minio_key}?v={bust}",
    }


async def rotate_mistake_crop_in_store(
    db: AsyncSession,
    mistake_id: str,
    degrees_cw: int,
    actor: str,
) -> dict:
    deg = degrees_cw % 360
    if deg not in {90, 180, 270}:
        raise HTTPException(status_code=400, detail="旋转角度仅支持 90、180 或 270 度")
    m_row = await db.get(MistakeModel, mistake_id)
    if not m_row or not m_row.crop_minio_key:
        raise HTTPException(status_code=404, detail="错题裁切图片不存在")
    raw_bytes, _ = await minio_gateway.get_object_bytes(m_row.crop_minio_key)
    rotated_bytes, new_w, new_h = rotate_jpeg_clockwise(raw_bytes, deg)
    bust = int(time.time() * 1000)
    new_crop_key = f"ocr-crops/{m_row.child_id}/{mistake_id}-r{bust}.jpg"
    await minio_gateway.put_bytes(new_crop_key, rotated_bytes, "image/jpeg")
    m_row.crop_minio_key = new_crop_key
    await db.commit()
    log_event(
        "homework.mistake_crop_rotated",
        f"手动旋转放正错题裁切图 ({deg}°): {mistake_id}",
        actor=actor,
        childId=m_row.child_id,
        taskId=m_row.task_id,
        mistakeId=mistake_id,
        degreesCw=deg,
    )
    return {
        "mistakeId": mistake_id,
        "width": new_w,
        "height": new_h,
        "cropImageUrl": f"/api/v1/media/{new_crop_key}",
    }


@admin_router.post("/images/{image_id}/rotate")
async def admin_rotate_task_image(
    image_id: str,
    req: RotateMediaRequest,
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    return await rotate_task_image_in_store(db, image_id, req.degreesCw, actor="admin")


@admin_router.post("/mistakes/{mistake_id}/rotate-crop")
async def admin_rotate_mistake_crop(
    mistake_id: str,
    req: RotateMediaRequest,
    _auth: None = Depends(require_admin_token),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    return await rotate_mistake_crop_in_store(db, mistake_id, req.degreesCw, actor="admin")
