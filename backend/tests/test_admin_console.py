import os
import httpx
from app.config import settings

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url


def make_client() -> httpx.Client:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    return httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=30.0)


def test_admin_preset_token_auth_and_child_supervision() -> None:
    assert settings.admin_token.strip() != ""
    created_test_child_id: str | None = None

    with make_client() as client:
        no_tok = client.get("/api/v1/admin/children")
        assert no_tok.status_code == 401

        bad_tok = client.post(
            "/api/v1/admin/auth/verify",
            headers={"Authorization": "Bearer wrong-invalid-token"},
        )
        assert bad_tok.status_code == 401

        auth_headers = {"Authorization": f"Bearer {settings.admin_token}"}
        ok_verify = client.post("/api/v1/admin/auth/verify", headers=auth_headers)
        assert ok_verify.status_code == 200
        assert ok_verify.json()["authenticated"] is True

        try:
            children = client.get("/api/v1/admin/children", headers=auth_headers).raise_for_status().json()
            assert len(children) >= 1
            builtin_id = settings.default_child_id
            builtin_item = next(c for c in children if c["profile"]["id"] == builtin_id)
            assert builtin_item["profile"]["displayName"] == settings.default_child_name
            assert "totalTasks" in builtin_item["stats"]

            tasks = client.get(
                f"/api/v1/admin/children/{builtin_id}/tasks",
                headers=auth_headers,
            ).raise_for_status().json()
            assert isinstance(tasks, list)

            mem = client.get(
                f"/api/v1/admin/children/{builtin_id}/memory",
                headers=auth_headers,
            ).raise_for_status().json()
            assert mem["childId"] == builtin_id
            assert settings.default_child_name in mem["agentsMd"]

            logs = client.get(
                "/api/v1/admin/logs",
                params={"level": "all", "limit": 20},
                headers=auth_headers,
            ).raise_for_status().json()
            assert logs["summary"]["totalEvents"] >= 1

            created = client.post(
                "/api/v1/admin/children",
                headers=auth_headers,
                json={
                    "displayName": "测试档案临时",
                    "birthDate": "2018-03-15",
                    "gender": "女",
                    "age": 8,
                    "gradeLabel": "小学三年级",
                    "dailyGoalMinutes": 60,
                },
            ).raise_for_status().json()
            created_test_child_id = created["id"]
            assert created["displayName"] == "测试档案临时"

            protect_builtin = client.delete(
                f"/api/v1/admin/children/{builtin_id}",
                headers=auth_headers,
            )
            assert protect_builtin.status_code == 403
        finally:
            if created_test_child_id:
                client.delete(
                    f"/api/v1/admin/children/{created_test_child_id}",
                    headers=auth_headers,
                )
