import hashlib
from fastapi import APIRouter, Depends, Form, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_db_session
from ..models import DailyEvalModel, MistakeModel, TaskModel
from ..providers.deepseek_tools import synthesize_tts_via_deepseek
from ..providers.minio_store import minio_gateway
from .audit_logger import log_event

tts_router = APIRouter()


def compute_tts_cache_key(text: str, voice_id: str = "stella", prefix: str = "on-demand") -> str:
    normalized = " ".join(text.strip().split())
    digest = hashlib.sha256(f"{voice_id}:{normalized}".encode("utf-8")).hexdigest()[:24]
    return f"audio-tts/{prefix}-{digest}.wav"


async def get_or_synthesize_tts_key(
    text: str,
    voice_id: str = "stella",
    prefix: str = "on-demand",
) -> tuple[str, bool]:
    cleaned = " ".join(text.strip().split())
    if not cleaned:
        raise HTTPException(status_code=400, detail="待合成朗读文本为空")

    cache_key = compute_tts_cache_key(cleaned, voice_id=voice_id, prefix=prefix)
    try:
        existing_bytes, _ = await minio_gateway.get_object_bytes(cache_key)
        if existing_bytes:
            log_event(
                "ai.tts_cache_hit",
                "命中已缓存语音，跳过重复合成计费",
                cacheKey=cache_key,
                textLen=len(cleaned),
            )
            return cache_key, True
    except Exception:
        pass

    wav_bytes = await synthesize_tts_via_deepseek(cleaned, voice_id=voice_id)
    await minio_gateway.put_bytes(cache_key, wav_bytes, "audio/wav")
    return cache_key, False


@tts_router.post("/api/v1/tts/speak")
async def speak_on_demand_endpoint(
    text: str = Form(""),
    voice_id: str = Form("stella"),
    bind_kind: str = Form(""),
    bind_id: str = Form(""),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    resolved_text = text.strip()
    target_task: TaskModel | None = None
    target_mistake: MistakeModel | None = None
    target_eval: DailyEvalModel | None = None

    if bind_kind == "task_praise" and bind_id:
        target_task = await db.get(TaskModel, bind_id)
        if target_task:
            if target_task.praise_tts_key:
                return {
                    "audioUrl": f"/api/v1/media/{target_task.praise_tts_key}",
                    "cached": True,
                }
            if not resolved_text and target_task.ai_quick_praise:
                resolved_text = target_task.ai_quick_praise
    elif bind_kind == "mistake_explain" and bind_id:
        target_mistake = await db.get(MistakeModel, bind_id)
        if target_mistake:
            if target_mistake.tts_minio_key:
                return {
                    "audioUrl": f"/api/v1/media/{target_mistake.tts_minio_key}",
                    "cached": True,
                }
            if not resolved_text:
                import json

                steps = json.loads(target_mistake.correct_steps_json or "[]")
                resolved_text = (
                    f"{target_mistake.question_title}。"
                    f"{target_mistake.error_cause}。"
                    f"{'；'.join(str(s) for s in steps)}"
                )
    elif bind_kind == "daily_eval" and bind_id:
        target_eval = await db.get(DailyEvalModel, bind_id)
        if target_eval:
            if target_eval.tts_minio_key:
                return {
                    "audioUrl": f"/api/v1/media/{target_eval.tts_minio_key}",
                    "cached": True,
                }
            if not resolved_text:
                import json

                sentences = json.loads(target_eval.child_sentences_json or "[]")
                resolved_text = " ".join(str(s) for s in sentences)

    if not resolved_text:
        raise HTTPException(status_code=400, detail="待合成朗读文本为空")

    tts_key, hit = await get_or_synthesize_tts_key(resolved_text, voice_id=voice_id)

    if target_task is not None and not target_task.praise_tts_key:
        target_task.praise_tts_key = tts_key
        await db.commit()
    elif target_mistake is not None and not target_mistake.tts_minio_key:
        target_mistake.tts_minio_key = tts_key
        await db.commit()
    elif target_eval is not None and not target_eval.tts_minio_key:
        target_eval.tts_minio_key = tts_key
        await db.commit()

    return {"audioUrl": f"/api/v1/media/{tts_key}", "cached": hit}
