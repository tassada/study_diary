import asyncio
import json
import re
import time
import uuid
from sqlalchemy import select
from ..database import AsyncSessionLocal
from ..models import (
    AsyncJobModel,
    ChildModel,
    DailyEvalModel,
    MistakeModel,
    TaskImageModel,
    TaskModel,
    utc_now_iso,
)
from ..providers.deepseek_vlm import call_deepseek_vlm_json, call_supervised_vlm_json
from ..providers.dsh_agent import ensure_child_agent_files
from ..providers.minio_store import minio_gateway
from .audit_logger import log_error, log_event
from .dsh_supervisor import (
    audit_dsh_payload_completeness,
    job_supervisor,
    run_supervised_dsh_task,
)
from .image_pipeline import (
    crop_mistake_region_jpeg,
    render_mistake_explanation_svg,
    rotate_jpeg_clockwise,
)


async def update_job_progress(job_id: str, status: str, progress_text: str) -> None:
    job_supervisor.heartbeat(job_id)
    async with AsyncSessionLocal() as db:
        job = await db.get(AsyncJobModel, job_id)
        if job:
            job.status = status
            job.progress_text = progress_text
            await db.commit()


async def parse_voice_tasks_with_dsh(
    child: ChildModel,
    transcript: str,
    target_date: str,
    existing_drafts: list[dict] | None = None,
    is_refinement: bool = False,
) -> dict:
    mode_desc = (
        f"当前已有草稿列表：{json.dumps(existing_drafts or [], ensure_ascii=False)}。请根据孩子的修改语音对草稿进行调整或追加。"
        if is_refinement and existing_drafts
        else "请将孩子的语音说明拆解为 1 到多项独立学习任务卡片。"
    )

    prompt = (
        f"任务类型：语音建立/修改学习任务（目标日期：{target_date}）。\n"
        f"学生：{child.display_name}（{child.age}岁，{child.grade_label}）。\n"
        f"孩子刚才说的语音转写内容：「{transcript}」\n"
        f"{mode_desc}\n"
        "请严格返回纯 JSON 对象（不要用 Markdown 代码块以外的解释；不要生成排期或开始时间，开始时间以学生自己点击开始计时为准），格式如下：\n"
        "{\n"
        '  "spokenReply": "用海星老师温暖简短的口吻向孩子确认安排好的任务",\n'
        '  "drafts": [\n'
        "    {\n"
        '      "draftId": "draft-1",\n'
        '      "title": "规范清晰的四年级学习任务名称(4-16字)",\n'
        '      "timerMode": "countdown 或 stopwatch (有明确作业时限选countdown，自由阅读/拓展选stopwatch)",\n'
        '      "plannedDurationMinutes": 25,\n'
        '      "subject": "chinese | math | english | reading | science | art 之一",\n'
        '      "categoryTags": ["如 口算练习 / 生字默写 / 课文背诵 / 错题订正 / 自主阅读"],\n'
        '      "difficulty": 2,\n'
        '      "rewardStars": 30,\n'
        '      "scoringRubric": {"focus": 30, "completeness": 30, "accuracy": 40},\n'
        '      "scoreHint": "本任务独立100分制评分说明（如：专注按时30分+书写完整30分+准确自查40分，通关奖30星莓币）"\n'
        "    }\n"
        "  ]\n"
        "}"
    )

    result_json, new_session_id = await run_supervised_dsh_task(
        child,
        task_kind="voice_parse",
        task_prompt=prompt,
    )

    spoken = str(result_json.get("spokenReply") or "海星老师帮你把学习卡片整理好啦！")

    return {
        "spokenReply": spoken,
        "ttsMinioKey": None,
        "drafts": result_json.get("drafts") or [],
        "newSessionId": new_session_id,
    }


_task_review_locks: dict[str, asyncio.Lock] = {}


def get_task_review_lock(task_id: str) -> asyncio.Lock:
    lock = _task_review_locks.get(task_id)
    if lock is None:
        lock = asyncio.Lock()
        _task_review_locks[task_id] = lock
    return lock


def normalize_mistake_title(raw: str) -> str:
    cleaned = re.sub(r"[\s\W_]+", "", (raw or "").lower())
    for filler in ("的", "并", "及", "与", "问题"):
        cleaned = cleaned.replace(filler, "")
    return cleaned


def is_same_mistake_question(
    title_a: str,
    image_a: str | None,
    title_b: str,
    image_b: str | None,
) -> bool:
    na = normalize_mistake_title(title_a)
    nb = normalize_mistake_title(title_b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if image_a and image_b and image_a != image_b:
        return False
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(shorter) >= 4 and shorter in longer:
        return True
    grams_a = {na[i : i + 2] for i in range(max(1, len(na) - 1))}
    grams_b = {nb[i : i + 2] for i in range(max(1, len(nb) - 1))}
    overlap = len(grams_a & grams_b) / max(1, min(len(grams_a), len(grams_b)))
    return overlap >= 0.65


async def execute_homework_review_job(job_id: str, task_id: str, upload_kind: str) -> None:
    started = time.perf_counter()
    job_supervisor.mark_started(job_id)
    try:
        async with get_task_review_lock(task_id), AsyncSessionLocal() as db:
            task = await db.get(TaskModel, task_id)
            if not task:
                raise RuntimeError("未找到对应的学习任务")
            child = await db.get(ChildModel, task.child_id)
            if not child:
                raise RuntimeError("未找到对应的学生档案")

            img_res = await db.execute(
                select(TaskImageModel)
                .where(TaskImageModel.task_id == task_id)
                .order_by(TaskImageModel.created_at.asc())
            )
            all_images = list(img_res.scalars().all())

            pending_images = [img for img in all_images if img.ocr_status != "done"]
            total_pending = len(pending_images)

            image_bytes_cache: dict[str, bytes] = {}

            if total_pending > 0:
                await update_job_progress(
                    job_id,
                    "ocr_running",
                    f"DeepSeek-V4.1-Flash 正在并发校准 {total_pending} 张作业图的朝向与版面...",
                )
                orient_sem = asyncio.Semaphore(4)
                orient_prompt = (
                    "请直接观察这张学生作业或试卷照片，仅完成朝向判断与版面简述并输出纯 JSON：\n"
                    "1. `rotateCw`：要让纸面上的印刷文字和手写字恢复【正立正向可读】，需要将当前图片顺时针旋转多少度？只能填 0、90、180 或 270（本来正立填 0）。\n"
                    "2. `pageBrief`：用 1~2 句话简要概括本页所属练习/试卷名称及包含的大题题号范围（无需逐题抄写全文，不超过 120 字）。\n"
                    '严格输出格式：{"rotateCw": 0, "pageBrief": "第四单元过关卷第1页，含一、填空题与二、判断题"}'
                )

                async def calibrate_single_image(
                    img_row: TaskImageModel,
                ) -> tuple[TaskImageModel, bytes, int | None, int | None, str, int]:
                    async with orient_sem:
                        raw_bytes, _ = await minio_gateway.get_object_bytes(img_row.minio_key)
                        page_vlm = await call_deepseek_vlm_json(
                            prompt_text=orient_prompt,
                            images=[(f"作业照片 {img_row.id}", raw_bytes)],
                            max_tokens=8192,
                            timeout_sec=120.0,
                            reasoning_effort="low",
                        )
                        job_supervisor.heartbeat(job_id)
                        rot_cw = int(page_vlm.get("rotateCw") or 0) % 360
                        brief = str(
                            page_vlm.get("pageBrief") or page_vlm.get("pageTranscript") or ""
                        ).strip()
                        if rot_cw in {90, 180, 270}:
                            upright_bytes, up_w, up_h = rotate_jpeg_clockwise(raw_bytes, rot_cw)
                            await minio_gateway.put_bytes(
                                img_row.minio_key, upright_bytes, "image/jpeg"
                            )
                            return (img_row, upright_bytes, up_w, up_h, brief, rot_cw)
                        return (img_row, raw_bytes, None, None, brief, 0)

                async with job_supervisor.keep_alive(job_id):
                    calibrated_results = await asyncio.gather(
                        *(calibrate_single_image(r) for r in pending_images)
                    )
                now_done_iso = utc_now_iso()
                for img_row, final_bytes, up_w, up_h, brief, rot_cw in calibrated_results:
                    image_bytes_cache[img_row.id] = final_bytes
                    if up_w is not None and up_h is not None:
                        img_row.width = up_w
                        img_row.height = up_h
                        img_row.file_size = len(final_bytes)
                        log_event(
                            "homework.image_auto_uprighted",
                            f"DeepSeek-V4.1-Flash 自动顺时针旋转 {rot_cw}° 放正作业图: {img_row.id}",
                            taskId=task.id,
                            imageId=img_row.id,
                            degreesCw=rot_cw,
                        )
                    img_row.ocr_status = "done"
                    img_row.ocr_raw_text = brief
                    img_row.ocr_plain_text = brief
                    img_row.ocr_boxes_json = "[]"
                    img_row.ocr_processed_at = now_done_iso
                await db.commit()

            await update_job_progress(
                job_id,
                "dsh_running",
                f"DeepSeek-V4.1-Flash 多模态正在结合 {child.display_name} 长期记忆直接看卷批阅与定位错题...",
            )

            mistake_res = await db.execute(
                select(MistakeModel).where(MistakeModel.task_id == task_id)
            )
            existing_mistakes = list(mistake_res.scalars().all())

            vlm_pages: list[tuple[str, bytes]] = []
            pages_meta_payload = []
            for p_idx, img_row in enumerate(all_images):
                if img_row.id not in image_bytes_cache:
                    raw_b, _ = await minio_gateway.get_object_bytes(img_row.minio_key)
                    image_bytes_cache[img_row.id] = raw_b
                vlm_pages.append(
                    (
                        f"第 {p_idx + 1} 页原卷（imageId={img_row.id}, 类型={img_row.upload_kind}）",
                        image_bytes_cache[img_row.id],
                    )
                )
                pages_meta_payload.append(
                    {
                        "pageNo": p_idx + 1,
                        "imageId": img_row.id,
                        "uploadKind": img_row.upload_kind,
                        "visualNotes": img_row.ocr_plain_text[:2500],
                    }
                )

            open_mistakes_payload = [
                {
                    "mistakeId": m.id,
                    "questionTitle": m.question_title,
                    "wrongSnippet": m.wrong_snippet,
                    "masteryStatus": m.mastery_status,
                }
                for m in existing_mistakes
                if m.mastery_status == "open"
            ]

            ws_dir = ensure_child_agent_files(child)
            memory_file = ws_dir / "MEMORY.md"
            mistakes_jsonl_file = ws_dir / "mistakes.jsonl"
            memory_excerpt = (
                memory_file.read_text(encoding="utf-8")[:2500] if memory_file.exists() else ""
            )

            vlm_review_prompt = (
                f"你是温暖、严谨的小学伴学导师「海星老师 Stella」。请直接查看上方传入的 {len(vlm_pages)} 张已放正的学生作业原卷图片进行多模态批阅（上传模式：{upload_kind}）。\n"
                f"学生：{child.display_name}（{child.age}岁，{child.grade_label}）。\n"
                f"作业标题：{task.title}（学科：{task.subject}，难度：{task.difficulty}星）。\n"
                f"计时表现：计划 {round(task.planned_duration_sec / 60, 1)} 分钟，实际专注 {round(task.actual_duration_sec / 60, 1)} 分钟，暂停 {task.pause_count} 次。\n"
                f"孩子语音自述：「{task.summary_voice_text or '已认真完成作业'}」\n"
                f"历史首次得分：{task.initial_score}，当前得分：{task.earned_score}。\n"
                f"学生长期学情记忆摘要（MEMORY.md）：\n{memory_excerpt}\n"
                f"各页辅助梳理摘要：{json.dumps(pages_meta_payload, ensure_ascii=False)}\n"
                f"本任务待订正旧错题：{json.dumps(open_mistakes_payload, ensure_ascii=False)}\n\n"
                "注意批阅与错题定位规则：\n"
                "1. 本任务采用独立 100 分制（专注30 + 完整度30 + 准确率40）。若 uploadKind 为 correction（错题订正重传）且新上传照片上明确改对了旧错题，允许在原分基础上追回最高 80% 的扣分（不超过98分），并把对应 mistakeId 列入 masteredMistakeIds。\n"
                "2. 请直接看原图上的印刷题目、图表/图形/扑克牌/表格以及孩子手写答案，逐题核算真伪！发现错题、漏写过程或易错点时，在 newMistakes 中给出原图对应的 `imageId` 与该道题在正立原图上的 0-1000 归一化框坐标 `box: [x1, y1, x2, y2]`（把整道小题题干与学生手写答案完整框住），并配分步解析与一道同类巩固练习题（多页试卷若错题超过8处，精选最关键的最多8道代表性错题）。\n"
                "3. `quickPraise` 必须是首尾完整、独立可读的总结评语（先肯定做对亮点，再点明具体改进结论与鼓励收尾），严禁出现“我们一道一道来！”“下面一起来看看”等半截悬空结尾。\n"
                "4. `memoryNote` 写一句简练的本次学情观察（用于追加记录到孩子的长期记忆档案）。\n"
                "最后请严格只输出一个纯 JSON 对象：\n"
                "{\n"
                '  "score": 92,\n'
                '  "quickPraise": "海星老师首尾完整、独立自洽的总结夸奖与改进点拨（70-130字，句意闭合完整）",\n'
                '  "memoryNote": "一句话记录本次作业暴露的知识点掌握与薄弱项",\n'
                '  "masteredMistakeIds": [],\n'
                '  "newMistakes": [\n'
                "    {\n"
                '      "imageId": "对应图片imageId",\n'
                '      "box": [60, 350, 920, 560],\n'
                '      "questionTitle": "错题/易错题简短标题",\n'
                '      "wrongSnippet": "孩子原卷上的错误写法或缺失过程",\n'
                '      "errorCause": "温柔清晰的错因分析",\n'
                '      "correctSteps": ["第一步：...", "第二步：...", "第三步：得出正确答案..."],\n'
                '      "practiceQuestion": "一道同知识点举一反三小练习题",\n'
                '      "practiceAnswer": "练习题答案与简析",\n'
                '      "spokenExplanation": "海星老师给孩子语音讲这道错题的口语讲稿（80-150字）"\n'
                "    }\n"
                "  ]\n"
                "}"
            )

            async with job_supervisor.keep_alive(job_id):
                if vlm_pages:
                    eval_data = await call_supervised_vlm_json(
                        task_kind="homework_review",
                        prompt_text=vlm_review_prompt,
                        images=vlm_pages,
                        audit_fn=audit_dsh_payload_completeness,
                        audit_context={"uploadKind": upload_kind},
                        max_tokens=min(98304, max(32768, 16384 * len(vlm_pages))),
                        timeout_sec=300.0,
                    )
                else:
                    eval_data, new_session_id = await run_supervised_dsh_task(
                        child,
                        task_kind="homework_review",
                        task_prompt=vlm_review_prompt,
                        context={"uploadKind": upload_kind},
                    )
                    if new_session_id:
                        child.dsh_tutor_session_id = new_session_id

            mem_note = str(eval_data.get("memoryNote") or "").strip()
            if mem_note:
                with memory_file.open("a", encoding="utf-8") as mf:
                    mf.write(f"\n- [{task.task_date} · {task.title}] {mem_note}\n")
            if eval_data.get("newMistakes"):
                with mistakes_jsonl_file.open("a", encoding="utf-8") as jf:
                    for m_raw in eval_data.get("newMistakes") or []:
                        jf.write(
                            json.dumps(
                                {
                                    "date": task.task_date,
                                    "task": task.title,
                                    "subject": task.subject,
                                    "title": m_raw.get("questionTitle"),
                                    "wrong": m_raw.get("wrongSnippet"),
                                    "cause": m_raw.get("errorCause"),
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )

            await update_job_progress(
                job_id,
                "tts_running",
                "正在裁切原卷错题框并渲染图文精讲卡片...",
            )

            new_score = max(0, min(100, int(eval_data.get("score", 90))))
            prev_score = task.earned_score
            if task.initial_score is None:
                task.initial_score = new_score
            if upload_kind == "correction" and prev_score is not None:
                task.revision_count += 1
                task.earned_score = max(prev_score, new_score)
            else:
                task.earned_score = new_score

            praise_text = str(eval_data.get("quickPraise") or f"太棒啦！本关拿到了 {task.earned_score} 分！")
            task.ai_quick_praise = praise_text
            task.praise_tts_key = None
            task.status = "completed"
            task.completed_at = None
            task.updated_at = utc_now_iso()

            if prev_score is None:
                child.star_coins += task.reward_stars
            elif task.earned_score > prev_score:
                child.star_coins += max(5, (task.earned_score - prev_score))

            mastered_ids = set(eval_data.get("masteredMistakeIds") or [])
            if mastered_ids:
                for m in existing_mistakes:
                    if m.id in mastered_ids and m.mastery_status != "mastered":
                        m.mastery_status = "mastered"
                        m.mastered_at = utc_now_iso()

            incoming_mistakes = list(eval_data.get("newMistakes") or [])
            active_mistakes: list[MistakeModel] = []
            if upload_kind == "initial" and incoming_mistakes:
                for m in existing_mistakes:
                    if m.mastery_status == "mastered":
                        active_mistakes.append(m)
                    else:
                        await db.delete(m)
            else:
                active_mistakes = list(existing_mistakes)

            img_map = {im.id: im for im in all_images}
            seen_keys: list[tuple[str, str | None]] = [
                (m.question_title, m.image_id) for m in active_mistakes
            ]
            inserted_count = 0

            for m_item in incoming_mistakes:
                src_img_id = m_item.get("imageId")
                norm_img_id = src_img_id if src_img_id in img_map else None
                q_title = str(m_item.get("questionTitle") or "重点错题精讲")

                if any(
                    is_same_mistake_question(q_title, norm_img_id, prev_t, prev_img)
                    for prev_t, prev_img in seen_keys
                ):
                    continue
                seen_keys.append((q_title, norm_img_id))

                m_id = f"mstk-{uuid.uuid4().hex[:12]}"
                box_coords = m_item.get("box") or []
                crop_key: str | None = None

                if norm_img_id and isinstance(box_coords, list) and len(box_coords) == 4:
                    if norm_img_id not in image_bytes_cache:
                        raw_b, _ = await minio_gateway.get_object_bytes(img_map[norm_img_id].minio_key)
                        image_bytes_cache[norm_img_id] = raw_b
                    cropped_jpeg = crop_mistake_region_jpeg(
                        image_bytes_cache[norm_img_id],
                        [int(v) for v in box_coords],
                    )
                    if cropped_jpeg:
                        crop_key = f"ocr-crops/{task.child_id}/{m_id}.jpg"
                        await minio_gateway.put_bytes(crop_key, cropped_jpeg, "image/jpeg")

                w_snip = str(m_item.get("wrongSnippet") or "见原卷标注区域")
                e_cause = str(m_item.get("errorCause") or "审题或计算细节需留意")
                c_steps = [str(s) for s in (m_item.get("correctSteps") or ["对照题目条件逐步演算核对"])]
                p_ques = str(m_item.get("practiceQuestion") or "")
                p_ans = str(m_item.get("practiceAnswer") or "")

                svg_bytes = render_mistake_explanation_svg(
                    q_title,
                    w_snip,
                    e_cause,
                    c_steps,
                    p_ques,
                )
                diagram_key = f"dsh-diagrams/{task.child_id}/{m_id}.svg"
                await minio_gateway.put_bytes(diagram_key, svg_bytes, "image/svg+xml")

                db.add(
                    MistakeModel(
                        id=m_id,
                        child_id=child.id,
                        task_id=task.id,
                        image_id=norm_img_id,
                        question_title=q_title,
                        wrong_snippet=w_snip,
                        error_cause=e_cause,
                        correct_steps_json=json.dumps(c_steps, ensure_ascii=False),
                        practice_question=p_ques,
                        practice_answer=p_ans,
                        crop_minio_key=crop_key,
                        diagram_minio_key=diagram_key,
                        tts_minio_key=None,
                        mastery_status="open",
                    )
                )
                inserted_count += 1

            final_iso = utc_now_iso()
            task.updated_at = final_iso
            job = await db.get(AsyncJobModel, job_id)
            if job:
                job.status = "succeeded"
                job.progress_text = "批阅与图文错题讲解已生成完毕！"
                job.result_json = json.dumps({"earnedScore": task.earned_score}, ensure_ascii=False)
                job.finished_at = final_iso

            await db.commit()
            log_event(
                "homework.review_succeeded",
                f"作业异步批阅完成: {task.title}",
                jobId=job_id,
                childId=child.id,
                taskId=task.id,
                uploadKind=upload_kind,
                ocrNewImages=total_pending,
                earnedScore=task.earned_score,
                newMistakes=inserted_count,
                elapsedMs=round((time.perf_counter() - started) * 1000, 1),
            )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log_error(
            "homework.review_failed",
            f"作业异步批阅失败 (task={task_id}, job={job_id})",
            exc=exc,
            jobId=job_id,
            taskId=task_id,
            uploadKind=upload_kind,
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        async with AsyncSessionLocal() as db:
            job = await db.get(AsyncJobModel, job_id)
            if job:
                job.status = "failed"
                job.progress_text = "异步批阅处理失败"
                job.error_detail = str(exc)
                job.finished_at = utc_now_iso()
                await db.commit()
    finally:
        job_supervisor.mark_finished(job_id)


async def execute_daily_evaluation_job(job_id: str, child_id: str, eval_date: str) -> None:
    started = time.perf_counter()
    job_supervisor.mark_started(job_id)
    try:
        async with AsyncSessionLocal() as db:
            child = await db.get(ChildModel, child_id)
            if not child:
                raise RuntimeError("未找到儿童档案")

            t_res = await db.execute(
                select(TaskModel).where(
                    TaskModel.child_id == child_id,
                    TaskModel.task_date == eval_date,
                )
            )
            day_tasks = list(t_res.scalars().all())
            completed_tasks = [t for t in day_tasks if t.status == "completed"]
            if not completed_tasks:
                raise RuntimeError("当日尚无已完成的学习任务，无法生成每日总评")

            m_res = await db.execute(
                select(MistakeModel).where(
                    MistakeModel.child_id == child_id,
                    MistakeModel.task_id.in_([t.id for t in day_tasks]),
                )
            )
            day_mistakes = list(m_res.scalars().all())

            await update_job_progress(
                job_id,
                "dsh_running",
                f"正在由 {child.display_name} 专属 DSH 智能体复盘全天任务与错题记忆并撰写总评...",
            )

            summary_payload = [
                {
                    "title": t.title,
                    "subject": t.subject,
                    "status": t.status,
                    "plannedMin": round(t.planned_duration_sec / 60, 1),
                    "actualMin": round(t.actual_duration_sec / 60, 1),
                    "pauseCount": t.pause_count,
                    "initialScore": t.initial_score,
                    "earnedScore": t.earned_score,
                    "revisionCount": t.revision_count,
                    "childVoiceSummary": t.summary_voice_text,
                }
                for t in day_tasks
            ]
            mistakes_payload = [
                {
                    "questionTitle": m.question_title,
                    "errorCause": m.error_cause,
                    "masteryStatus": m.mastery_status,
                }
                for m in day_mistakes
            ]

            prompt = (
                f"任务类型：生成 {eval_date} 每日综合100分制评分与伴读讲评。\n"
                f"学生：{child.display_name}（{child.age}岁，{child.grade_label}，生日 {child.birth_date}）。\n"
                f"今日全部任务数据：{json.dumps(summary_payload, ensure_ascii=False)}\n"
                f"今日错题与订正数据：{json.dumps(mistakes_payload, ensure_ascii=False)}\n\n"
                "请先读取并更新当前目录下的 `MEMORY.md`（记录今日总体表现与长期成长趋势）。\n"
                "按 100 分制四维评分（completion 0-30, focus 0-25, quality 0-30, habit 0-15，四项之和等于 totalScore），"
                "并输出严格纯 JSON 对象：\n"
                "{\n"
                '  "totalScore": 94,\n'
                '  "dimensionScores": {"completion": 30, "focus": 23, "quality": 27, "habit": 14},\n'
                '  "badgeRank": "SSR 或 SR 或 A 或 B",\n'
                '  "badgeTitle": "如 闪耀星莓小女王 / 四年级魔法优等星",\n'
                '  "childCommentarySentences": [\n'
                f'    "第一句：亲切呼唤{child.display_name}并公布今日总分与荣誉称号",\n'
                '    "第二句：具体表扬今天某项作业或主动订正错题的高光表现",\n'
                '    "第三句：温和点出1个小细节改进建议",\n'
                '    "第四句：充满期待的明日小约定"\n'
                "  ],\n"
                '  "parentSummary": "给家长看的客观学情汇总（完成率、有效专注时长、错题掌握度）",\n'
                '  "weakPoints": ["今日暴露的具体薄弱知识点1"],\n'
                '  "tomorrowTips": ["明日可执行复习建议1", "明日习惯建议2"]\n'
                "}"
            )

            async with job_supervisor.keep_alive(job_id):
                eval_out, new_session_id = await run_supervised_dsh_task(
                    child,
                    task_kind="daily_eval",
                    task_prompt=prompt,
                )
            if new_session_id:
                child.dsh_tutor_session_id = new_session_id

            sentences = [str(s) for s in (eval_out.get("childCommentarySentences") or [])]
            if not sentences:
                sentences = [f"{child.display_name}，今天你认真完成了学习任务，继续加油哦！"]

            tts_key: str | None = None

            watermark_iso = max((t.updated_at for t in day_tasks), default=utc_now_iso())
            dims = eval_out.get("dimensionScores") or {
                "completion": 28,
                "focus": 22,
                "quality": 26,
                "habit": 14,
            }
            total_score = max(0, min(100, int(eval_out.get("totalScore", sum(dims.values())))))

            ex_res = await db.execute(
                select(DailyEvalModel).where(
                    DailyEvalModel.child_id == child_id,
                    DailyEvalModel.eval_date == eval_date,
                )
            )
            existing_eval = ex_res.scalar_one_or_none()
            now_iso = utc_now_iso()

            if existing_eval:
                existing_eval.total_score = total_score
                existing_eval.dimension_scores_json = json.dumps(dims, ensure_ascii=False)
                existing_eval.badge_rank = str(eval_out.get("badgeRank") or "SR")
                existing_eval.badge_title = str(eval_out.get("badgeTitle") or "星莓优等星")
                existing_eval.child_sentences_json = json.dumps(sentences, ensure_ascii=False)
                existing_eval.tts_minio_key = tts_key
                existing_eval.parent_summary = str(eval_out.get("parentSummary") or "")
                existing_eval.weak_points_json = json.dumps(eval_out.get("weakPoints") or [], ensure_ascii=False)
                existing_eval.tomorrow_tips_json = json.dumps(eval_out.get("tomorrowTips") or [], ensure_ascii=False)
                existing_eval.dsh_session_id = new_session_id
                existing_eval.evaluated_watermark_iso = watermark_iso
                existing_eval.updated_at = now_iso
            else:
                db.add(
                    DailyEvalModel(
                        id=f"eval-{uuid.uuid4().hex[:12]}",
                        child_id=child_id,
                        eval_date=eval_date,
                        total_score=total_score,
                        dimension_scores_json=json.dumps(dims, ensure_ascii=False),
                        badge_rank=str(eval_out.get("badgeRank") or "SR"),
                        badge_title=str(eval_out.get("badgeTitle") or "星莓优等星"),
                        child_sentences_json=json.dumps(sentences, ensure_ascii=False),
                        tts_minio_key=tts_key,
                        parent_summary=str(eval_out.get("parentSummary") or ""),
                        weak_points_json=json.dumps(eval_out.get("weakPoints") or [], ensure_ascii=False),
                        tomorrow_tips_json=json.dumps(eval_out.get("tomorrowTips") or [], ensure_ascii=False),
                        dsh_session_id=new_session_id,
                        evaluated_watermark_iso=watermark_iso,
                        updated_at=now_iso,
                    )
                )

            job = await db.get(AsyncJobModel, job_id)
            if job:
                job.status = "succeeded"
                job.progress_text = "今日综合评分与语音讲评已生成！"
                job.result_json = json.dumps({"totalScore": total_score}, ensure_ascii=False)
                job.finished_at = now_iso

            await db.commit()
            log_event(
                "daily_eval.succeeded",
                f"每日总评生成完成: {eval_date} ({total_score}分)",
                jobId=job_id,
                childId=child_id,
                evalDate=eval_date,
                totalScore=total_score,
                badgeRank=str(eval_out.get("badgeRank") or "SR"),
                elapsedMs=round((time.perf_counter() - started) * 1000, 1),
            )
    except Exception as exc:
        log_error(
            "daily_eval.failed",
            f"每日总评生成失败 ({child_id} @ {eval_date})",
            exc=exc,
            jobId=job_id,
            childId=child_id,
            evalDate=eval_date,
            elapsedMs=round((time.perf_counter() - started) * 1000, 1),
        )
        async with AsyncSessionLocal() as db:
            job = await db.get(AsyncJobModel, job_id)
            if job:
                job.status = "failed"
                job.progress_text = "生成每日总评失败"
                job.error_detail = str(exc)
                job.finished_at = utc_now_iso()
                await db.commit()
    finally:
        job_supervisor.mark_finished(job_id)
