import ast
import builtins
from io import BytesIO
import os
import pathlib
import httpx
from PIL import Image
from app.config import settings
from app.services.image_pipeline import (
    is_likely_sideways_ocr,
    rotate_jpeg_clockwise,
    rotate_ocr_boxes_clockwise,
    score_ocr_uprightness,
)

REMOTE_HTTPS_BASE = os.environ.get("STUDY_DIARY_TEST_BASE_URL") or settings.test_base_url


def test_zero_undefined_symbols_across_backend() -> None:
    builtin_names = set(dir(builtins))
    app_root = pathlib.Path(__file__).resolve().parent.parent / "app"
    for py_path in sorted(app_root.rglob("*.py")):
        tree = ast.parse(py_path.read_text(encoding="utf-8"), filename=str(py_path))
        defined = set(builtin_names)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    defined.add(alias.asname or alias.name.split(".")[0])
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
                        defined.add(arg.arg)
                    if node.args.vararg:
                        defined.add(node.args.vararg.arg)
                    if node.args.kwarg:
                        defined.add(node.args.kwarg.arg)
            elif isinstance(node, ast.Lambda):
                for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
                    defined.add(arg.arg)
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                defined.add(node.id)
            elif isinstance(node, ast.ExceptHandler) and node.name:
                defined.add(node.name)
            elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
                defined.add(node.target.id)
        missing = [
            (node.lineno, node.id)
            for node in ast.walk(tree)
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in defined
        ]
        assert missing == [], f"Undefined symbol(s) in {py_path}: {missing}"


def make_client() -> httpx.Client:
    transport = httpx.HTTPTransport(
        verify=False,
        retries=3,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=0),
    )
    return httpx.Client(base_url=REMOTE_HTTPS_BASE, transport=transport, timeout=30.0)


def test_local_image_and_ocr_rotation_helpers() -> None:
    src = Image.new("RGB", (400, 240), (245, 240, 250))
    buf = BytesIO()
    src.save(buf, format="JPEG")
    rotated_bytes, w, h = rotate_jpeg_clockwise(buf.getvalue(), 90)
    assert (w, h) == (240, 400)
    with Image.open(BytesIO(rotated_bytes)) as check_im:
        assert check_im.size == (240, 400)

    upright_boxes = [{"id": i, "box": [100, i * 40, 820, i * 40 + 25]} for i in range(12)]
    sideways_boxes = [{"id": i, "box": [200, i * 25, 224, i * 25 + 24]} for i in range(25)]
    assert is_likely_sideways_ocr(upright_boxes) is False
    assert is_likely_sideways_ocr(sideways_boxes) is True
    assert score_ocr_uprightness(upright_boxes, "正常横向语文题目") > score_ocr_uprightness(
        sideways_boxes,
        "正常横向语文题目",
    )

    rot_boxes = rotate_ocr_boxes_clockwise([{"id": 1, "box": [100, 200, 300, 260]}], 90)
    assert rot_boxes[0]["box"] == [740, 100, 800, 300]


def test_live_admin_rotate_task_image_roundtrip() -> None:
    auth_headers = {"Authorization": f"Bearer {settings.admin_token}"}
    temp_child_id: str | None = None

    with make_client() as client:
        try:
            child = client.post(
                "/api/v1/admin/children",
                headers=auth_headers,
                json={
                    "displayName": "图片旋转测试号",
                    "birthDate": "2017-08-08",
                    "gender": "女",
                    "age": 9,
                    "gradeLabel": "小学四年级",
                    "dailyGoalMinutes": 60,
                },
            ).raise_for_status().json()
            temp_child_id = child["id"]

            tasks = client.post(
                f"/api/v1/children/{temp_child_id}/tasks/batch",
                json={
                    "targetDate": "2099-12-28",
                    "rawTranscript": "旋转测试作业",
                    "drafts": [
                        {
                            "draftId": "r-1",
                            "title": "旋转验证单",
                            "timerMode": "countdown",
                            "plannedDurationMinutes": 15,
                            "subject": "chinese",
                            "categoryTags": ["练习"],
                            "difficulty": 1,
                            "rewardStars": 20,
                            "scoringRubric": {"focus": 30, "completeness": 30, "accuracy": 40},
                            "scoreHint": "100分制",
                        }
                    ],
                },
            ).raise_for_status().json()
            task_id = tasks[0]["id"]

            im = Image.new("RGB", (640, 360), (255, 250, 240))
            raw_buf = BytesIO()
            im.save(raw_buf, format="JPEG")

            uploaded = client.post(
                f"/api/v1/tasks/{task_id}/images/upload",
                data={"upload_kind": "initial"},
                files=[("files", ("sheet.jpg", raw_buf.getvalue(), "image/jpeg"))],
            ).raise_for_status().json()
            img_id = uploaded[0]["id"]
            assert (uploaded[0]["width"], uploaded[0]["height"]) == (640, 360)

            rot_res = client.post(
                f"/api/v1/admin/images/{img_id}/rotate",
                headers=auth_headers,
                json={"degreesCw": 90},
            ).raise_for_status().json()
            assert (rot_res["width"], rot_res["height"]) == (360, 640)
            assert "?v=" in rot_res["imageUrl"]

            fetched_media = client.get(rot_res["imageUrl"]).raise_for_status()
            with Image.open(BytesIO(fetched_media.content)) as fetched_img:
                assert fetched_img.size == (360, 640)
        finally:
            if temp_child_id:
                client.delete(
                    f"/api/v1/admin/children/{temp_child_id}",
                    headers=auth_headers,
                )
