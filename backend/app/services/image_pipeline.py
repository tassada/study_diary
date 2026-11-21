import html
from io import BytesIO
from PIL import Image, ImageOps


def normalize_homework_image(raw_bytes: bytes, max_edge: int = 1600) -> tuple[bytes, int, int]:
    with Image.open(BytesIO(raw_bytes)) as img:
        upright = ImageOps.exif_transpose(img)
        rgb = upright.convert("RGB")
        w, h = rgb.size
        longest = max(w, h)
        if longest > max_edge:
            scale = max_edge / float(longest)
            w = max(1, int(round(w * scale)))
            h = max(1, int(round(h * scale)))
            rgb = rgb.resize((w, h), Image.Resampling.LANCZOS)

        out = BytesIO()
        rgb.save(out, format="JPEG", quality=84, optimize=True)
        return out.getvalue(), w, h


def rotate_jpeg_clockwise(image_bytes: bytes, degrees_cw: int) -> tuple[bytes, int, int]:
    deg = degrees_cw % 360
    with Image.open(BytesIO(image_bytes)) as img:
        rgb = ImageOps.exif_transpose(img).convert("RGB")
        if deg == 90:
            rotated = rgb.transpose(Image.Transpose.ROTATE_270)
        elif deg == 180:
            rotated = rgb.transpose(Image.Transpose.ROTATE_180)
        elif deg == 270:
            rotated = rgb.transpose(Image.Transpose.ROTATE_90)
        else:
            rotated = rgb
        w, h = rotated.size
        out = BytesIO()
        rotated.save(out, format="JPEG", quality=88, optimize=True)
        return out.getvalue(), w, h


def rotate_ocr_boxes_clockwise(boxes: list[dict], degrees_cw: int) -> list[dict]:
    deg = degrees_cw % 360
    if deg == 0:
        return boxes
    rotated_boxes: list[dict] = []
    for item in boxes:
        raw_box = item.get("box")
        if not isinstance(raw_box, list) or len(raw_box) != 4:
            rotated_boxes.append(item)
            continue
        x1, y1, x2, y2 = [int(v) for v in raw_box]
        if deg == 90:
            nx1, ny1, nx2, ny2 = 1000 - y2, x1, 1000 - y1, x2
        elif deg == 180:
            nx1, ny1, nx2, ny2 = 1000 - x2, 1000 - y2, 1000 - x1, 1000 - y1
        elif deg == 270:
            nx1, ny1, nx2, ny2 = y1, 1000 - x2, y2, 1000 - x1
        else:
            nx1, ny1, nx2, ny2 = x1, y1, x2, y2
        updated = dict(item)
        updated["box"] = [
            max(0, min(1000, min(nx1, nx2))),
            max(0, min(1000, min(ny1, ny2))),
            max(0, min(1000, max(nx1, nx2))),
            max(0, min(1000, max(ny1, ny2))),
        ]
        rotated_boxes.append(updated)
    return rotated_boxes


def is_likely_sideways_ocr(boxes: list[dict]) -> bool:
    valid = [
        b["box"]
        for b in boxes
        if isinstance(b.get("box"), list) and len(b["box"]) == 4
    ]
    if len(valid) < 8:
        return False
    wide = sum(1 for x1, y1, x2, y2 in valid if (x2 - x1) > (y2 - y1) * 1.45)
    return (wide / float(len(valid))) < 0.25


def score_ocr_uprightness(boxes: list[dict], plain_text: str) -> float:
    valid = [
        b["box"]
        for b in boxes
        if isinstance(b.get("box"), list) and len(b["box"]) == 4
    ]
    wide = sum(1 for x1, y1, x2, y2 in valid if (x2 - x1) > (y2 - y1) * 1.45)
    tall = sum(1 for x1, y1, x2, y2 in valid if (y2 - y1) > (x2 - x1) * 1.45)
    readable_chars = sum(1 for ch in plain_text if not ch.isspace())
    wide_ratio = (wide / float(len(valid))) if valid else 0.0
    return wide * 12.0 + wide_ratio * 120.0 - tall * 6.0 + min(readable_chars, 600) * 0.25


def crop_mistake_region_jpeg(image_bytes: bytes, box_0_1000: list[int]) -> bytes | None:
    if len(box_0_1000) != 4:
        return None
    x1, y1, x2, y2 = box_0_1000
    if x2 <= x1 or y2 <= y1:
        return None

    with Image.open(BytesIO(image_bytes)) as img:
        rgb = img.convert("RGB")
        w, h = rgb.size
        pad_x = int(w * 0.03)
        pad_y = int(h * 0.03)
        left = max(0, int(w * x1 / 1000.0) - pad_x)
        top = max(0, int(h * y1 / 1000.0) - pad_y)
        right = min(w, int(w * x2 / 1000.0) + pad_x)
        bottom = min(h, int(h * y2 / 1000.0) + pad_y)
        if right - left < 24 or bottom - top < 24:
            return None
        cropped = rgb.crop((left, top, right, bottom))
        out = BytesIO()
        cropped.save(out, format="JPEG", quality=88)
        return out.getvalue()


def wrap_cjk_lines(text: str, width_chars: int = 28) -> list[str]:
    clean = " ".join(text.strip().split())
    if not clean:
        return [""]
    lines: list[str] = []
    buf = ""
    count = 0.0
    for ch in clean:
        weight = 0.55 if ord(ch) < 128 else 1.0
        if count + weight > width_chars and buf:
            lines.append(buf)
            buf = ch
            count = weight
        else:
            buf += ch
            count += weight
    if buf:
        lines.append(buf)
    return lines[:4]


def render_mistake_explanation_svg(
    question_title: str,
    wrong_snippet: str,
    error_cause: str,
    correct_steps: list[str],
    practice_question: str,
) -> bytes:
    title_escaped = html.escape(question_title[:36])
    wrong_lines = wrap_cjk_lines(f"原卷错解：{wrong_snippet}", 30)
    cause_lines = wrap_cjk_lines(f"错因点拨：{error_cause}", 30)

    step_blocks: list[tuple[str, list[str]]] = []
    for idx, step in enumerate(correct_steps[:4]):
        step_blocks.append((f"第 {idx + 1} 步", wrap_cjk_lines(step, 26)))

    practice_lines = wrap_cjk_lines(f"举一反三：{practice_question}", 30)

    y = 88
    svg_elements: list[str] = []

    svg_elements.append(
        f'<rect x="24" y="{y}" width="672" height="{36 + len(wrong_lines) * 26 + len(cause_lines) * 26}" '
        'rx="10" fill="#FFF0F5" stroke="#4A2B44" stroke-width="3"/>'
    )
    ty = y + 30
    for ln in wrong_lines:
        svg_elements.append(
            f'<text x="42" y="{ty}" font-size="19" font-weight="700" fill="#B51D5B">{html.escape(ln)}</text>'
        )
        ty += 26
    ty += 6
    for ln in cause_lines:
        svg_elements.append(
            f'<text x="42" y="{ty}" font-size="18" font-weight="600" fill="#4A2B44">{html.escape(ln)}</text>'
        )
        ty += 26

    y = ty + 20

    for badge, lines in step_blocks:
        box_h = 26 + len(lines) * 27
        svg_elements.append(
            f'<rect x="24" y="{y}" width="672" height="{box_h}" rx="10" fill="#F2FBF6" stroke="#4A2B44" stroke-width="3"/>'
        )
        svg_elements.append(
            f'<rect x="38" y="{y + 12}" width="78" height="28" rx="6" fill="#44B98A" stroke="#4A2B44" stroke-width="2"/>'
        )
        svg_elements.append(
            f'<text x="77" y="{y + 32}" text-anchor="middle" font-size="15" font-weight="800" fill="#FFFFFF">{badge}</text>'
        )
        sy = y + 32
        for ln in lines:
            svg_elements.append(
                f'<text x="130" y="{sy}" font-size="19" font-weight="700" fill="#183D2D">{html.escape(ln)}</text>'
            )
            sy += 27
        y += box_h + 14

    prac_h = 28 + len(practice_lines) * 26
    svg_elements.append(
        f'<rect x="24" y="{y}" width="672" height="{prac_h}" rx="10" fill="#FFF8DE" stroke="#4A2B44" stroke-width="3"/>'
    )
    py = y + 31
    for ln in practice_lines:
        svg_elements.append(
            f'<text x="42" y="{py}" font-size="18" font-weight="700" fill="#5C3D00">{html.escape(ln)}</text>'
        )
        py += 26

    total_height = y + prac_h + 26
    body_joined = "\n  ".join(svg_elements)

    svg_doc = f"""<svg xmlns="http://www.w3.org/2000/svg" width="720" height="{total_height}" viewBox="0 0 720 {total_height}">
  <rect width="720" height="{total_height}" rx="14" fill="#FAF4EC" stroke="#4A2B44" stroke-width="4"/>
  <rect x="24" y="20" width="672" height="52" rx="10" fill="#EC5F9B" stroke="#4A2B44" stroke-width="3"/>
  <text x="44" y="54" font-size="22" font-weight="800" fill="#FFFFFF" font-family="PingFang SC, HarmonyOS Sans SC, Microsoft YaHei, sans-serif">★ 海星老师图文精讲卡：{title_escaped}</text>
  <g font-family="PingFang SC, HarmonyOS Sans SC, Microsoft YaHei, sans-serif">
  {body_joined}
  </g>
</svg>"""
    return svg_doc.encode("utf-8")
