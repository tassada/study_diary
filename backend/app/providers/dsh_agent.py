import asyncio
import json
import os
import re
from pathlib import Path
import time
from ..config import settings
from ..models import ChildModel
from ..services.audit_logger import log_error, log_event, log_warn


def get_child_workspace(child_id: str) -> Path:
    ws = settings.data_root.resolve() / "children" / child_id
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def get_child_dsh_home(child_id: str) -> Path:
    home = settings.data_root.resolve() / "dsh_homes" / child_id
    home.mkdir(parents=True, exist_ok=True)
    return home


def ensure_child_agent_files(child: ChildModel) -> Path:
    ws = get_child_workspace(child.id)
    agents_file = ws / "AGENTS.md"
    memory_file = ws / "MEMORY.md"
    mistakes_file = ws / "mistakes.jsonl"

    if not agents_file.exists():
        agents_content = (
            f"# 专属伴学智能体 — {child.display_name}\n\n"
            f"- 学生姓名：{child.display_name}\n"
            f"- 性别：{child.gender}\n"
            f"- 出生日期：{child.birth_date}（当前 {child.age} 岁，{child.grade_label}）\n"
            "- 你的身份：温暖、耐心、专业的小学伴学导师「海星老师 Stella」。\n"
            "- 工作目录记忆契约：\n"
            "  1. 每次收到批阅作业、讲解错题或每日评价任务时，先用只读工具读取当前目录下的 `MEMORY.md` 和 `mistakes.jsonl`（若非空），结合孩子的历史薄弱点与进步轨迹给出一脉相承的反馈。\n"
            "  2. 发现新的典型错题、易混知识点或确认孩子订正掌握了旧错题时，主动更新当前目录下的 `MEMORY.md`（精炼记录学科优势、近期易错点、鼓励约定）并向 `mistakes.jsonl` 追加记录。\n"
            "  3. 最终回复必须严格按照调用提示词要求的纯 JSON 对象输出，不要包裹多余解释文字。\n"
        )
        agents_file.write_text(agents_content, encoding="utf-8")

    if not memory_file.exists():
        memory_init = (
            f"# {child.display_name} 长期学习记忆档案\n\n"
            f"- 基本信息：{child.display_name}，女，{child.birth_date} 出生，{child.grade_label}。\n"
            "- 近期优势：按计划推进学习，愿意用语音表达学习体会。\n"
            "- 关注要点：随每日作业 OCR 与订正表现动态更新。\n"
        )
        memory_file.write_text(memory_init, encoding="utf-8")

    if not mistakes_file.exists():
        mistakes_file.write_text("", encoding="utf-8")

    return ws


def extract_json_object(raw_text: str) -> dict:
    cleaned = raw_text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", cleaned, re.DOTALL)
    if fenced:
        return json.loads(fenced.group(1))
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        return json.loads(cleaned[first_brace : last_brace + 1])
    raise ValueError(f"DSH 未返回合法 JSON 结构: {cleaned[:300]}")


async def run_dsh_for_child(
    child: ChildModel,
    task_prompt: str,
    session_id: str | None = None,
) -> tuple[dict, str | None]:
    workspace_dir = ensure_child_agent_files(child)
    dsh_home = get_child_dsh_home(child.id)

    cmd = [
        settings.dsh_bin,
        "--profile",
        "headless",
        "--permission-mode",
        "workspace-write",
        "--approval-policy",
        "never",
        "--json",
    ]
    if session_id:
        cmd.extend(["--session-id", session_id])
    cmd.append(task_prompt)

    child_env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"DEEPSEEK_BASE_URL", "ANTHROPIC_BASE_URL"}
    }
    child_env["DEEPSEEK_API_KEY"] = settings.deepseek_api_key
    child_env["DSH_HOME"] = str(dsh_home)
    child_env["DSH_TELEMETRY_MODE"] = "OFF"

    started = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(workspace_dir),
        env=child_env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(),
            timeout=settings.dsh_timeout_sec,
        )
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.communicate()
        log_error(
            "ai.dsh_timeout",
            f"DSH 智能体任务超时 ({settings.dsh_timeout_sec}s)",
            exc=exc,
            childId=child.id,
            sessionId=session_id,
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise RuntimeError(f"DSH 智能体任务超时 ({settings.dsh_timeout_sec}s)") from exc

    stdout_str = stdout_bytes.decode("utf-8", "ignore")
    stderr_str = stderr_bytes.decode("utf-8", "ignore")

    final_text = ""
    returned_session_id = session_id
    error_reason = None

    for line in stdout_str.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        ev_type = event.get("type")
        if ev_type == "session" and event.get("sessionId"):
            returned_session_id = event["sessionId"]
        elif ev_type == "final":
            if event.get("sessionId"):
                returned_session_id = event["sessionId"]
            reason = event.get("reason") or {}
            if reason.get("kind") == "error":
                error_reason = (reason.get("error") or {}).get("message") or "DSH 运行异常"
            final_text = str(event.get("text") or "")

    if error_reason and session_id:
        log_warn(
            "ai.dsh_session_retry",
            f"DSH 会话恢复失败，正在新建会话重试: {error_reason}",
            childId=child.id,
            staleSessionId=session_id,
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        return await run_dsh_for_child(child, task_prompt, session_id=None)

    if error_reason:
        err = RuntimeError(f"DSH 执行报错: {error_reason} | {stderr_str[-240:]}")
        log_error(
            "ai.dsh_failed",
            f"DSH 执行报错: {error_reason}",
            exc=err,
            childId=child.id,
            sessionId=session_id,
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise err

    if proc.returncode != 0 and not final_text:
        err = RuntimeError(f"DSH 进程退出码 {proc.returncode}: {stderr_str[-300:]}")
        log_error(
            "ai.dsh_exit_error",
            f"DSH 非零退出 ({proc.returncode})",
            exc=err,
            childId=child.id,
            sessionId=session_id,
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise err

    try:
        parsed_json = extract_json_object(final_text)
    except Exception as exc:
        log_error(
            "ai.dsh_json_parse_failed",
            "DSH 返回文本无法解析为 JSON",
            exc=exc,
            childId=child.id,
            rawPreview=final_text[:300],
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise

    log_event(
        "ai.dsh_completed",
        f"{child.display_name} DSH 智能体推理完成",
        childId=child.id,
        sessionId=returned_session_id,
        elapsedMs=round((time.perf_counter() - started) * 1000, 1),
    )
    return parsed_json, returned_session_id
