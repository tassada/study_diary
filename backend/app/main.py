import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import time
import uuid
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession
from .database import AsyncSessionLocal, Base, engine, get_db_session
from .models import (
    AsyncJobModel,
    ChildModel,
    DailyEvalModel,
    MistakeModel,
    TaskImageModel,
    TaskModel,
    utc_now_iso,
)
from .providers.deepseek_tools import transcribe_wav_via_deepseek
from .providers.minio_store import minio_gateway
from .schemas import (
    AsyncJobOut,
    BatchCreateTasksRequest,
    ChildProfileOut,
    DailyEvaluationOut,
    MistakeCardOut,
    OcrBoxOut,
    ScoringRubricSchema,
    SubmitHomeworkTriggerRequest,
    TaskImageOut,
    TaskOut,
    UpdateTaskModeRequest,
    VoiceParseRequest,
    VoiceParseResponse,
    VoiceTaskDraftSchema,
)
from .services.admin_service import (
    RotateMediaRequest,
    admin_router,
    rotate_mistake_crop_in_store,
    rotate_task_image_in_store,
)
from .services.async_worker import (
    execute_daily_evaluation_job,
    execute_homework_review_job,
    parse_voice_tasks_with_dsh,
)
from .services.attention_service import attention_router
from .services.audit_logger import (
    audit_router,
    log_event,
    register_observability,
    setup_logging,
)
from .services.dictionary_service import dictionary_router
from .services.dsh_supervisor import dispatch_recovered_job, job_supervisor
from .services.image_pipeline import normalize_homework_image
from .services.seed_service import seed_builtin_children
from .services.timer_service import (
    compute_live_actual_seconds,
    enforce_idle_auto_pause_for_child,
    heartbeat_task_timer,
    pause_task_timer,
    settle_timer_for_submission,
    start_task_timer,
)
from .services.tts_cache_service import tts_router


def media_url(minio_key: str | None) -> str | None:
    if not minio_key:
        return None
    return f"/api/v1/media/{minio_key}"


async def serialize_task(db: AsyncSession, task: TaskModel) -> TaskOut:
    img_res = await db.execute(
        select(TaskImageModel)
        .where(TaskImageModel.task_id == task.id)
        .order_by(TaskImageModel.created_at.asc())
    )
    images = list(img_res.scalars().all())

    m_res = await db.execute(
        select(MistakeModel)
        .where(MistakeModel.task_id == task.id)
        .order_by(MistakeModel.created_at.asc())
    )
    mistakes = list(m_res.scalars().all())

    rubric_raw = json.loads(task.scoring_rubric_json or "{}")
    rubric = ScoringRubricSchema(
        focus=int(rubric_raw.get("focus", 30)),
        completeness=int(rubric_raw.get("completeness", 30)),
        accuracy=int(rubric_raw.get("accuracy", 40)),
    )

    image_outs = [
        TaskImageOut(
            id=im.id,
            uploadKind=im.upload_kind,
            fileName=im.file_name,
            imageUrl=f"{media_url(im.minio_key)}?v={im.width}x{im.height}x{im.file_size}"
            if im.minio_key
            else "",
            width=im.width,
            height=im.height,
            fileSize=im.file_size,
            ocrStatus=im.ocr_status,
            ocrRawText=im.ocr_raw_text,
            ocrPlainText=im.ocr_plain_text,
            boxes=[OcrBoxOut(**b) for b in json.loads(im.ocr_boxes_json or "[]")],
            ocrProcessedAt=im.ocr_processed_at,
            createdAt=im.created_at,
        )
        for im in images
    ]

    mistake_outs = [
        MistakeCardOut(
            id=m.id,
            imageId=m.image_id,
            questionTitle=m.question_title,
            wrongSnippet=m.wrong_snippet,
            errorCause=m.error_cause,
            correctSteps=json.loads(m.correct_steps_json or "[]"),
            practiceQuestion=m.practice_question,
            practiceAnswer=m.practice_answer,
            cropImageUrl=media_url(m.crop_minio_key),
            diagramImageUrl=media_url(m.diagram_minio_key),
            ttsAudioUrl=media_url(m.tts_minio_key),
            masteryStatus=m.mastery_status,
        )
        for m in mistakes
    ]

    latest_job_status: str | None = None
    latest_job_error: str | None = None
    if task.latest_job_id:
        latest_job = await db.get(AsyncJobModel, task.latest_job_id)
        if latest_job:
            latest_job_status = latest_job.status
            latest_job_error = latest_job.error_detail

    return TaskOut(
        id=task.id,
        childId=task.child_id,
        taskDate=task.task_date,
        title=task.title,
        rawVoiceText=task.raw_voice_text,
        voiceAudioUrl=media_url(task.voice_minio_key),
        plannedStartTime=task.planned_start_time,
        timerMode=task.timer_mode,
        timerLocked=task.timer_locked,
        plannedDurationSec=task.planned_duration_sec,
        actualDurationSec=compute_live_actual_seconds(task),
        pauseCount=task.pause_count,
        subject=task.subject,
        categoryTags=json.loads(task.category_tags_json or "[]"),
        difficulty=task.difficulty,
        maxScore=100,
        rewardStars=task.reward_stars,
        scoringRubric=rubric,
        scoreHint=task.score_hint,
        initialScore=task.initial_score,
        earnedScore=task.earned_score,
        revisionCount=task.revision_count,
        aiQuickPraise=task.ai_quick_praise,
        praiseAudioUrl=media_url(task.praise_tts_key),
        summaryVoiceText=task.summary_voice_text,
        summaryAudioUrl=media_url(task.summary_audio_key),
        status=task.status,
        activeStartedAt=task.active_started_at,
        autoPausedReason=task.auto_paused_reason,
        latestJobId=task.latest_job_id,
        latestJobStatus=latest_job_status,
        latestJobError=latest_job_error,
        images=image_outs,
        mistakes=mistake_outs,
        updatedAt=task.updated_at,
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    setup_logging()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await minio_gateway.ensure_bucket()
    async with AsyncSessionLocal() as db:
        await seed_builtin_children(db)
    job_supervisor.start(asyncio.get_running_loop(), dispatch_recovered_job)
    log_event("system.startup", "StudyDiary 后端服务启动就绪")
    try:
        yield
    finally:
        job_supervisor.stop()
        log_event("system.shutdown", "StudyDiary 后端服务正在关闭")


app = FastAPI(title="StudyDiary Backend API", version="2.0.0", lifespan=lifespan)

register_observability(app)
app.include_router(audit_router)
app.include_router(tts_router)
app.include_router(dictionary_router)
app.include_router(attention_router)
app.include_router(admin_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/v1/health")
async def health_check() -> dict:
    await minio_gateway.ensure_bucket()
    return {"status": "ok"}


@app.get("/api/v1/media/{object_key:path}")
async def serve_minio_media(object_key: str, request: Request) -> Response:
    try:
        content, content_type = await minio_gateway.get_object_bytes(object_key)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"媒体文件不存在: {object_key}") from exc
    etag = f'"{hashlib.md5(content).hexdigest()}"'
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={"ETag": etag, "Cache-Control": "public, max-age=0, must-revalidate"},
        )
    return Response(
        content=content,
        media_type=content_type,
        headers={"ETag": etag, "Cache-Control": "public, max-age=0, must-revalidate"},
    )


@app.get("/api/v1/children", response_model=list[ChildProfileOut])
async def list_children(db: AsyncSession = Depends(get_db_session)) -> list[ChildProfileOut]:
    res = await db.execute(select(ChildModel).order_by(ChildModel.created_at.asc()))
    rows = list(res.scalars().all())
    return [
        ChildProfileOut(
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
        )
        for c in rows
    ]


@app.get("/api/v1/children/{child_id}/calendar")
async def get_child_calendar(
    child_id: str,
    start: str = Query(...),
    end: str = Query(...),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    await enforce_idle_auto_pause_for_child(db, child_id)
    t_res = await db.execute(
        select(TaskModel).where(
            TaskModel.child_id == child_id,
            TaskModel.task_date >= start,
            TaskModel.task_date <= end,
            TaskModel.status != "voided",
        )
    )
    tasks = list(t_res.scalars().all())

    e_res = await db.execute(
        select(DailyEvalModel).where(
            DailyEvalModel.child_id == child_id,
            DailyEvalModel.eval_date >= start,
            DailyEvalModel.eval_date <= end,
        )
    )
    evals = {e.eval_date: e for e in e_res.scalars().all()}

    days: dict[str, dict] = {}
    for t in tasks:
        entry = days.setdefault(
            t.task_date,
            {"total": 0, "done": 0, "minutes": 0, "evalScore": None, "badgeRank": None},
        )
        entry["total"] += 1
        if t.status == "completed":
            entry["done"] += 1
            entry["minutes"] += max(1, round(t.actual_duration_sec / 60))

    for d_str, ev in evals.items():
        entry = days.setdefault(
            d_str,
            {"total": 0, "done": 0, "minutes": 0, "evalScore": None, "badgeRank": None},
        )
        entry["evalScore"] = ev.total_score
        entry["badgeRank"] = ev.badge_rank

    return {"days": days}


@app.get("/api/v1/children/{child_id}/timeline", response_model=list[TaskOut])
async def get_child_timeline(
    child_id: str,
    date: str = Query(...),
    db: AsyncSession = Depends(get_db_session),
) -> list[TaskOut]:
    await enforce_idle_auto_pause_for_child(db, child_id)
    res = await db.execute(
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
    tasks = list(res.scalars().all())
    return [await serialize_task(db, t) for t in tasks]


@app.post("/api/v1/asr/transcribe")
async def upload_and_transcribe_voice(
    child_id: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="上传的录音文件为空")

    asr_res = await transcribe_wav_via_deepseek(raw_bytes, file.filename or "speech.wav")
    minio_key = f"audio-asr/{child_id}/{uuid.uuid4().hex[:14]}.wav"
    await minio_gateway.put_bytes(minio_key, asr_res["normalized_wav"], "audio/wav")

    return {
        "transcript": asr_res["text"],
        "durationMs": asr_res["duration_ms"],
        "audioMinioKey": minio_key,
        "audioUrl": media_url(minio_key),
    }


@app.post("/api/v1/children/{child_id}/tasks/voice-parse", response_model=VoiceParseResponse)
async def parse_voice_to_task_drafts(
    child_id: str,
    req: VoiceParseRequest,
    db: AsyncSession = Depends(get_db_session),
) -> VoiceParseResponse:
    child = await db.get(ChildModel, child_id)
    if not child:
        raise HTTPException(status_code=404, detail="儿童档案不存在")

    transcript = req.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="语音识别文本为空，请重新说话")

    parsed = await parse_voice_tasks_with_dsh(
        child,
        transcript=transcript,
        target_date=req.targetDate,
        existing_drafts=[d.model_dump() for d in req.existingDrafts] if req.existingDrafts else None,
        is_refinement=req.isRefinement,
    )
    if parsed.get("newSessionId"):
        child.dsh_tutor_session_id = parsed["newSessionId"]
        await db.commit()

    draft_objs: list[VoiceTaskDraftSchema] = []
    for idx, raw_d in enumerate(parsed["drafts"]):
        rubric_dict = raw_d.get("scoringRubric") or {"focus": 30, "completeness": 30, "accuracy": 40}
        diff = max(1, min(3, int(raw_d.get("difficulty", 2))))
        stars = int(raw_d.get("rewardStars") or (20 if diff == 1 else 30 if diff == 2 else 50))
        mins = max(5, min(120, int(raw_d.get("plannedDurationMinutes", 25))))
        draft_objs.append(
            VoiceTaskDraftSchema(
                draftId=str(raw_d.get("draftId") or f"draft-{idx + 1}"),
                title=str(raw_d.get("title") or "学习闯关任务"),
                plannedStartTime="",
                timerMode="stopwatch" if raw_d.get("timerMode") == "stopwatch" else "countdown",
                plannedDurationMinutes=mins,
                subject=str(raw_d.get("subject") or "chinese"),
                categoryTags=[str(x) for x in (raw_d.get("categoryTags") or ["日常作业"])][:2],
                difficulty=diff,
                rewardStars=stars,
                scoringRubric=ScoringRubricSchema(**rubric_dict),
                scoreHint=str(
                    raw_d.get("scoreHint")
                    or f"独立100分制（专注30+完整30+准确40），通关奖励 {stars} 星莓币！"
                ),
            )
        )

    return VoiceParseResponse(
        transcript=transcript,
        spokenReply=parsed["spokenReply"],
        ttsAudioUrl=media_url(parsed["ttsMinioKey"]),
        drafts=draft_objs,
    )


@app.post("/api/v1/children/{child_id}/tasks/batch", response_model=list[TaskOut])
async def create_tasks_batch(
    child_id: str,
    req: BatchCreateTasksRequest,
    db: AsyncSession = Depends(get_db_session),
) -> list[TaskOut]:
    child = await db.get(ChildModel, child_id)
    if not child:
        raise HTTPException(status_code=404, detail="儿童档案不存在")

    created_rows: list[TaskModel] = []
    for idx, d in enumerate(req.drafts):
        row = TaskModel(
            id=f"task-{uuid.uuid4().hex[:12]}-{idx}",
            child_id=child_id,
            task_date=req.targetDate,
            title=d.title,
            raw_voice_text=req.rawTranscript,
            voice_minio_key=req.voiceMinioKey,
            planned_start_time="",
            timer_mode=d.timerMode,
            timer_locked=False,
            planned_duration_sec=d.plannedDurationMinutes * 60,
            actual_duration_sec=0,
            pause_count=0,
            subject=d.subject,
            category_tags_json=json.dumps(d.categoryTags, ensure_ascii=False),
            difficulty=d.difficulty,
            reward_stars=d.rewardStars,
            scoring_rubric_json=json.dumps(d.scoringRubric.model_dump(), ensure_ascii=False),
            score_hint=d.scoreHint,
            status="pending",
            updated_at=utc_now_iso(),
        )
        db.add(row)
        created_rows.append(row)

    await db.commit()
    log_event(
        "task.batch_created",
        f"新增 {len(created_rows)} 项学习任务 ({req.targetDate})",
        childId=child_id,
        targetDate=req.targetDate,
        count=len(created_rows),
        titles=[r.title for r in created_rows],
    )
    return [await serialize_task(db, r) for r in created_rows]


@app.patch("/api/v1/tasks/{task_id}/mode", response_model=TaskOut)
async def switch_task_timer_mode(
    task_id: str,
    req: UpdateTaskModeRequest,
    db: AsyncSession = Depends(get_db_session),
) -> TaskOut:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.timer_locked or task.actual_duration_sec > 0 or task.status != "pending":
        raise HTTPException(status_code=409, detail="计时一旦开始即锁定模式，不可切换正/倒计时")
    if req.timerMode not in {"countdown", "stopwatch"}:
        raise HTTPException(status_code=400, detail="不支持的计时模式")

    task.timer_mode = req.timerMode
    task.updated_at = utc_now_iso()
    await db.commit()
    await db.refresh(task)
    return await serialize_task(db, task)


@app.delete("/api/v1/tasks/{task_id}")
async def delete_or_void_task(
    task_id: str,
    actor: str = Query("child"),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    if (task.timer_locked or task.actual_duration_sec > 0 or task.status != "pending") and actor != "parent":
        raise HTTPException(
            status_code=403,
            detail="计时一旦开始，儿童端不能删除该任务（仅家长屋可作废异常任务）",
        )

    task.status = "voided"
    task.active_started_at = None
    task.updated_at = utc_now_iso()
    await db.commit()
    log_event(
        "task.voided",
        f"任务已删除/作废: {task.title}",
        childId=task.child_id,
        taskId=task_id,
        actor=actor,
    )
    return {"voided": True, "taskId": task_id}


@app.post("/api/v1/tasks/{task_id}/timer/start", response_model=TaskOut)
async def api_start_timer(
    task_id: str,
    db: AsyncSession = Depends(get_db_session),
) -> TaskOut:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    updated = await start_task_timer(db, task)
    return await serialize_task(db, updated)


@app.post("/api/v1/tasks/{task_id}/timer/heartbeat", response_model=TaskOut)
async def api_heartbeat_timer(
    task_id: str,
    db: AsyncSession = Depends(get_db_session),
) -> TaskOut:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    updated = await heartbeat_task_timer(db, task)
    return await serialize_task(db, updated)


@app.post("/api/v1/tasks/{task_id}/timer/pause", response_model=TaskOut)
async def api_pause_timer(
    task_id: str,
    db: AsyncSession = Depends(get_db_session),
) -> TaskOut:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    updated = await pause_task_timer(db, task)
    return await serialize_task(db, updated)


@app.post("/api/v1/tasks/{task_id}/images/upload", response_model=list[TaskImageOut])
async def upload_homework_images_to_minio(
    task_id: str,
    upload_kind: str = Form("initial"),
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db_session),
) -> list[TaskImageOut]:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if not files:
        raise HTTPException(status_code=400, detail="请至少选择一张作业照片")

    saved_rows: list[TaskImageModel] = []
    for f in files:
        raw_bytes = await f.read()
        if not raw_bytes:
            continue
        jpeg_bytes, w, h = normalize_homework_image(raw_bytes, max_edge=1600)
        img_id = f"img-{uuid.uuid4().hex[:12]}"
        minio_key = f"homework-raw/{task.child_id}/{task.id}/{img_id}.jpg"
        await minio_gateway.put_bytes(minio_key, jpeg_bytes, "image/jpeg")

        row = TaskImageModel(
            id=img_id,
            task_id=task.id,
            child_id=task.child_id,
            upload_kind=upload_kind,
            file_name=f.filename or f"{img_id}.jpg",
            minio_key=minio_key,
            content_type="image/jpeg",
            file_size=len(jpeg_bytes),
            width=w,
            height=h,
            ocr_status="pending",
            created_at=utc_now_iso(),
        )
        db.add(row)
        saved_rows.append(row)

    task.updated_at = utc_now_iso()
    await db.commit()
    log_event(
        "homework.images_uploaded",
        f"上传 {len(saved_rows)} 张作业图 ({upload_kind})",
        childId=task.child_id,
        taskId=task.id,
        uploadKind=upload_kind,
        count=len(saved_rows),
        totalBytes=sum(r.file_size for r in saved_rows),
    )

    return [
        TaskImageOut(
            id=r.id,
            uploadKind=r.upload_kind,
            fileName=r.file_name,
            imageUrl=media_url(r.minio_key) or "",
            width=r.width,
            height=r.height,
            fileSize=r.file_size,
            ocrStatus=r.ocr_status,
            ocrRawText="",
            ocrPlainText="",
            boxes=[],
            createdAt=r.created_at,
        )
        for r in saved_rows
    ]


@app.post("/api/v1/tasks/{task_id}/submit", response_model=AsyncJobOut)
async def trigger_async_homework_review(
    task_id: str,
    req: SubmitHomeworkTriggerRequest,
    db: AsyncSession = Depends(get_db_session),
) -> AsyncJobOut:
    task = await db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    await settle_timer_for_submission(db, task)

    if req.summaryVoiceText.strip():
        task.summary_voice_text = req.summaryVoiceText.strip()
    if req.summaryAudioKey:
        task.summary_audio_key = req.summaryAudioKey

    job_id = f"job-{uuid.uuid4().hex[:12]}"
    job = AsyncJobModel(
        id=job_id,
        child_id=task.child_id,
        task_id=task.id,
        job_type="homework_review",
        status="queued",
        progress_text="已收到作业，正在准备单图 OCR 与专属 DSH 错题讲解...",
        created_at=utc_now_iso(),
    )
    db.add(job)
    task.latest_job_id = job_id
    task.updated_at = utc_now_iso()
    await db.commit()
    await db.refresh(job)
    log_event(
        "homework.review_queued",
        f"提交作业异步批阅: {task.title}",
        jobId=job_id,
        childId=task.child_id,
        taskId=task.id,
        uploadKind=req.uploadKind,
    )

    asyncio.create_task(execute_homework_review_job(job_id, task.id, req.uploadKind))

    return AsyncJobOut(
        id=job.id,
        childId=job.child_id,
        taskId=job.task_id,
        evalDate=job.eval_date,
        jobType=job.job_type,
        status=job.status,
        progressText=job.progress_text,
        errorDetail=job.error_detail,
        createdAt=job.created_at,
        finishedAt=job.finished_at,
    )


@app.get("/api/v1/jobs/{job_id}", response_model=AsyncJobOut)
async def get_async_job_status(
    job_id: str,
    db: AsyncSession = Depends(get_db_session),
) -> AsyncJobOut:
    job = await db.get(AsyncJobModel, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="异步任务不存在")
    return AsyncJobOut(
        id=job.id,
        childId=job.child_id,
        taskId=job.task_id,
        evalDate=job.eval_date,
        jobType=job.job_type,
        status=job.status,
        progressText=job.progress_text,
        errorDetail=job.error_detail,
        createdAt=job.created_at,
        finishedAt=job.finished_at,
    )


@app.get("/api/v1/children/{child_id}/evaluations/{eval_date}", response_model=DailyEvaluationOut | None)
async def get_daily_evaluation(
    child_id: str,
    eval_date: str,
    db: AsyncSession = Depends(get_db_session),
) -> DailyEvaluationOut | None:
    res = await db.execute(
        select(DailyEvalModel).where(
            DailyEvalModel.child_id == child_id,
            DailyEvalModel.eval_date == eval_date,
        )
    )
    ev = res.scalar_one_or_none()
    if not ev:
        return None

    t_res = await db.execute(
        select(TaskModel).where(
            TaskModel.child_id == child_id,
            TaskModel.task_date == eval_date,
            TaskModel.status == "completed",
        )
    )
    completed_tasks = list(t_res.scalars().all())
    latest_task_iso = max((t.updated_at for t in completed_tasks), default="")
    has_new_progress = bool(latest_task_iso and latest_task_iso > ev.evaluated_watermark_iso)

    return DailyEvaluationOut(
        childId=ev.child_id,
        evalDate=ev.eval_date,
        totalScore=ev.total_score,
        dimensionScores=json.loads(ev.dimension_scores_json),
        badgeRank=ev.badge_rank,
        badgeTitle=ev.badge_title,
        childCommentarySentences=json.loads(ev.child_sentences_json),
        ttsAudioUrl=media_url(ev.tts_minio_key),
        parentSummary=ev.parent_summary,
        weakPoints=json.loads(ev.weak_points_json),
        tomorrowTips=json.loads(ev.tomorrow_tips_json),
        hasNewProgress=has_new_progress,
        updatedAt=ev.updated_at,
    )


@app.post("/api/v1/children/{child_id}/evaluations/{eval_date}/generate", response_model=AsyncJobOut)
async def trigger_daily_evaluation_job(
    child_id: str,
    eval_date: str,
    db: AsyncSession = Depends(get_db_session),
) -> AsyncJobOut:
    child = await db.get(ChildModel, child_id)
    if not child:
        raise HTTPException(status_code=404, detail="儿童档案不存在")

    job_id = f"job-eval-{uuid.uuid4().hex[:10]}"
    job = AsyncJobModel(
        id=job_id,
        child_id=child_id,
        eval_date=eval_date,
        job_type="daily_evaluation",
        status="queued",
        progress_text=f"正在召唤 {child.display_name} 专属 DSH 智能体汇总今日表现...",
        created_at=utc_now_iso(),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    log_event(
        "daily_eval.queued",
        f"触发每日总评生成: {eval_date}",
        jobId=job_id,
        childId=child_id,
        evalDate=eval_date,
    )

    asyncio.create_task(execute_daily_evaluation_job(job_id, child_id, eval_date))

    return AsyncJobOut(
        id=job.id,
        childId=job.child_id,
        taskId=job.task_id,
        evalDate=job.eval_date,
        jobType=job.job_type,
        status=job.status,
        progressText=job.progress_text,
        errorDetail=job.error_detail,
        createdAt=job.created_at,
        finishedAt=job.finished_at,
    )


@app.get("/api/v1/parent/tasks/{child_id}", response_model=list[TaskOut])
async def list_all_child_tasks_for_parent(
    child_id: str,
    db: AsyncSession = Depends(get_db_session),
) -> list[TaskOut]:
    res = await db.execute(
        select(TaskModel)
        .where(TaskModel.child_id == child_id, TaskModel.status != "voided")
        .order_by(
            TaskModel.task_date.desc(),
            case((TaskModel.planned_start_time == "", 1), else_=0).asc(),
            TaskModel.planned_start_time.asc(),
            TaskModel.id.asc(),
        )
    )
    rows = list(res.scalars().all())
    return [await serialize_task(db, r) for r in rows]


@app.post("/api/v1/images/{image_id}/rotate")
async def rotate_task_image_endpoint(
    image_id: str,
    req: RotateMediaRequest,
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    return await rotate_task_image_in_store(db, image_id, req.degreesCw, actor="client")


@app.post("/api/v1/mistakes/{mistake_id}/rotate-crop")
async def rotate_mistake_crop_endpoint(
    mistake_id: str,
    req: RotateMediaRequest,
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    return await rotate_mistake_crop_in_store(db, mistake_id, req.degreesCw, actor="client")
