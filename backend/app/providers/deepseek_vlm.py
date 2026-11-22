import base64
import json
import time
from typing import Any
import httpx
from ..config import settings
from ..services.audit_logger import log_error, log_event, log_warn
from .dsh_agent import extract_json_object

VLM_MODEL_ID = "deepseek-flash"


def parse_vlm_json_object(raw_text: str) -> dict[str, Any]:
    try:
        return extract_json_object(raw_text)
    except ValueError as exc:
        cleaned = (raw_text or "").strip()
        raise ValueError(f"DeepSeek-V4.1-Flash 未返回合法 JSON 结构: {cleaned[:300]}") from exc


async def call_deepseek_vlm_json(
    prompt_text: str,
    images: list[tuple[str, bytes]],
    system_prompt: str = "",
    max_tokens: int = 32768,
    timeout_sec: float = 240.0,
    reasoning_effort: str | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    url = f"{settings.deepseek_tools_origin.rstrip('/')}/v1/chat/completions"

    user_content: list[dict[str, Any]] = []
    for idx, (label, img_bytes) in enumerate(images):
        b64 = base64.b64encode(img_bytes).decode("ascii")
        user_content.append(
            {
                "type": "text",
                "text": f"【图像 {idx + 1}：{label}】",
            }
        )
        user_content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            }
        )
    user_content.append({"type": "text", "text": prompt_text})

    messages: list[dict[str, Any]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    messages.append({"role": "user", "content": user_content})

    last_exc: Exception | None = None
    for attempt in range(1, 3):
        attempt_max_tokens = (
            max_tokens if attempt == 1 else min(131072, max(max_tokens * 2, 32768))
        )
        payload: dict[str, Any] = {
            "model": VLM_MODEL_ID,
            "messages": messages,
            "max_tokens": attempt_max_tokens,
            "response_format": {"type": "json_object"},
        }
        if reasoning_effort:
            payload["reasoning_effort"] = reasoning_effort

        try:
            transport = httpx.AsyncHTTPTransport(retries=2)
            async with httpx.AsyncClient(transport=transport, timeout=timeout_sec) as client:
                resp = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {settings.deepseek_api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            if resp.status_code >= 400:
                body_preview = resp.text[:400]
                raise RuntimeError(
                    f"DeepSeek-V4.1-Flash 接口返回 HTTP {resp.status_code}: {body_preview}"
                )

            data = resp.json()
            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError(f"DeepSeek-V4.1-Flash 返回空 choices: {str(data)[:300]}")

            choice0 = choices[0]
            finish_reason = str(choice0.get("finish_reason") or "")
            msg = choice0.get("message") or {}
            raw_content = str(msg.get("content") or "").strip()
            usage = data.get("usage") or {}
            reasoning_tokens = (usage.get("completion_tokens_details") or {}).get(
                "reasoning_tokens"
            )

            if not raw_content or finish_reason == "length":
                if raw_content:
                    try:
                        parsed = parse_vlm_json_object(raw_content)
                    except Exception as parse_err:
                        raise RuntimeError(
                            f"DeepSeek-V4.1-Flash 输出达到上限被截断 "
                            f"(finish_reason={finish_reason}, max_tokens={attempt_max_tokens}, "
                            f"completion_tokens={usage.get('completion_tokens')}, "
                            f"reasoning_tokens={reasoning_tokens})"
                        ) from parse_err
                else:
                    raise RuntimeError(
                        f"DeepSeek-V4.1-Flash 正文为空 "
                        f"(finish_reason={finish_reason}, max_tokens={attempt_max_tokens}, "
                        f"completion_tokens={usage.get('completion_tokens')}, "
                        f"reasoning_tokens={reasoning_tokens})"
                    )
            else:
                parsed = parse_vlm_json_object(raw_content)

            log_event(
                "ai.deepseek_vlm",
                f"DeepSeek-V4.1-Flash 多模态视觉推理完成 ({len(images)} 张图)",
                model=data.get("model") or VLM_MODEL_ID,
                imageCount=len(images),
                finishReason=finish_reason,
                reasoningEffort=reasoning_effort or "default",
                promptTokens=usage.get("prompt_tokens"),
                completionTokens=usage.get("completion_tokens"),
                reasoningTokens=reasoning_tokens,
                elapsedMs=round((time.perf_counter() - started) * 1000, 1),
            )
            return parsed
        except Exception as exc:
            last_exc = exc
            if attempt == 1:
                log_warn(
                    "ai.deepseek_vlm_retry",
                    f"DeepSeek-V4.1-Flash 首次请求异常，正在升级容量进行第 2 次幂等重试: {exc}",
                    imageCount=len(images),
                    nextMaxTokens=min(131072, max(max_tokens * 2, 32768)),
                )
                continue

    assert last_exc is not None
    log_error(
        "ai.deepseek_vlm_failed",
        f"DeepSeek-V4.1-Flash 多模态请求失败 ({len(images)} 张图)",
        exc=last_exc,
        imageCount=len(images),
        elapsedMs=round((time.perf_counter() - started) * 1000, 1),
    )
    raise last_exc


async def call_supervised_vlm_json(
    task_kind: str,
    prompt_text: str,
    images: list[tuple[str, bytes]],
    audit_fn: Any,
    audit_context: dict[str, Any] | None = None,
    system_prompt: str = "",
    max_tokens: int = 32768,
    timeout_sec: float = 240.0,
    reasoning_effort: str | None = None,
) -> dict[str, Any]:
    candidate: dict[str, Any] | None = None
    first_err: Exception | None = None

    try:
        candidate = await call_deepseek_vlm_json(
            prompt_text=prompt_text,
            images=images,
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            timeout_sec=timeout_sec,
            reasoning_effort=reasoning_effort,
        )
    except Exception as exc:
        first_err = exc

    issues: list[str] = (
        [f"首轮视觉推理异常: {first_err}"]
        if first_err is not None
        else audit_fn(task_kind, candidate, context=audit_context)
    )

    if not issues and candidate is not None:
        return candidate

    partial_str = (
        json.dumps(candidate, ensure_ascii=False)[:3500]
        if candidate is not None
        else "（上一会话未输出完整 JSON）"
    )
    issues_str = "\n".join(f"- {x}" for x in issues)
    repair_prompt = (
        f"【独立监督补全会话 · {task_kind}】\n"
        "请对照附带的原图与标记图，修正上一会话输出的缺漏或悬空半截问题，确保输出 100% 完整闭合。\n\n"
        f"=== 原始要求 ===\n{prompt_text}\n\n"
        f"=== 上一会话草稿 ===\n{partial_str}\n\n"
        f"=== 必须修复的问题 ===\n{issues_str}\n\n"
        "请严格只输出修复完成后的纯 JSON 对象。"
    )
    repaired = await call_deepseek_vlm_json(
        prompt_text=repair_prompt,
        images=images,
        system_prompt=system_prompt,
        max_tokens=min(131072, max(max_tokens * 2, 49152)),
        timeout_sec=max(timeout_sec, 270.0),
        reasoning_effort=reasoning_effort,
    )
    log_event(
        "ai.deepseek_vlm_supervised_repaired",
        f"DeepSeek-V4.1-Flash 监督补全会话已完成 ({task_kind})",
        taskKind=task_kind,
        fixedIssues=issues,
    )
    return repaired
