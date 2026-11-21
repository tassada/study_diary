# 小星伴学（StudyDiary）— 文档索引

面向 **iPad / Android Pad / Phone** 的小学生全语音 AI 学习记录与伴学系统（免登录多孩内置档案 + 全语音建任务/总结 + 正倒计时 + 作业拍照 OCR + DeepSeek 每日评分讲评）。

## 设计与架构文档清单

1. **[01-product-requirements.md](./01-product-requirements.md) — 产品需求文档（PRD v1.0）**
   - 产品定位、多端使用场景、内置多孩免登录档案与轻量家长视图
   - 五大核心模块详述：周/月日历与每日任务时间线、全语音建任务（自动标签+自动预设打分）、正/倒计时专注舱、拍作业 OCR + 全语音交成果、DeepSeek 每日 100 分制四维评分与语音伴读讲评
2. **[02-ui-ux-design.md](./02-ui-ux-design.md) — UI/UX 多端与适儿化交互设计方案（v1.0）**
   - 6–12 岁小学生零键盘交互准则、护眼配色与学科图标视觉编码
   - iPad/Android Pad 横屏双栏、平板竖屏、手机竖屏三档自适应线框布局
   - 语音建任务状态机、全屏专注计时舱、15 秒拍照+语音交作业、每日讲评伴读高亮交互细节及 PWA 桌面级体验优化（Wake Lock 常亮锁等）
3. **[03-technical-architecture.md](./03-technical-architecture.md) — 前后端技术架构设计文档（v1.0）**
   - React + TypeScript + Tailwind PWA 前端与 Python FastAPI + SQLite/PostgreSQL 后端架构
   - 可插拔外部 AI 能力网关（`DeepSeek` / `ASR` / `OCR` / `TTS` 标准 Adapter 协议）与跨 iOS/Android 浏览器录音 `16kHz WAV` 统一转码方案
   - 完整数据库 ER 图与 6 张核心表结构、DeepSeek 三大核心场景 JSON Schema 契约、`/api/v1` 接口清单、工程目录结构与四阶段实施路线图
