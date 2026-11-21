import asyncio
import json
import re
import subprocess
import tempfile
from pathlib import Path
import time
import httpx
from ..config import settings
from ..services.audit_logger import log_error, log_event

OCR_TAG_PATTERN = re.compile(
    r"<｜ref｜>(.*?)<｜/ref｜><｜box｜>\[\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\]<｜/box｜>([^<]*)",
    re.DOTALL,
)


async def ensure_pcm16_wav_bytes(audio_bytes: bytes, suffix: str = ".wav") -> bytes:
    if len(audio_bytes) >= 44 and audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
        bits_per_sample = int.from_bytes(audio_bytes[34:36], "little")
        audio_format = int.from_bytes(audio_bytes[20:22], "little")
        if audio_format == 1 and bits_per_sample == 16:
            return audio_bytes

    def _convert() -> bytes:
        with tempfile.TemporaryDirectory() as tmpdir:
            in_path = Path(tmpdir) / f"in{suffix}"
            out_path = Path(tmpdir) / "out.wav"
            in_path.write_bytes(audio_bytes)
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(in_path),
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-sample_fmt",
                    "s16",
                    str(out_path),
                ],
                capture_output=True,
                check=False,
            )
            if proc.returncode != 0 or not out_path.exists():
                stderr_msg = proc.stderr.decode("utf-8", "ignore")[-300:]
                raise RuntimeError(f"FFmpeg 音频归一化失败: {stderr_msg}")
            return out_path.read_bytes()

    return await asyncio.to_thread(_convert)


async def transcribe_wav_via_deepseek(audio_bytes: bytes, filename: str = "speech.wav") -> dict:
    suffix = Path(filename).suffix or ".wav"
    wav_bytes = await ensure_pcm16_wav_bytes(audio_bytes, suffix)
    if len(wav_bytes) > 8 * 1024 * 1024:
        raise ValueError("语音音频超过 DeepSeek ASR 8 MiB 限制，请缩短单次录音时长")

    url = f"{settings.deepseek_tools_origin.rstrip('/')}/v1/tools/asr"
    headers = {"Authorization": f"Bearer {settings.deepseek_api_key}"}

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=15.0)) as client:
            resp = await client.post(
                url,
                headers=headers,
                files={"file": ("speech.wav", wav_bytes, "audio/wav")},
            )
            if resp.status_code != 200:
                raise RuntimeError(f"DeepSeek ASR 返回 HTTP {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            text_out = str(data.get("text", "")).strip()
            dur_ms = int(data.get("duration_ms", 0))
            log_event(
                "ai.deepseek_asr",
                "DeepSeek ASR 语音识别完成",
                fileName=filename,
                wavBytes=len(wav_bytes),
                audioDurationMs=dur_ms,
                transcriptPreview=text_out[:120],
                elapsedMs=round((time.perf_counter() - started) * 1000, 1),
            )
            return {
                "request_id": data.get("request_id", ""),
                "text": text_out,
                "duration_ms": dur_ms,
                "normalized_wav": wav_bytes,
            }
    except Exception as exc:
        log_error(
            "ai.deepseek_asr_failed",
            f"DeepSeek ASR 调用失败 ({filename})",
            exc=exc,
            fileName=filename,
            wavBytes=len(wav_bytes),
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise


def humanize_ocr_latex(text: str) -> str:
    s = re.sub(r"\\text\{([^}]*)\}", r"\1", text)
    s = s.replace("\\times", "×").replace("\\div", "÷").replace("\\cdot", "·")
    s = s.replace("$$", "").replace("$", "")
    return re.sub(r"[ \t]{2,}", " ", s).strip()


def parse_deepseek_ocr_text(raw_text: str) -> tuple[str, list[dict]]:
    boxes: list[dict] = []
    for idx, match in enumerate(OCR_TAG_PATTERN.finditer(raw_text)):
        kind_label = re.sub(r"\s+", " ", match.group(1)).strip()
        coords = [
            max(0, min(1000, int(match.group(2)))),
            max(0, min(1000, int(match.group(3)))),
            max(0, min(1000, int(match.group(4)))),
            max(0, min(1000, int(match.group(5)))),
        ]
        trailing_snippet = humanize_ocr_latex(match.group(6))
        display_label = trailing_snippet[:48] if trailing_snippet else (kind_label or f"区域 {idx + 1}")
        boxes.append(
            {
                "id": f"ocr-box-{idx}",
                "refLabel": display_label,
                "box": coords,
                "statusTag": "correct",
            }
        )

    plain = re.sub(
        r"<｜ref｜>.*?<｜/ref｜><｜box｜>\[\[.*?\]\]<｜/box｜>\s*",
        "",
        raw_text,
        flags=re.DOTALL,
    )
    plain = humanize_ocr_latex(plain)
    plain = re.sub(r"\n{3,}", "\n\n", plain).strip()
    return plain, boxes


async def recognize_image_via_deepseek_ocr(image_bytes: bytes, filename: str = "homework.jpg") -> dict:
    url = f"{settings.deepseek_tools_origin.rstrip('/')}/v1/tools/ocr"
    headers = {"Authorization": f"Bearer {settings.deepseek_api_key}"}

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as client:
            resp = await client.post(
                url,
                headers=headers,
                data={"purpose": "rich_layout_recognition"},
                files={"file": (filename, image_bytes, "image/jpeg")},
            )
            body_text = resp.text.strip()
            if resp.status_code != 200:
                raise RuntimeError(f"DeepSeek OCR HTTP {resp.status_code}: {body_text[:300]}")

            parsed = json.loads(body_text)
            if "error" in parsed and parsed["error"]:
                err_msg = parsed["error"].get("message", "Unknown OCR error")
                raise RuntimeError(f"DeepSeek OCR 识别失败: {err_msg}")

            pages = parsed.get("pages") or []
            merged_raw = "\n".join(str(p.get("text", "")) for p in pages)
            plain_text, boxes = parse_deepseek_ocr_text(merged_raw)
            log_event(
                "ai.deepseek_ocr",
                "DeepSeek OCR 单图识别完成",
                fileName=filename,
                imageBytes=len(image_bytes),
                boxCount=len(boxes),
                textLen=len(plain_text),
                elapsedMs=round((time.perf_counter() - started) * 1000, 1),
            )
            return {
                "ocr_id": parsed.get("id", ""),
                "raw_text": merged_raw,
                "plain_text": plain_text,
                "boxes": boxes,
            }
    except Exception as exc:
        log_error(
            "ai.deepseek_ocr_failed",
            f"DeepSeek OCR 调用失败 ({filename})",
            exc=exc,
            fileName=filename,
            imageBytes=len(image_bytes),
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise


async def synthesize_tts_via_deepseek(text: str, voice_id: str = "stella") -> bytes:
    clean_text = text.strip()
    if not clean_text:
        raise ValueError("TTS 朗读文本不能为空")

    url = f"{settings.deepseek_tools_origin.rstrip('/')}/v1/tools/tts"
    headers = {
        "Authorization": f"Bearer {settings.deepseek_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "text": clean_text[:4500],
        "voice_id": voice_id,
        "format": "wav",
        "filter_markdown": True,
    }

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"DeepSeek TTS HTTP {resp.status_code}: {resp.text[:300]}")
            audio = resp.content
            if len(audio) < 100:
                raise RuntimeError("DeepSeek TTS 返回音频数据异常过短")
            log_event(
                "ai.deepseek_tts",
                "DeepSeek TTS 语音合成完成",
                voiceId=voice_id,
                textLen=len(clean_text),
                wavBytes=len(audio),
                elapsedMs=round((time.perf_counter() - started) * 1000, 1),
            )
            return audio
    except Exception as exc:
        log_error(
            "ai.deepseek_tts_failed",
            "DeepSeek TTS 调用失败",
            exc=exc,
            voiceId=voice_id,
            textLen=len(clean_text),
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise
