import json
import os
import httpx
from app.config import settings
from app.services import audit_logger

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url


def test_local_sanitizer_and_log_files() -> None:
    sanitized = audit_logger.sanitize_fields(
        {
            "deepseek_api_key": "sk-secret-value",
            "nested": {"authorization": "Bearer top-secret", "childId": "child_demo"},
            "normal": "ok",
        }
    )
    assert sanitized["deepseek_api_key"] == "***REDACTED***"
    assert sanitized["nested"]["authorization"] == "***REDACTED***"
    assert sanitized["nested"]["childId"] == "child_demo"

    log_dir = audit_logger.setup_logging()
    audit_logger.log_event("unit.usage_check", "本地单元测试使用事件", childId="child_demo")
    try:
        raise ValueError("模拟计算参数异常")
    except ValueError as exc:
        audit_logger.log_error("unit.error_check", "本地单元测试异常事件", exc=exc, childId="child_demo")

    assert (log_dir / "app.log").exists()
    assert (log_dir / "events.jsonl").exists()
    assert (log_dir / "errors.log").exists()

    err_content = (log_dir / "errors.log").read_text(encoding="utf-8")
    assert "unit.error_check" in err_content
    assert "ValueError: 模拟计算参数异常" in err_content

    queried = audit_logger.read_recent_events(level_filter="error", limit=20, child_id="child_demo")
    assert queried["summary"]["errorCount"] >= 1
    assert any(x["event"] == "unit.error_check" for x in queried["items"])


def test_live_remote_usage_and_error_logs() -> None:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    with httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=30.0) as client:
        resp_ok = client.get(
            "/api/v1/children",
            headers={"Origin": "capacitor://localhost"},
        )
        assert resp_ok.status_code == 200
        assert "x-request-id" in {k.lower() for k in resp_ok.headers.keys()}
        cid = resp_ok.json()[0]["id"]

        resp_404 = client.post("/api/v1/tasks/nonexistent-task-check/timer/start")
        assert resp_404.status_code == 404

        resp_client_err = client.post(
            "/api/v1/logs/client-error",
            headers={"Origin": "capacitor://localhost"},
            json={
                "childId": cid,
                "category": "automated_probe",
                "message": "自动化巡检验证前端异常上报链路",
                "pageUrl": "capacitor://localhost/",
                "stack": "ProbeError: synthetic verification trace",
            },
        )
        assert resp_client_err.status_code == 200
        assert resp_client_err.json()["recorded"] is True

        all_logs = client.get(
            "/api/v1/parent/logs",
            params={"child_id": cid, "level": "all", "limit": 50},
        ).raise_for_status().json()
        assert all_logs["summary"]["totalEvents"] >= 3
        assert all_logs["summary"]["errorCount"] >= 1
        assert any(
            item["event"] == "http.access" and item["device"] == "iPad-NativeApp"
            for item in all_logs["items"]
        )

        err_logs = client.get(
            "/api/v1/parent/logs",
            params={"child_id": cid, "level": "error", "limit": 50},
        ).raise_for_status().json()
        assert any(
            item["event"] == "client.automated_probe"
            for item in err_logs["items"]
        )
        assert any(
            item["event"] == "http.exception" and "任务不存在" in item["message"]
            for item in err_logs["items"]
        )
        raw_dump = json.dumps(err_logs, ensure_ascii=False)
        assert settings.deepseek_api_key not in raw_dump
