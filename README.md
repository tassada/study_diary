# 星莓伴学（StudyDiary）

面向小学儿童的跨端 AI 伴学与作业复盘系统（原生 iPadOS App + 响应式 Web + PC 督学与日志总控台）。

## 核心特性

- **全语音建任务与真实开始计时**：支持儿童语音建立学习任务，不生成虚拟排期；以点击「开始计时」的真实时刻记录开始时间，仅记录实际专注耗时与任务最后更新时间。
- **作业拍照自动纠偏与异步 AI 批阅**：支持多页连拍、俯拍横图自动识别旋转放正、全图预览灯箱（±90°/180° 旋转、缩放平移、一键持久化放正）。
- **双会话监督与常驻守护线程**：每个儿童拥有独立 `MEMORY.md` 与 `mistakes.jsonl` 长期记忆；后台由守护线程与独立监督补全会话（Dual-Session Supervisor）保障批阅与错题精讲完整收口。
- **拍照涂抹中英双语词典**：支持画笔涂抹选词、笔画部首、多义项、近反义词及音标查询。
- **按需语音合成与去重缓存**：所有语音播报仅在点击播放按钮时按需请求合成，并按文本哈希在对象存储永久缓存复用。
- **iPad 原生前置静默专注度与点阵回放**：基于 ARKit TrueDepth / Vision 本地静默统计在座率、专注度与用眼距离，支持本地 84 点阵回放。
- **PC 管理后台（`/admin`）**：通过预设 `ADMIN_TOKEN` 登录，支持多孩切换、任务与原卷审查、错题与长期记忆查看、每日专注度报表及结构化错误审计日志。

## 目录结构

- `backend/` — FastAPI + SQLAlchemy 2.0 (Async) + MinIO + DeepSeek OCR/ASR/TTS + DSH 智能体编排服务
- `frontend/` — React 19 + TypeScript + Tailwind CSS 4 + Capacitor 8 iPadOS 工程
- `docs/` — 产品需求、UI/UX 与技术架构设计文档

## 快速启动

1. **后端配置与启动**：
   ```bash
   cd backend
   cp .env.example .env
   python3 -m venv .venv
   ./.venv/bin/pip install -r requirements.txt
   ./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```

2. **前端开发与构建**：
   ```bash
   cd frontend
   pnpm install
   pnpm dev
   ```

3. **iPadOS 真机编译安装（可选）**：
   复制 `frontend/.env.example` 为 `frontend/.env.ipad.local` 填入本地设备与签名参数后执行 `bash frontend/install_to_ipad.sh`。
