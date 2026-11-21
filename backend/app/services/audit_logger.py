from collections import deque
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import re
import time
import traceback
import uuid
from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from ..config import settings

CN_TZ = timezone(timedelta(hours=8))

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")
client_ip_ctx: ContextVar[str] = ContextVar("client_ip", default="-")
device_tag_ctx: ContextVar[str] = ContextVar("device_tag", default="server")

SENSITIVE_KEYS = {
    "authorization",
    "x-admin-token",
    "admin_token",
    "admintoken",
    "api_key",
    "deepseek_api_key",
    "minio_secret_key",
    "secret",
    "password",
    "token",
}

_initialized = False
_text_logger = logging.getLogger("studydiary.app")
_jsonl_logger = logging.getLogger("studydiary.jsonl")
_error_logger = logging.getLogger("studydiary.errors")


def now_cn_iso() -> str:
    return datetime.now(CN_TZ).isoformat(timespec="milliseconds")


def get_logs_dir() -> Path:
    log_dir = settings.data_root.resolve() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def sanitize_fields(fields: dict) -> dict:
    clean: dict = {}
    for k, v in fields.items():
        if str(k).lower() in SENSITIVE_KEYS:
            clean[k] = "***REDACTED***"
        elif isinstance(v, dict):
            clean[k] = sanitize_fields(v)
        elif isinstance(v, str):
            scrubbed = re.sub(r"\bsk-[A-Za-z0-9]{16,}\b", "***REDACTED***", v)
            clean[k] = scrubbed[:800] + "...(truncated)" if len(scrubbed) > 800 else scrubbed
        else:
            clean[k] = v
    return clean


def detect_device_tag(origin: str, user_agent: str) -> str:
    ua = user_agent.lower()
    if origin.startswith("capacitor://"):
        return "iPad-NativeApp"
    if "ipad" in ua or ("macintosh" in ua and "mobile" in ua):
        return "iPad-Safari"
    if "iphone" in ua:
        return "iPhone"
    if "android" in ua:
        return "Android"
    if "python-httpx" in ua or "curl" in ua:
        return "API-Client"
    return "Web-Browser"


def setup_logging() -> Path:
    global _initialized
    log_dir = get_logs_dir()
    if _initialized:
        return log_dir

    max_bytes = 10 * 1024 * 1024
    backup_count = 5

    _text_logger.setLevel(logging.INFO)
    _text_logger.propagate = False
    app_handler = RotatingFileHandler(
        log_dir / "app.log",
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    app_handler.setFormatter(logging.Formatter("%(message)s"))
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(logging.Formatter("%(message)s"))
    _text_logger.addHandler(app_handler)
    _text_logger.addHandler(stream_handler)

    _jsonl_logger.setLevel(logging.INFO)
    _jsonl_logger.propagate = False
    jsonl_handler = RotatingFileHandler(
        log_dir / "events.jsonl",
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    jsonl_handler.setFormatter(logging.Formatter("%(message)s"))
    _jsonl_logger.addHandler(jsonl_handler)

    _error_logger.setLevel(logging.WARNING)
    _error_logger.propagate = False
    err_handler = RotatingFileHandler(
        log_dir / "errors.log",
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    err_handler.setFormatter(logging.Formatter("%(message)s"))
    _error_logger.addHandler(err_handler)

    _initialized = True
    return log_dir


def _emit_record(level: str, event: str, message: str, fields: dict, traceback_text: str | None = None) -> None:
    setup_logging()
    ts = now_cn_iso()
    req_id = request_id_ctx.get()
    ip = client_ip_ctx.get()
    device = device_tag_ctx.get()
    safe_fields = sanitize_fields(fields)

    record = {
        "ts": ts,
        "level": level,
        "event": event,
        "message": message,
        "requestId": req_id,
        "clientIp": ip,
        "device": device,
        **safe_fields,
    }
    if traceback_text:
        record["traceback"] = traceback_text[-4000:]

    json_line = json.dumps(record, ensure_ascii=False, default=str)
    _jsonl_logger.info(json_line)

    kv_tail = " ".join(f"{k}={json.dumps(v, ensure_ascii=False, default=str)}" for k, v in safe_fields.items())
    human_line = f"{ts} [{level}] [req={req_id}] [dev={device}] {event} — {message}"
    if kv_tail:
        human_line = f"{human_line} | {kv_tail}"

    if level in {"ERROR", "WARNING"}:
        _text_logger.error(human_line)
        if traceback_text:
            _error_logger.error(f"{human_line}\n{traceback_text.rstrip()}")
        else:
            _error_logger.warning(human_line)
    else:
        _text_logger.info(human_line)


def log_event(event: str, message: str, **fields) -> None:
    _emit_record("INFO", event, message, fields)


def log_warn(event: str, message: str, **fields) -> None:
    _emit_record("WARNING", event, message, fields)


def log_error(event: str, message: str, exc: BaseException | None = None, **fields) -> None:
    tb_str = None
    if exc is not None:
        tb_str = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        fields.setdefault("errorType", type(exc).__name__)
        fields.setdefault("errorDetail", str(exc))
    _emit_record("ERROR", event, message, fields, traceback_text=tb_str)


def read_recent_events(level_filter: str = "all", limit: int = 100, child_id: str | None = None) -> dict:
    log_dir = setup_logging()
    jsonl_file = log_dir / "events.jsonl"
    if not jsonl_file.exists():
        return {
            "summary": {"totalEvents": 0, "errorCount": 0, "warnCount": 0, "todayEvents": 0},
            "items": [],
        }

    today_prefix = now_cn_iso()[:10]
    total_events = 0
    error_count = 0
    warn_count = 0
    today_events = 0
    matched: deque[dict] = deque(maxlen=max(1, min(500, limit)))

    with jsonl_file.open("r", encoding="utf-8", errors="replace") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            if child_id and obj.get("childId") not in {None, child_id}:
                continue

            total_events += 1
            lvl = obj.get("level", "INFO")
            if lvl == "ERROR":
                error_count += 1
            elif lvl == "WARNING":
                warn_count += 1
            if str(obj.get("ts", "")).startswith(today_prefix):
                today_events += 1

            if level_filter == "error" and lvl not in {"ERROR", "WARNING"}:
                continue
            matched.append(obj)

    items = list(matched)
    items.reverse()
    return {
        "summary": {
            "totalEvents": total_events,
            "errorCount": error_count,
            "warnCount": warn_count,
            "todayEvents": today_events,
            "logDir": str(log_dir),
        },
        "items": items,
    }


class ClientErrorReportIn(BaseModel):
    childId: str | None = None
    category: str = Field(default="ui_error", max_length=64)
    message: str = Field(..., max_length=1000)
    pageUrl: str | None = Field(default=None, max_length=500)
    stack: str | None = Field(default=None, max_length=4000)
    extra: dict | None = None


audit_router = APIRouter()


@audit_router.post("/api/v1/logs/client-error")
async def report_client_error(payload: ClientErrorReportIn) -> dict:
    _emit_record(
        "ERROR",
        f"client.{payload.category}",
        payload.message,
        {
            "childId": payload.childId,
            "pageUrl": payload.pageUrl,
            "extra": payload.extra or {},
        },
        traceback_text=payload.stack,
    )
    return {"recorded": True, "requestId": request_id_ctx.get()}


@audit_router.get("/api/v1/parent/logs")
async def get_parent_audit_logs(
    level: str = Query("all"),
    limit: int = Query(80, ge=1, le=300),
    child_id: str | None = Query(None),
) -> dict:
    return read_recent_events(level_filter=level, limit=limit, child_id=child_id)


def register_observability(app: FastAPI) -> None:
    setup_logging()

    @app.middleware("http")
    async def access_and_context_middleware(request: Request, call_next):
        req_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:10]
        forwarded = request.headers.get("X-Forwarded-For")
        ip = (
            forwarded.split(",")[0].strip()
            if forwarded
            else (request.client.host if request.client else "-")
        )
        origin = request.headers.get("Origin", "")
        ua = request.headers.get("User-Agent", "")
        dev = detect_device_tag(origin, ua)

        t_req = request_id_ctx.set(req_id)
        t_ip = client_ip_ctx.set(ip)
        t_dev = device_tag_ctx.set(dev)
        started = time.perf_counter()

        path = request.url.path
        method = request.method
        is_quiet_poll = (
            method == "GET"
            and (
                path == "/api/v1/health"
                or path.startswith("/api/v1/jobs/")
                or path.startswith("/api/v1/media/")
            )
        )

        try:
            response = await call_next(request)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            response.headers["X-Request-ID"] = req_id

            if getattr(request.state, "exception_logged", False):
                return response

            if response.status_code >= 500:
                log_error(
                    "http.5xx",
                    f"{method} {path} -> {response.status_code}",
                    method=method,
                    path=path,
                    statusCode=response.status_code,
                    durationMs=elapsed_ms,
                )
            elif response.status_code >= 400 and path != "/api/v1/logs/client-error":
                log_warn(
                    "http.4xx",
                    f"{method} {path} -> {response.status_code}",
                    method=method,
                    path=path,
                    statusCode=response.status_code,
                    durationMs=elapsed_ms,
                )
            elif not is_quiet_poll or elapsed_ms >= 1000:
                log_event(
                    "http.access",
                    f"{method} {path} -> {response.status_code}",
                    method=method,
                    path=path,
                    statusCode=response.status_code,
                    durationMs=elapsed_ms,
                )
            return response
        except Exception as exc:
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            log_error(
                "http.unhandled_exception",
                f"未捕获服务端异常: {method} {path}",
                exc=exc,
                method=method,
                path=path,
                durationMs=elapsed_ms,
            )
            return JSONResponse(
                status_code=500,
                content={"detail": f"服务器内部错误 (追踪号 {req_id}): {exc}"},
                headers={"X-Request-ID": req_id},
            )
        finally:
            request_id_ctx.reset(t_req)
            client_ip_ctx.reset(t_ip)
            device_tag_ctx.reset(t_dev)

    @app.exception_handler(HTTPException)
    async def http_exception_logger(request: Request, exc: HTTPException):
        request.state.exception_logged = True
        req_id = request_id_ctx.get()
        lvl_fn = log_error if exc.status_code >= 500 else log_warn
        lvl_fn(
            "http.exception",
            f"{request.method} {request.url.path} ({exc.status_code}): {exc.detail}",
            method=request.method,
            path=request.url.path,
            statusCode=exc.status_code,
            detail=str(exc.detail),
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers={"X-Request-ID": req_id},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_logger(request: Request, exc: RequestValidationError):
        request.state.exception_logged = True
        req_id = request_id_ctx.get()
        log_warn(
            "http.validation_error",
            f"请求参数校验未通过: {request.method} {request.url.path}",
            method=request.method,
            path=request.url.path,
            errors=exc.errors(),
        )
        return JSONResponse(
            status_code=422,
            content={"detail": exc.errors()},
            headers={"X-Request-ID": req_id},
        )
