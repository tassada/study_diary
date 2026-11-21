from datetime import datetime, timezone
from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ChildModel(Base):
    __tablename__ = "children"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    birth_date: Mapped[str] = mapped_column(String(16), nullable=False)
    gender: Mapped[str] = mapped_column(String(16), nullable=False)
    age: Mapped[int] = mapped_column(Integer, nullable=False)
    grade_label: Mapped[str] = mapped_column(String(32), nullable=False)
    title_badge: Mapped[str] = mapped_column(String(64), nullable=False)
    avatar_key: Mapped[str] = mapped_column(String(32), nullable=False)
    theme_pink: Mapped[str] = mapped_column(String(16), nullable=False)
    daily_goal_minutes: Mapped[int] = mapped_column(Integer, default=80, nullable=False)
    star_coins: Mapped[int] = mapped_column(Integer, default=120, nullable=False)
    dsh_tutor_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)


class TaskModel(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    child_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    task_date: Mapped[str] = mapped_column(String(16), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    raw_voice_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    voice_minio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    planned_start_time: Mapped[str] = mapped_column(String(16), nullable=False)
    timer_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    timer_locked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    planned_duration_sec: Mapped[int] = mapped_column(Integer, nullable=False)
    actual_duration_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    pause_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    subject: Mapped[str] = mapped_column(String(32), nullable=False)
    category_tags_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    difficulty: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    reward_stars: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    scoring_rubric_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    score_hint: Mapped[str] = mapped_column(Text, default="", nullable=False)
    initial_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    earned_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revision_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ai_quick_praise: Mapped[str | None] = mapped_column(Text, nullable=True)
    praise_tts_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    summary_voice_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    summary_audio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="pending", nullable=False)
    active_started_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_heartbeat_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    auto_paused_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    latest_job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    completed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)


class TaskImageModel(Base):
    __tablename__ = "task_images"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    child_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    upload_kind: Mapped[str] = mapped_column(String(24), default="initial", nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    minio_key: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(64), default="image/jpeg", nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    width: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    height: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ocr_status: Mapped[str] = mapped_column(String(24), default="pending", nullable=False)
    ocr_raw_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ocr_plain_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ocr_boxes_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    ocr_processed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)


class MistakeModel(Base):
    __tablename__ = "mistakes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    child_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    task_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    image_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    question_title: Mapped[str] = mapped_column(String(255), nullable=False)
    wrong_snippet: Mapped[str] = mapped_column(Text, default="", nullable=False)
    error_cause: Mapped[str] = mapped_column(Text, default="", nullable=False)
    correct_steps_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    practice_question: Mapped[str] = mapped_column(Text, default="", nullable=False)
    practice_answer: Mapped[str] = mapped_column(Text, default="", nullable=False)
    crop_minio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    diagram_minio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tts_minio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mastery_status: Mapped[str] = mapped_column(String(24), default="open", nullable=False)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)
    mastered_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class AsyncJobModel(Base):
    __tablename__ = "async_jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    child_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    task_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    eval_date: Mapped[str | None] = mapped_column(String(16), nullable=True)
    job_type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="queued", nullable=False)
    progress_text: Mapped[str] = mapped_column(String(255), default="任务已进入队列...", nullable=False)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)
    finished_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class DailyEvalModel(Base):
    __tablename__ = "daily_evaluations"
    __table_args__ = (UniqueConstraint("child_id", "eval_date", name="uq_child_eval_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    child_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    eval_date: Mapped[str] = mapped_column(String(16), index=True, nullable=False)
    total_score: Mapped[int] = mapped_column(Integer, nullable=False)
    dimension_scores_json: Mapped[str] = mapped_column(Text, nullable=False)
    badge_rank: Mapped[str] = mapped_column(String(16), nullable=False)
    badge_title: Mapped[str] = mapped_column(String(64), nullable=False)
    child_sentences_json: Mapped[str] = mapped_column(Text, nullable=False)
    tts_minio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    parent_summary: Mapped[str] = mapped_column(Text, nullable=False)
    weak_points_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    tomorrow_tips_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    dsh_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    evaluated_watermark_iso: Mapped[str] = mapped_column(String(40), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)


class DictionaryLookupModel(Base):
    __tablename__ = "dictionary_lookups"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    child_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    instruction: Mapped[str] = mapped_column(Text, default="", nullable=False)
    raw_image_key: Mapped[str] = mapped_column(String(255), nullable=False)
    preview_image_key: Mapped[str] = mapped_column(String(255), nullable=False)
    entries_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)


class TaskAttentionSegmentModel(Base):
    __tablename__ = "task_attention_segments"
    __table_args__ = (
        UniqueConstraint("task_id", "segment_index", name="uq_task_attention_seg_idx"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    child_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    task_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    task_date: Mapped[str] = mapped_column(String(16), index=True, nullable=False)
    segment_index: Mapped[int] = mapped_column(Integer, nullable=False)
    start_offset_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duration_sec: Mapped[int] = mapped_column(Integer, nullable=False)
    present_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    focused_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    distracted_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    drowsy_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    near_posture_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    away_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    avg_distance_cm: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    dominant_state: Mapped[str] = mapped_column(String(24), default="focused", nullable=False)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, nullable=False)
