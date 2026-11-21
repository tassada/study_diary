import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ImagePreviewLightbox,
  type LightboxMediaItem,
  type LightboxRotatableTarget,
} from '../components/ImagePreviewLightbox'
import { GirlAvatarSprite } from '../components/PixelSprites'
import { formatCnDateTime, getTodayDateStr, SUBJECT_CONFIG } from '../config/pixelTheme'
import { studyApi } from '../services/apiClient'
import type {
  AttentionStateKey,
  AuditLogResponse,
  DailyAttentionReport,
  DailyEvaluation,
  DictionaryLookup,
  StudyTask,
  TaskImageItem,
} from '../types/study'
import {
  adminApi,
  AdminUnauthorizedError,
  clearAdminToken,
  getStoredAdminToken,
  saveAdminToken,
  type AdminAttentionDateSummary,
  type AdminChildMemoryData,
  type AdminChildOverviewItem,
} from './adminApi'

type AdminTab =
  | 'overview'
  | 'tasks'
  | 'mistakes_memory'
  | 'attention'
  | 'dictionary'
  | 'logs'

const ATT_COLORS: Record<AttentionStateKey, { label: string; hex: string }> = {
  focused: { label: '认真看书', hex: '#22C55E' },
  distracted: { label: '扭头走神', hex: '#FACC15' },
  drowsy: { label: '闭眼发呆', hex: '#A855F7' },
  near_posture: { label: '距离过近', hex: '#F97316' },
  away: { label: '离开座位', hex: '#CBD5E1' },
}

function fmtSec(sec: number): string {
  if (sec <= 0) return '0秒'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m === 0) return `${s}秒`
  if (s === 0) return `${m}分钟`
  return `${m}分${s}秒`
}

export function AdminConsoleApp() {
  const [token, setToken] = useState<string>(() => getStoredAdminToken())
  const [authed, setAuthed] = useState(false)
  const [loginInput, setLoginInput] = useState('')
  const [rememberToken, setRememberToken] = useState(true)
  const [showToken, setShowToken] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authChecking, setAuthChecking] = useState<boolean>(() => Boolean(getStoredAdminToken()))

  const [childrenList, setChildrenList] = useState<AdminChildOverviewItem[]>([])
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<AdminTab>('overview')
  const [refreshing, setRefreshing] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)

  const [tasks, setTasks] = useState<StudyTask[]>([])
  const [taskDateFilter, setTaskDateFilter] = useState<string>('')
  const [evaluations, setEvaluations] = useState<DailyEvaluation[]>([])
  const [memoryData, setMemoryData] = useState<AdminChildMemoryData | null>(null)
  const [mistakeFilter, setMistakeFilter] = useState<'all' | 'open' | 'mastered'>('all')

  const [attDate, setAttDate] = useState<string>(() => getTodayDateStr())
  const [attDates, setAttDates] = useState<AdminAttentionDateSummary[]>([])
  const [attReport, setAttReport] = useState<DailyAttentionReport | null>(null)

  const [dictHistory, setDictHistory] = useState<DictionaryLookup[]>([])
  const [logsData, setLogsData] = useState<AuditLogResponse | null>(null)
  const [logLevel, setLogLevel] = useState<'all' | 'error'>('all')
  const [logScope, setLogScope] = useState<'child' | 'global'>('child')

  const [lightboxState, setLightboxState] = useState<{
    items: LightboxMediaItem[]
    initialIndex: number
  } | null>(null)
  const [mediaUrlOverrides, setMediaUrlOverrides] = useState<Record<string, string>>({})
  const [showCreateChild, setShowCreateChild] = useState(false)
  const [newName, setNewName] = useState('')
  const [newBirth, setNewBirth] = useState('2017-06-01')
  const [newGender, setNewGender] = useState('女')
  const [newAge, setNewAge] = useState(9)
  const [newGrade, setNewGrade] = useState('小学四年级')
  const [newGoal, setNewGoal] = useState(75)

  const handleLogout = useCallback((reason?: string) => {
    clearAdminToken()
    setToken('')
    setAuthed(false)
    if (reason) setAuthError(reason)
  }, [])

  const loadChildrenAndInit = useCallback(
    async (activeToken: string) => {
      const rows = await adminApi.listChildren(activeToken)
      setChildrenList(rows)
      setSelectedChildId((prev) => {
        if (prev && rows.some((r) => r.profile.id === prev)) return prev
        return rows[0]?.profile.id ?? null
      })
    },
    [],
  )

  useEffect(() => {
    const saved = getStoredAdminToken()
    if (!saved) {
      setAuthChecking(false)
      return
    }
    adminApi
      .verifyToken(saved)
      .then(async () => {
        setToken(saved)
        setAuthed(true)
        await loadChildrenAndInit(saved)
      })
      .catch((err) => {
        handleLogout(err instanceof Error ? err.message : '登录已失效')
      })
      .finally(() => setAuthChecking(false))
  }, [handleLogout, loadChildrenAndInit])

  const handleLoginSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const clean = loginInput.trim()
    if (!clean) {
      setAuthError('请输入预设管理 Token')
      return
    }
    setAuthChecking(true)
    setAuthError(null)
    try {
      await adminApi.verifyToken(clean)
      saveAdminToken(clean, rememberToken)
      setToken(clean)
      setAuthed(true)
      setLoginInput('')
      await loadChildrenAndInit(clean)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '登录校验失败')
    } finally {
      setAuthChecking(false)
    }
  }

  const loadSelectedChildData = useCallback(async () => {
    if (!authed || !token || !selectedChildId) return
    setRefreshing(true)
    setErrorBanner(null)
    try {
      const [freshChildren, childTasks, childEvals, childMem, childDict, childAttDates, childAtt, sysLogs] =
        await Promise.all([
          adminApi.listChildren(token),
          adminApi.listChildTasks(token, selectedChildId, taskDateFilter || undefined),
          adminApi.listChildEvaluations(token, selectedChildId),
          adminApi.getChildMemory(token, selectedChildId),
          adminApi.listChildDictionary(token, selectedChildId),
          adminApi.listChildAttentionDates(token, selectedChildId),
          adminApi.getChildAttention(token, selectedChildId, attDate),
          adminApi.getLogs(token, {
            level: logLevel,
            childId: logScope === 'child' ? selectedChildId : null,
            limit: 150,
          }),
        ])
      setChildrenList(freshChildren)
      setTasks(childTasks)
      setEvaluations(childEvals)
      setMemoryData(childMem)
      setDictHistory(childDict)
      setAttDates(childAttDates)
      setAttReport(childAtt)
      setLogsData(sysLogs)
    } catch (err) {
      if (err instanceof AdminUnauthorizedError) {
        handleLogout(err.message)
        return
      }
      setErrorBanner(err instanceof Error ? err.message : '加载管理数据失败')
    } finally {
      setRefreshing(false)
    }
  }, [attDate, authed, handleLogout, logLevel, logScope, selectedChildId, taskDateFilter, token])

  useEffect(() => {
    void loadSelectedChildData()
  }, [loadSelectedChildData])

  const selectedChildItem = useMemo(
    () => childrenList.find((c) => c.profile.id === selectedChildId) ?? null,
    [childrenList, selectedChildId],
  )

  const allMistakes = useMemo(() => {
    const out: Array<{
      taskTitle: string
      taskDate: string
      mistake: StudyTask['mistakes'][number]
      sourceImage: TaskImageItem | null
      taskImages: TaskImageItem[]
    }> = []
    for (const t of tasks) {
      for (const m of t.mistakes) {
        if (mistakeFilter === 'open' && m.masteryStatus !== 'open') continue
        if (mistakeFilter === 'mastered' && m.masteryStatus !== 'mastered') continue
        const sourceImage =
          (m.imageId ? t.images.find((im) => im.id === m.imageId) : null) ??
          t.images[0] ??
          null
        out.push({
          taskTitle: t.title,
          taskDate: t.taskDate,
          mistake: m,
          sourceImage,
          taskImages: t.images,
        })
      }
    }
    return out
  }, [mistakeFilter, tasks])

  const resolveMediaUrl = useCallback(
    (entityId: string, defaultUrl: string | null | undefined): string => {
      if (!defaultUrl) return ''
      return mediaUrlOverrides[entityId] ?? defaultUrl
    },
    [mediaUrlOverrides],
  )

  const handlePersistRotation = useCallback(
    async (target: LightboxRotatableTarget, degreesCw: 90 | 180 | 270): Promise<string> => {
      if (target.kind === 'task_image') {
        const res = await adminApi.rotateTaskImage(token, target.id, degreesCw)
        setMediaUrlOverrides((prev) => ({ ...prev, [target.id]: res.imageUrl }))
        void loadSelectedChildData()
        return res.imageUrl
      }
      const res = await adminApi.rotateMistakeCrop(token, target.id, degreesCw)
      setMediaUrlOverrides((prev) => ({ ...prev, [target.id]: res.cropImageUrl }))
      void loadSelectedChildData()
      return res.cropImageUrl
    },
    [loadSelectedChildData, token],
  )

  const openTaskImagesLightbox = (taskObj: StudyTask, startIdx: number) => {
    const items: LightboxMediaItem[] = taskObj.images.map((im, idx) => ({
      key: `task-img-${im.id}`,
      label: `📄 原卷第 ${idx + 1} 张 (${im.uploadKind === 'correction' ? '订正' : im.uploadKind === 'supplement' ? '补传' : '初交'})`,
      url: resolveMediaUrl(im.id, im.imageUrl),
      subTitle: `${taskObj.taskDate} · ${taskObj.title}`,
      sideTitle: '作业原图 OCR 识别文本',
      sideBody: im.ocrPlainText || '尚未执行 OCR',
      rotatableTarget: { kind: 'task_image', id: im.id },
    }))
    if (items.length > 0) {
      setLightboxState({ items, initialIndex: startIdx })
    }
  }

  const openMistakeLightbox = (
    entry: (typeof allMistakes)[number],
    preferred: 'full' | 'crop' | 'diagram',
  ) => {
    const m = entry.mistake
    const detailSummary = [
      `题目：${m.questionTitle}`,
      `所属任务：${entry.taskDate} · ${entry.taskTitle}`,
      '',
      `【原卷错点】\n${m.wrongSnippet}`,
      '',
      `【错因分析】\n${m.errorCause}`,
      ...(m.correctSteps.length > 0
        ? ['', `【订正步骤】\n${m.correctSteps.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}`]
        : []),
      ...(m.practiceQuestion
        ? ['', `【巩固练习】\n${m.practiceQuestion}\n参考答案：${m.practiceAnswer}`]
        : []),
    ].join('\n')

    const items: LightboxMediaItem[] = []
    let fullIdx = -1
    let cropIdx = -1
    let diagIdx = -1

    if (entry.sourceImage) {
      fullIdx = items.length
      items.push({
        key: `mstk-full-${entry.sourceImage.id}`,
        label: '📄 原卷全图',
        url: resolveMediaUrl(entry.sourceImage.id, entry.sourceImage.imageUrl),
        subTitle: `${entry.taskDate} · ${m.questionTitle}`,
        sideTitle: '错题剖析与原卷 OCR',
        sideBody: `${detailSummary}\n\n━━━━━━━━━━━━━━\n【本页 OCR 识别】\n${entry.sourceImage.ocrPlainText || '暂无 OCR 文本'}`,
        rotatableTarget: { kind: 'task_image', id: entry.sourceImage.id },
      })
    }

    entry.taskImages.forEach((im, idx) => {
      if (entry.sourceImage && im.id === entry.sourceImage.id) return
      items.push({
        key: `mstk-otherpage-${im.id}`,
        label: `📄 同作业第 ${idx + 1} 张`,
        url: resolveMediaUrl(im.id, im.imageUrl),
        subTitle: `${entry.taskDate} · ${entry.taskTitle}`,
        sideTitle: `第 ${idx + 1} 张 OCR`,
        sideBody: im.ocrPlainText || '暂无 OCR 文本',
        rotatableTarget: { kind: 'task_image', id: im.id },
      })
    })

    if (m.cropImageUrl) {
      cropIdx = items.length
      items.push({
        key: `mstk-crop-${m.id}`,
        label: '✂️ 错题局部截图',
        url: resolveMediaUrl(m.id, m.cropImageUrl),
        subTitle: `${entry.taskDate} · ${m.questionTitle}`,
        sideTitle: '错题剖析与步骤',
        sideBody: detailSummary,
        rotatableTarget: { kind: 'mistake_crop', id: m.id },
      })
    }

    if (m.diagramImageUrl) {
      diagIdx = items.length
      items.push({
        key: `mstk-diag-${m.id}`,
        label: '📊 AI 精讲图卡',
        url: m.diagramImageUrl,
        subTitle: `${entry.taskDate} · ${m.questionTitle}`,
        sideTitle: '错题剖析与步骤',
        sideBody: detailSummary,
      })
    }

    if (items.length === 0) return

    let initialIndex = 0
    if (preferred === 'full' && fullIdx >= 0) initialIndex = fullIdx
    else if (preferred === 'crop' && cropIdx >= 0) initialIndex = cropIdx
    else if (preferred === 'diagram' && diagIdx >= 0) initialIndex = diagIdx

    setLightboxState({ items, initialIndex })
  }

  const [ttsBusyId, setTtsBusyId] = useState<string | null>(null)

  const playUrl = (url: string | null) => {
    if (!url) return
    const audio = new Audio(url)
    void audio.play()
  }

  const playTtsOnDemand = async (params: {
    keyId: string
    text: string
    bindKind?: 'task_praise' | 'mistake_explain' | 'daily_eval'
    bindId?: string
    prebuiltUrl?: string | null
  }) => {
    if (!params.text.trim() && !params.prebuiltUrl) return
    if (ttsBusyId === params.keyId) return
    setTtsBusyId(params.keyId)
    try {
      const url = await studyApi.speakOnDemand({
        text: params.text,
        bindKind: params.bindKind,
        bindId: params.bindId,
        prebuiltUrl: params.prebuiltUrl,
      })
      const audio = new Audio(url)
      audio.onended = () => setTtsBusyId(null)
      audio.onerror = () => setTtsBusyId(null)
      await audio.play()
    } catch {
      setTtsBusyId(null)
    }
  }

  const playDictWordOnDemand = async (keyId: string, word: string, prebuiltUrl: string | null) => {
    const clean = word.trim()
    if (!clean || ttsBusyId === keyId) return
    setTtsBusyId(keyId)
    try {
      const url = prebuiltUrl || (await studyApi.pronounceDictionaryWord(clean)).audioUrl
      const audio = new Audio(url)
      audio.onended = () => setTtsBusyId(null)
      audio.onerror = () => setTtsBusyId(null)
      await audio.play()
    } catch {
      setTtsBusyId(null)
    }
  }

  const handleCreateChildSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim() || !token) return
    try {
      const created = await adminApi.createChild(token, {
        displayName: newName.trim(),
        birthDate: newBirth,
        gender: newGender,
        age: newAge,
        gradeLabel: newGrade,
        dailyGoalMinutes: newGoal,
      })
      setShowCreateChild(false)
      setNewName('')
      await loadChildrenAndInit(token)
      setSelectedChildId(created.id)
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : '创建档案失败')
    }
  }

  if (!authed) {
    return (
      <div className="w-screen h-screen bg-[#F3EFF6] flex items-center justify-center p-6 select-text overflow-auto">
        <div className="bg-white border-3 border-[#4A2B44] rounded-xl shadow-[6px_6px_0_#4A2B44] max-w-md w-full p-8 space-y-6">
          <div className="flex items-center gap-3.5 border-b-2 border-slate-100 pb-4">
            <div className="w-12 h-12 rounded-lg bg-[#EC5F9B] border-2 border-[#4A2B44] flex items-center justify-center text-2xl text-white font-extrabold">
              ★
            </div>
            <div>
              <h1 className="text-2xl font-extrabold text-[#332230]">星莓伴学 · PC 管理后台</h1>
              <p className="text-sm font-medium text-slate-500">
                输入服务端预设管理 Token 进入学情总控台
              </p>
            </div>
          </div>

          {authError && (
            <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 rounded-lg px-4 py-3 text-sm font-semibold">
              ⚠️ {authError}
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1.5">
                预设管理 Token
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={loginInput}
                  onChange={(e) => setLoginInput(e.target.value)}
                  placeholder="请输入 ADMIN_TOKEN..."
                  autoFocus
                  className="w-full border-2 border-[#4A2B44] rounded-lg px-4 py-3 pr-20 text-base font-medium focus:outline-none focus:ring-2 focus:ring-pink-400"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-500 hover:text-slate-800 px-2 py-1 cursor-pointer"
                >
                  {showToken ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberToken}
                onChange={(e) => setRememberToken(e.target.checked)}
                className="rounded accent-[#EC5F9B]"
              />
              <span>在此电脑浏览器保持登录状态</span>
            </label>

            <button
              type="submit"
              disabled={authChecking}
              className="w-full bg-[#EC5F9B] hover:bg-[#d94d88] text-white font-extrabold text-base py-3 rounded-lg border-2 border-[#4A2B44] shadow-[3px_3px_0_#4A2B44] cursor-pointer transition-colors"
            >
              {authChecking ? '正在验证登录...' : '🔐 登录 PC 管理后台'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="w-screen h-screen flex bg-[#F4F5F9] text-slate-800 select-text overflow-hidden">
      <aside className="w-72 bg-white border-r-2 border-slate-200 flex flex-col justify-between shrink-0">
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <div className="text-lg font-extrabold text-[#332230]">★ 星莓伴学管理端</div>
              <div className="text-xs font-medium text-slate-500">PC 督学与日志总控台</div>
            </div>
            <button
              type="button"
              onClick={() => void loadSelectedChildData()}
              className="text-xs font-bold bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded cursor-pointer"
            >
              {refreshing ? '刷新中' : '🔄 刷新'}
            </button>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase tracking-wider text-slate-500">
              选择孩子查看 ({childrenList.length})
            </span>
            <button
              type="button"
              onClick={() => setShowCreateChild((v) => !v)}
              className="text-xs font-bold text-[#C92A6A] hover:underline cursor-pointer"
            >
              + 新增孩子
            </button>
          </div>

          {showCreateChild && (
            <form
              onSubmit={handleCreateChildSubmit}
              className="bg-pink-50/70 border border-pink-200 rounded-lg p-3 space-y-2 text-xs"
            >
              <div className="font-bold text-slate-700">新增儿童档案</div>
              <input
                type="text"
                placeholder="姓名"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                className="w-full bg-white border border-slate-300 rounded px-2 py-1.5"
              />
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  type="date"
                  value={newBirth}
                  onChange={(e) => setNewBirth(e.target.value)}
                  className="bg-white border border-slate-300 rounded px-2 py-1"
                />
                <input
                  type="text"
                  value={newGrade}
                  onChange={(e) => setNewGrade(e.target.value)}
                  placeholder="年级"
                  className="bg-white border border-slate-300 rounded px-2 py-1"
                />
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <select
                  value={newGender}
                  onChange={(e) => setNewGender(e.target.value)}
                  className="bg-white border border-slate-300 rounded px-1.5 py-1"
                >
                  <option value="女">女</option>
                  <option value="男">男</option>
                </select>
                <input
                  type="number"
                  value={newAge}
                  onChange={(e) => setNewAge(Number(e.target.value))}
                  min={4}
                  max={18}
                  className="bg-white border border-slate-300 rounded px-2 py-1"
                />
                <input
                  type="number"
                  value={newGoal}
                  onChange={(e) => setNewGoal(Number(e.target.value))}
                  min={15}
                  max={240}
                  className="bg-white border border-slate-300 rounded px-2 py-1"
                />
              </div>
              <div className="flex justify-end gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCreateChild(false)}
                  className="px-2.5 py-1 rounded bg-white border border-slate-300 font-semibold cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 rounded bg-[#EC5F9B] text-white font-bold cursor-pointer"
                >
                  创建
                </button>
              </div>
            </form>
          )}

          <div className="space-y-2.5">
            {childrenList.map((item) => {
              const c = item.profile
              const isSel = c.id === selectedChildId
              return (
                <div
                  key={c.id}
                  onClick={() => setSelectedChildId(c.id)}
                  className={`rounded-xl border-2 p-3 cursor-pointer transition-all ${
                    isSel
                      ? 'bg-[#FFF5FA] border-[#EC5F9B] shadow-sm'
                      : 'bg-slate-50/70 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="border border-[#4A2B44] bg-white rounded p-0.5 shrink-0">
                      <GirlAvatarSprite avatar={c.avatarKey} size={40} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-extrabold text-base text-slate-900 truncate">
                          {c.displayName}
                        </span>
                        <span className="text-xs font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-num">
                          {c.starCoins}★
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 font-medium mt-0.5">
                        {c.gradeLabel} · {c.age}岁 · {c.birthDate}
                      </div>
                    </div>
                  </div>

                  {item.stats.activeTaskTitle ? (
                    <div className="mt-2 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded px-2.5 py-1 text-xs font-bold flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                      <span className="truncate">正在计时：{item.stats.activeTaskTitle}</span>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500 font-num">
                      <span>
                        完成 {item.stats.completedTasks}/{item.stats.totalTasks}
                      </span>
                      <span>专注 {item.stats.totalFocusMinutes}m</span>
                      <span>待订正 {item.stats.openMistakes}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="p-4 border-t border-slate-200 flex items-center justify-between text-xs">
          <a href="/" className="font-bold text-slate-500 hover:text-slate-800">
            ↗ 打开儿童端首页
          </a>
          <button
            type="button"
            onClick={() => handleLogout()}
            className="font-bold text-rose-600 hover:underline cursor-pointer"
          >
            退出登录
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {selectedChildItem && (
          <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-4 shrink-0 flex-wrap">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-extrabold text-slate-900">
                {selectedChildItem.profile.displayName} 的学习督导看板
              </h2>
              <span className="text-xs font-bold bg-pink-100 text-pink-800 px-2.5 py-1 rounded-full">
                {selectedChildItem.profile.gradeLabel}
              </span>
              {selectedChildItem.stats.activeTaskTitle && (
                <span className="text-xs font-bold bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full">
                  ⚡ 当前正在专注：{selectedChildItem.stats.activeTaskTitle}
                </span>
              )}
            </div>

            <nav className="flex items-center gap-1.5 flex-wrap">
              {(
                [
                  ['overview', '📊 学情总览'],
                  ['tasks', `🗂️ 任务与作业 (${tasks.length})`],
                  ['mistakes_memory', `🎯 错题与AI记忆 (${selectedChildItem.stats.openMistakes}待订正)`],
                  ['attention', '👀 在座与专注度'],
                  ['dictionary', `📖 查字典 (${dictHistory.length})`],
                  ['logs', '📜 系统与报错日志'],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setActiveTab(tabKey)}
                  className={`px-3.5 py-2 rounded-lg text-sm font-bold cursor-pointer transition-colors ${
                    activeTab === tabKey
                      ? 'bg-[#332230] text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </header>
        )}

        {errorBanner && (
          <div className="mx-6 mt-4 bg-rose-50 border border-rose-300 text-rose-800 px-4 py-2.5 rounded-lg text-sm font-semibold">
            ⚠️ {errorBanner}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {selectedChildItem && activeTab === 'overview' && (
            <>
              <div className="grid grid-cols-6 gap-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs font-bold text-slate-500">任务完成进度</div>
                  <div className="text-2xl font-extrabold text-slate-900 font-num mt-1">
                    {selectedChildItem.stats.completedTasks} / {selectedChildItem.stats.totalTasks}
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs font-bold text-slate-500">累计专注时长</div>
                  <div className="text-2xl font-extrabold text-blue-600 font-num mt-1">
                    {selectedChildItem.stats.totalFocusMinutes} 分钟
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs font-bold text-slate-500">单科任务均分</div>
                  <div className="text-2xl font-extrabold text-pink-600 font-num mt-1">
                    {selectedChildItem.stats.avgScore !== null
                      ? `${selectedChildItem.stats.avgScore} 分`
                      : '—'}
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs font-bold text-slate-500">错题已掌握 / 待订正</div>
                  <div className="text-2xl font-extrabold text-emerald-600 font-num mt-1">
                    {selectedChildItem.stats.masteredMistakes} /{' '}
                    <span className="text-rose-600">{selectedChildItem.stats.openMistakes}</span>
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs font-bold text-slate-500">拍照查字典次数</div>
                  <div className="text-2xl font-extrabold text-purple-600 font-num mt-1">
                    {selectedChildItem.stats.dictionaryLookups} 次
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs font-bold text-slate-500">星莓币奖励余额</div>
                  <div className="text-2xl font-extrabold text-amber-600 font-num mt-1">
                    {selectedChildItem.profile.starCoins} 币
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
                <h3 className="text-base font-extrabold text-slate-900">
                  🏆 历次每日综合 100 分评价记录（{evaluations.length} 天）
                </h3>
                {evaluations.length === 0 ? (
                  <div className="text-sm text-slate-500 py-6 text-center">
                    暂无生成的每日总评记录
                  </div>
                ) : (
                  <div className="space-y-3">
                    {evaluations.map((ev) => (
                      <div
                        key={ev.evalDate}
                        className="border border-slate-200 rounded-lg p-4 bg-slate-50/60 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <span className="font-num font-extrabold text-base bg-white border border-slate-300 px-3 py-0.5 rounded">
                              {ev.evalDate}
                            </span>
                            <span className="bg-pink-600 text-white text-xs font-extrabold px-2.5 py-0.5 rounded">
                              {ev.badgeRank} · {ev.badgeTitle}
                            </span>
                            <span className="text-xl font-extrabold text-pink-700 font-num">
                              {ev.totalScore} 分
                            </span>
                          </div>
                          {ev.childCommentarySentences.length > 0 && (
                            <button
                              type="button"
                              disabled={ttsBusyId === `ev-${ev.evalDate}`}
                              onClick={() =>
                                void playTtsOnDemand({
                                  keyId: `ev-${ev.evalDate}`,
                                  text: ev.childCommentarySentences.join(' '),
                                  prebuiltUrl: ev.ttsAudioUrl,
                                })
                              }
                              className="text-xs font-bold bg-amber-100 hover:bg-amber-200 text-amber-900 px-3 py-1.5 rounded cursor-pointer"
                            >
                              {ttsBusyId === `ev-${ev.evalDate}` ? '⏳ 合成中...' : '🔊 听当日语音讲评'}
                            </button>
                          )}
                        </div>
                        <p className="text-sm text-slate-700 leading-relaxed">{ev.parentSummary}</p>
                        {ev.weakPoints.length > 0 && (
                          <div className="text-xs text-rose-700 font-semibold">
                            薄弱点关注：{ev.weakPoints.join('；')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {selectedChildItem && activeTab === 'tasks' && (
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h3 className="text-base font-extrabold text-slate-900">
                  🗂️ 学习任务、作业原图与语音详情
                </h3>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-slate-600">按日期筛选：</span>
                  <input
                    type="date"
                    value={taskDateFilter}
                    onChange={(e) => setTaskDateFilter(e.target.value)}
                    className="border border-slate-300 rounded px-2.5 py-1 font-num"
                  />
                  {taskDateFilter && (
                    <button
                      type="button"
                      onClick={() => setTaskDateFilter('')}
                      className="text-xs font-bold bg-slate-100 px-2.5 py-1.5 rounded cursor-pointer"
                    >
                      显示全部日期
                    </button>
                  )}
                </div>
              </div>

              {tasks.length === 0 ? (
                <div className="text-sm text-slate-500 py-10 text-center">无匹配的任务记录</div>
              ) : (
                <div className="space-y-4">
                  {tasks.map((t) => {
                    const subj = SUBJECT_CONFIG[t.subject] ?? SUBJECT_CONFIG.chinese
                    return (
                      <div
                        key={t.id}
                        className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/40"
                      >
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="font-num text-xs font-bold bg-white border border-slate-300 px-2.5 py-1 rounded">
                              {t.taskDate} · 开始 {t.plannedStartTime || '待开始'}
                            </span>
                            <span
                              className="text-xs font-bold text-white px-2.5 py-0.5 rounded"
                              style={{ backgroundColor: subj.pillHex }}
                            >
                              {subj.label}
                            </span>
                            <span className="text-base font-extrabold text-slate-900">
                              {t.title}
                            </span>
                            <span className="text-xs font-bold px-2 py-0.5 rounded bg-slate-200 text-slate-700">
                              状态：{t.status}
                            </span>
                            <span className="text-xs font-num text-slate-600 font-semibold">
                              实耗时 {fmtSec(t.actualDurationSec)} / 计划{' '}
                              {Math.round(t.plannedDurationSec / 60)}分 · 暂停 {t.pauseCount} 次 · 最后更新{' '}
                              {formatCnDateTime(t.updatedAt)}
                            </span>
                          </div>

                          <div className="flex items-center gap-3">
                            {t.earnedScore !== null && (
                              <span className="font-num text-base font-extrabold text-pink-700 bg-pink-50 border border-pink-200 px-3 py-1 rounded">
                                {t.revisionCount > 0 && t.initialScore !== null
                                  ? `初交${t.initialScore} → 订正后 ${t.earnedScore}/100`
                                  : `得分 ${t.earnedScore}/100`}
                              </span>
                            )}
                            {t.status !== 'completed' && t.images.length > 0 && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await adminApi.retryTaskReview(token, t.id, t.summaryVoiceText)
                                  await loadSelectedChildData()
                                }}
                                className="text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded cursor-pointer"
                              >
                                🔄 触发/重试改卷
                              </button>
                            )}
                            {t.status !== 'completed' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await adminApi.voidTaskAsAdmin(token, t.id)
                                  await loadSelectedChildData()
                                }}
                                className="text-xs font-bold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-3 py-1.5 rounded cursor-pointer"
                              >
                                🗑️ 作废此任务
                              </button>
                            )}
                          </div>
                        </div>

                        {t.status !== 'completed' && t.latestJobStatus === 'failed' && (
                          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 text-xs font-bold">
                            ⚠️ 最近一次异步改卷失败：{t.latestJobError || '未知异常'}（可点右上角「🔄 触发/重试改卷」）
                          </div>
                        )}

                        {(t.rawVoiceText || t.summaryVoiceText || t.aiQuickPraise) && (
                          <div className="bg-white border border-slate-200 rounded-lg p-3 text-sm space-y-1.5">
                            {t.rawVoiceText && (
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-600">
                                  <b>建任务原话：</b>“{t.rawVoiceText}”
                                </span>
                                {t.voiceAudioUrl && (
                                  <button
                                    type="button"
                                    onClick={() => playUrl(t.voiceAudioUrl)}
                                    className="text-xs font-bold text-blue-600 hover:underline shrink-0 cursor-pointer"
                                  >
                                    🔊 建任务录音
                                  </button>
                                )}
                              </div>
                            )}
                            {t.summaryVoiceText && (
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-700">
                                  <b>完成小结：</b>“{t.summaryVoiceText}”
                                </span>
                                {t.summaryAudioUrl && (
                                  <button
                                    type="button"
                                    onClick={() => playUrl(t.summaryAudioUrl)}
                                    className="text-xs font-bold text-blue-600 hover:underline shrink-0 cursor-pointer"
                                  >
                                    🔊 小结原声
                                  </button>
                                )}
                              </div>
                            )}
                            {t.aiQuickPraise && (
                              <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2 text-pink-800">
                                  <span>
                                    <b>海星老师批阅：</b>
                                    {t.aiQuickPraise}
                                  </span>
                                  <button
                                    type="button"
                                    disabled={ttsBusyId === `praise-${t.id}`}
                                    onClick={() =>
                                      void playTtsOnDemand({
                                        keyId: `praise-${t.id}`,
                                        text: t.aiQuickPraise ?? '',
                                        bindKind: 'task_praise',
                                        bindId: t.id,
                                        prebuiltUrl: t.praiseAudioUrl,
                                      })
                                    }
                                    className="text-xs font-bold text-pink-600 hover:underline shrink-0 cursor-pointer"
                                  >
                                    {ttsBusyId === `praise-${t.id}` ? '⏳ 合成中...' : '🔊 评语语音'}
                                  </button>
                                </div>

                                {t.mistakes.length > 0 && (
                                  <div className="bg-rose-50/60 border border-rose-200 rounded-lg p-2.5 space-y-2">
                                    <div className="text-xs font-extrabold text-rose-800">
                                      📌 本次作业错题逐道精讲（共 {t.mistakes.length} 道）：
                                    </div>
                                    {t.mistakes.map((m, mIdx) => {
                                      const srcImg =
                                        (m.imageId
                                          ? t.images.find((im) => im.id === m.imageId)
                                          : null) ??
                                        t.images[0] ??
                                        null
                                      return (
                                        <div
                                          key={m.id}
                                          className="bg-white border border-rose-100 rounded p-2.5 text-xs space-y-1"
                                        >
                                          <div className="flex items-center justify-between gap-2 flex-wrap">
                                            <span className="font-extrabold text-slate-900">
                                              {mIdx + 1}. {m.questionTitle}
                                            </span>
                                            <div className="flex items-center gap-2">
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  openMistakeLightbox(
                                                    {
                                                      taskTitle: t.title,
                                                      taskDate: t.taskDate,
                                                      mistake: m,
                                                      sourceImage: srcImg,
                                                      taskImages: t.images,
                                                    },
                                                    'full',
                                                  )
                                                }
                                                className="text-blue-700 font-bold hover:underline cursor-pointer"
                                              >
                                                📄 看原卷全图
                                              </button>
                                              <button
                                                type="button"
                                                disabled={ttsBusyId === `task-mstk-${m.id}`}
                                                onClick={() =>
                                                  void playTtsOnDemand({
                                                    keyId: `task-mstk-${m.id}`,
                                                    text: `${m.questionTitle}。${m.errorCause}。${m.correctSteps.join('；')}`,
                                                    bindKind: 'mistake_explain',
                                                    bindId: m.id,
                                                    prebuiltUrl: m.ttsAudioUrl,
                                                  })
                                                }
                                                className="text-pink-700 font-bold hover:underline cursor-pointer"
                                              >
                                                {ttsBusyId === `task-mstk-${m.id}`
                                                  ? '⏳ 合成中'
                                                  : '🔊 听讲题'}
                                              </button>
                                            </div>
                                          </div>
                                          <div className="text-slate-700">
                                            <b className="text-rose-700">错点：</b>
                                            {m.wrongSnippet} ｜ <b>错因：</b>
                                            {m.errorCause}
                                          </div>
                                          {m.correctSteps.length > 0 && (
                                            <div className="text-emerald-800 font-medium">
                                              <b>订正步骤：</b>
                                              {m.correctSteps.join(' ')}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {t.images.length > 0 && (
                          <div className="flex flex-wrap gap-3 pt-1">
                            {t.images.map((im, idx) => (
                              <div
                                key={im.id}
                                onClick={() => openTaskImagesLightbox(t, idx)}
                                className="w-40 bg-white border border-slate-300 rounded-lg p-2 cursor-pointer hover:border-pink-400 transition-colors"
                              >
                                <img
                                  src={resolveMediaUrl(im.id, im.imageUrl)}
                                  alt={im.fileName}
                                  className="w-full h-28 object-cover rounded"
                                />
                                <div className="mt-1.5 flex items-center justify-between text-xs font-semibold text-slate-600">
                                  <span>
                                    图{idx + 1} (
                                    {im.uploadKind === 'correction'
                                      ? '订正'
                                      : im.uploadKind === 'supplement'
                                        ? '补传'
                                        : '初交'}
                                    )
                                  </span>
                                  <span className="text-emerald-700">{im.ocrStatus}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {selectedChildItem && activeTab === 'mistakes_memory' && (
            <div className="grid grid-cols-12 gap-6">
              <div className="col-span-7 bg-white rounded-xl border border-slate-200 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-extrabold text-slate-900">
                    🎯 错题精讲与攻克台账 ({allMistakes.length})
                  </h3>
                  <div className="flex items-center gap-1.5 text-xs font-bold">
                    {(
                      [
                        ['all', '全部'],
                        ['open', '📌 待订正'],
                        ['mastered', '🌟 已攻克'],
                      ] as const
                    ).map(([k, lbl]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setMistakeFilter(k)}
                        className={`px-3 py-1 rounded cursor-pointer ${
                          mistakeFilter === k
                            ? 'bg-pink-600 text-white'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                {allMistakes.length === 0 ? (
                  <div className="text-sm text-slate-500 py-10 text-center">暂无错题记录</div>
                ) : (
                  <div className="space-y-4">
                    {allMistakes.map((entry) => {
                      const { taskDate, taskTitle, mistake: m, sourceImage } = entry
                      return (
                        <div
                          key={m.id}
                          className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/50"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div>
                              <span className="text-xs font-num text-slate-500 mr-2">
                                {taskDate} · {taskTitle}
                              </span>
                              <div className="text-base font-extrabold text-slate-900 mt-0.5">
                                {m.questionTitle}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 flex-wrap">
                              {sourceImage && (
                                <button
                                  type="button"
                                  onClick={() => openMistakeLightbox(entry, 'full')}
                                  className="text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 px-2.5 py-1 rounded cursor-pointer"
                                >
                                  📄 查看原卷全图
                                </button>
                              )}
                              <span
                                className={`text-xs font-extrabold px-2.5 py-1 rounded ${
                                  m.masteryStatus === 'mastered'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {m.masteryStatus === 'mastered' ? '🌟 已订正攻克' : '📌 待订正'}
                              </span>
                              <button
                                type="button"
                                disabled={ttsBusyId === `mstk-${m.id}`}
                                onClick={() =>
                                  void playTtsOnDemand({
                                    keyId: `mstk-${m.id}`,
                                    text: `${m.questionTitle}。${m.errorCause}。${m.correctSteps.join('；')}`,
                                    bindKind: 'mistake_explain',
                                    bindId: m.id,
                                    prebuiltUrl: m.ttsAudioUrl,
                                  })
                                }
                                className="text-xs font-bold bg-slate-200 hover:bg-slate-300 px-2.5 py-1 rounded cursor-pointer"
                              >
                                {ttsBusyId === `mstk-${m.id}` ? '⏳ 合成中...' : '🔊 听讲题'}
                              </button>
                            </div>
                          </div>

                          {(m.cropImageUrl || sourceImage) && (
                            <div className="flex flex-wrap items-start gap-3">
                              {m.cropImageUrl && (
                                <button
                                  type="button"
                                  onClick={() => openMistakeLightbox(entry, 'full')}
                                  className="group relative bg-white border border-slate-300 hover:border-pink-500 rounded-lg p-1.5 text-left cursor-pointer transition-all shadow-2xs"
                                  title="点击查看所属原卷全图并支持旋转放正"
                                >
                                  <img
                                    src={resolveMediaUrl(m.id, m.cropImageUrl)}
                                    alt={m.questionTitle}
                                    className="max-h-36 max-w-xs object-contain rounded block"
                                  />
                                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] font-bold text-pink-700">
                                    <span>✂️ 错题局部缩略图</span>
                                    <span className="group-hover:underline">🔍 点此看全图 / 旋转</span>
                                  </div>
                                </button>
                              )}

                              {sourceImage && (
                                <button
                                  type="button"
                                  onClick={() => openMistakeLightbox(entry, 'full')}
                                  className="group bg-white border border-slate-300 hover:border-blue-500 rounded-lg p-1.5 text-left cursor-pointer transition-all shadow-2xs"
                                  title="点击放大查看整页原卷与旋转"
                                >
                                  <img
                                    src={resolveMediaUrl(sourceImage.id, sourceImage.imageUrl)}
                                    alt="所属原卷"
                                    className="h-36 w-28 object-cover rounded block"
                                  />
                                  <div className="mt-1 text-[11px] font-bold text-blue-700 group-hover:underline">
                                    📄 原卷全图预览
                                  </div>
                                </button>
                              )}
                            </div>
                          )}

                          <div className="text-sm space-y-1">
                            <div>
                              <b className="text-rose-700">原卷错点：</b>
                              {m.wrongSnippet}
                            </div>
                            <div>
                              <b className="text-slate-700">错因分析：</b>
                              {m.errorCause}
                            </div>
                          </div>

                          {m.diagramImageUrl && (
                            <div
                              onClick={() => openMistakeLightbox(entry, 'diagram')}
                              className="cursor-pointer group"
                              title="点击放大查看精讲图卡（可切换原卷全图）"
                            >
                              <img
                                src={m.diagramImageUrl}
                                alt="讲解图"
                                className="w-full max-h-72 object-contain bg-white border border-slate-200 group-hover:border-pink-400 rounded p-2 transition-colors"
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="col-span-5 space-y-4">
                <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-extrabold text-slate-900">
                      🧠 专属 DSH 长期学习记忆 (`MEMORY.md`)
                    </h3>
                    <span className="text-xs font-mono text-slate-400">
                      {memoryData?.dshSessionId ? memoryData.dshSessionId.slice(0, 18) : '无会话'}
                    </span>
                  </div>
                  <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-[420px] overflow-y-auto">
                    {memoryData?.memoryMd || '暂无记忆内容'}
                  </pre>
                </div>

                {memoryData?.mistakesJsonl && (
                  <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                    <h3 className="text-sm font-extrabold text-slate-900">
                      📋 DSH 错题记忆流 (`mistakes.jsonl`)
                    </h3>
                    <pre className="bg-slate-900 text-emerald-200 rounded-lg p-3.5 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
                      {memoryData.mistakesJsonl}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {selectedChildItem && activeTab === 'attention' && (
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <h3 className="text-base font-extrabold text-slate-900">
                    👀 每日在座与注意力分段报告
                  </h3>
                  <input
                    type="date"
                    value={attDate}
                    onChange={(e) => setAttDate(e.target.value)}
                    className="border border-slate-300 rounded px-3 py-1 text-sm font-num"
                  />
                  {attDates.slice(0, 6).map((d) => (
                    <button
                      key={d.date}
                      type="button"
                      onClick={() => setAttDate(d.date)}
                      className={`text-xs font-num font-bold px-2.5 py-1 rounded cursor-pointer ${
                        attDate === d.date
                          ? 'bg-pink-600 text-white'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {d.date} ({Math.max(1, Math.round(d.trackedSec / 60))}m)
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-5 text-sm font-bold font-num">
                  <span>
                    在座率：<b className="text-blue-600">{attReport?.presentRatePct ?? 0}%</b>（
                    {fmtSec(attReport?.presentSec ?? 0)}）
                  </span>
                  <span>
                    认真看书率：<b className="text-emerald-600">{attReport?.focusRatePct ?? 0}%</b>
                    （{fmtSec(attReport?.focusedSec ?? 0)}）
                  </span>
                  <span>
                    平均读写眼距：
                    <b className="text-pink-600">
                      {attReport && attReport.avgDistanceCm > 0
                        ? `${attReport.avgDistanceCm} cm`
                        : '—'}
                    </b>
                  </span>
                </div>
              </div>

              {!attReport || attReport.tasks.length === 0 ? (
                <div className="text-sm text-slate-500 py-10 text-center">
                  该日期暂无任务或注意力分段上报记录
                </div>
              ) : (
                <div className="space-y-5">
                  {attReport.tasks.map((t) => (
                    <div
                      key={t.taskId}
                      className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/40"
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="font-extrabold text-base text-slate-900">
                          {t.plannedStartTime ? `开始 ${t.plannedStartTime}` : '待开始'} · {t.title}
                        </div>
                        <div className="text-xs font-bold font-num text-slate-600">
                          最后更新 {formatCnDateTime(t.updatedAt)} · 在座 {t.presentRatePct}% · 专注{' '}
                          {t.focusRatePct}% · 均距 {t.avgDistanceCm > 0 ? `${t.avgDistanceCm}cm` : '—'}
                        </div>
                      </div>

                      {t.segments.length === 0 ? (
                        <div className="text-xs text-slate-500">
                          该任务尚未从 iPad 上报原深感分段统计
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1 h-6 bg-white border border-slate-300 rounded p-1">
                            {t.segments.map((seg) => (
                              <div
                                key={seg.segmentIndex}
                                title={`第${seg.segmentIndex + 1}段 · ${(ATT_COLORS[seg.dominantState] ?? ATT_COLORS.focused).label}`}
                                className="h-full flex-1 min-w-[10px] rounded-xs"
                                style={{
                                  backgroundColor: (
                                    ATT_COLORS[seg.dominantState] ?? ATT_COLORS.focused
                                  ).hex,
                                }}
                              />
                            ))}
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full text-xs text-left border-collapse font-num">
                              <thead>
                                <tr className="border-b border-slate-200 text-slate-500">
                                  <th className="py-1.5 pr-3">时间段</th>
                                  <th className="py-1.5 pr-3">主导状态</th>
                                  <th className="py-1.5 pr-3">在座</th>
                                  <th className="py-1.5 pr-3">认真看书</th>
                                  <th className="py-1.5 pr-3">扭头走神</th>
                                  <th className="py-1.5 pr-3">闭眼发呆</th>
                                  <th className="py-1.5 pr-3">过近(&lt;28cm)</th>
                                  <th className="py-1.5 pr-3">离座</th>
                                  <th className="py-1.5">平均眼距</th>
                                </tr>
                              </thead>
                              <tbody>
                                {t.segments.map((s) => (
                                  <tr
                                    key={s.segmentIndex}
                                    className="border-b border-slate-100 text-slate-700"
                                  >
                                    <td className="py-1.5 pr-3 font-bold">
                                      第 {s.segmentIndex + 1} 分钟
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      {(ATT_COLORS[s.dominantState] ?? ATT_COLORS.focused).label}
                                    </td>
                                    <td className="py-1.5 pr-3">{s.presentSec}s</td>
                                    <td className="py-1.5 pr-3 text-emerald-700 font-bold">
                                      {s.focusedSec}s
                                    </td>
                                    <td className="py-1.5 pr-3 text-amber-700">
                                      {s.distractedSec}s
                                    </td>
                                    <td className="py-1.5 pr-3 text-purple-700">{s.drowsySec}s</td>
                                    <td className="py-1.5 pr-3 text-orange-700">
                                      {s.nearPostureSec}s
                                    </td>
                                    <td className="py-1.5 pr-3 text-slate-500">{s.awaySec}s</td>
                                    <td className="py-1.5">
                                      {s.avgDistanceCm > 0 ? `${s.avgDistanceCm}cm` : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {selectedChildItem && activeTab === 'dictionary' && (
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <h3 className="text-base font-extrabold text-slate-900">
                📖 拍照涂抹查字典历史 ({dictHistory.length})
              </h3>
              {dictHistory.length === 0 ? (
                <div className="text-sm text-slate-500 py-10 text-center">暂无查字典记录</div>
              ) : (
                <div className="space-y-4">
                  {dictHistory.map((lk) => (
                    <div
                      key={lk.id}
                      className="border border-slate-200 rounded-xl p-4 bg-slate-50/40 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <img
                            src={lk.previewImageUrl}
                            alt="涂抹图"
                            onClick={() =>
                              setLightboxState({
                                items: [
                                  {
                                    key: `dict-prev-${lk.id}`,
                                    label: '🖍️ 涂抹查词图',
                                    url: lk.previewImageUrl,
                                    subTitle: lk.instruction,
                                  },
                                  {
                                    key: `dict-orig-${lk.id}`,
                                    label: '📄 拍摄原图',
                                    url: lk.rawImageUrl,
                                    subTitle: lk.instruction,
                                  },
                                ],
                                initialIndex: 0,
                              })
                            }
                            className="w-24 h-16 object-cover rounded border border-slate-300 hover:border-pink-500 cursor-pointer"
                          />
                          <div>
                            <div className="text-xs font-num text-slate-500">
                              {lk.createdAt.slice(0, 19).replace('T', ' ')}
                            </div>
                            <div className="text-sm font-semibold text-slate-700 mt-0.5">
                              指令：{lk.instruction}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        {lk.entries.map((en) => (
                          <div
                            key={en.entryId}
                            className="bg-white border border-slate-200 rounded-lg p-3 space-y-1.5 text-sm"
                          >
                            {en.unrecognized ? (
                              <div className="text-amber-700 font-semibold">
                                未识别涂抹：{en.unrecognizedReason}
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="font-extrabold text-base text-slate-900">
                                    {en.chineseWord} {en.pinyin ? `[${en.pinyin}]` : ''} ·{' '}
                                    <span className="text-blue-700 font-num">
                                      {en.englishWord} {en.ipa}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {en.chineseWord && (
                                      <button
                                        type="button"
                                        disabled={ttsBusyId === `dict-zh-${en.entryId}`}
                                        onClick={() =>
                                          void playDictWordOnDemand(
                                            `dict-zh-${en.entryId}`,
                                            en.chineseWord,
                                            en.chineseAudioUrl,
                                          )
                                        }
                                        className="text-xs bg-pink-50 text-pink-700 px-2 py-0.5 rounded font-bold cursor-pointer"
                                      >
                                        {ttsBusyId === `dict-zh-${en.entryId}` ? '⏳' : '🔊中'}
                                      </button>
                                    )}
                                    {en.englishWord && (
                                      <button
                                        type="button"
                                        disabled={ttsBusyId === `dict-en-${en.entryId}`}
                                        onClick={() =>
                                          void playDictWordOnDemand(
                                            `dict-en-${en.entryId}`,
                                            en.englishWord,
                                            en.englishAudioUrl,
                                          )
                                        }
                                        className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded font-bold cursor-pointer"
                                      >
                                        {ttsBusyId === `dict-en-${en.entryId}` ? '⏳' : '🔊英'}
                                      </button>
                                    )}
                                  </div>
                                </div>
                                {en.senses.slice(0, 2).map((s) => (
                                  <div key={s.index} className="text-xs text-slate-600">
                                    {s.index}. {s.pos} {s.zhMeaning} ({s.enMeaning})
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setLogScope('child')}
                    className={`px-3 py-1.5 rounded text-xs font-bold cursor-pointer ${
                      logScope === 'child'
                        ? 'bg-slate-800 text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    当前孩子日志
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogScope('global')}
                    className={`px-3 py-1.5 rounded text-xs font-bold cursor-pointer ${
                      logScope === 'global'
                        ? 'bg-slate-800 text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    全局系统日志
                  </button>
                  <span className="mx-1 text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() => setLogLevel('all')}
                    className={`px-3 py-1.5 rounded text-xs font-bold cursor-pointer ${
                      logLevel === 'all' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    全部事件 ({logsData?.summary.totalEvents ?? 0})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogLevel('error')}
                    className={`px-3 py-1.5 rounded text-xs font-bold cursor-pointer ${
                      logLevel === 'error'
                        ? 'bg-rose-600 text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    ⚠️ 仅看报错与告警 (
                    {(logsData?.summary.errorCount ?? 0) + (logsData?.summary.warnCount ?? 0)})
                  </button>
                </div>

                <span className="text-xs font-mono text-slate-400">
                  {logsData?.summary.logDir}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b-2 border-slate-200 text-slate-500">
                      <th className="py-2 pr-3">时间</th>
                      <th className="py-2 pr-3">级别</th>
                      <th className="py-2 pr-3">设备端</th>
                      <th className="py-2 pr-3">事件</th>
                      <th className="py-2 pr-3">耗时</th>
                      <th className="py-2">消息与异常详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(logsData?.items ?? []).map((item, idx) => {
                      const latency = item.elapsedMs ?? item.durationMs
                      return (
                        <tr
                          key={`${item.ts}-${idx}`}
                          className={`border-b border-slate-100 align-top ${
                            item.level === 'ERROR'
                              ? 'bg-rose-50/60'
                              : item.level === 'WARNING'
                                ? 'bg-amber-50/50'
                                : ''
                          }`}
                        >
                          <td className="py-2 pr-3 font-num whitespace-nowrap text-slate-500">
                            {item.ts.slice(5, 19).replace('T', ' ')}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded font-bold text-white ${
                                item.level === 'ERROR'
                                  ? 'bg-rose-600'
                                  : item.level === 'WARNING'
                                    ? 'bg-amber-500'
                                    : 'bg-blue-600'
                              }`}
                            >
                              {item.level}
                            </span>
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap font-semibold text-slate-700">
                            {item.device}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap font-mono font-bold text-slate-800">
                            {item.event}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap font-num text-slate-500">
                            {latency !== undefined ? `${latency}ms` : '—'}
                          </td>
                          <td className="py-2 text-slate-800 space-y-1">
                            <div className="font-medium">{item.message}</div>
                            {item.errorDetail && (
                              <div className="text-rose-700 font-bold">错误：{item.errorDetail}</div>
                            )}
                            {item.traceback && (
                              <pre className="bg-slate-900 text-rose-200 p-2 rounded text-[11px] overflow-x-auto max-w-3xl">
                                {item.traceback}
                              </pre>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>

      {lightboxState && (
        <ImagePreviewLightbox
          items={lightboxState.items}
          initialIndex={lightboxState.initialIndex}
          onClose={() => setLightboxState(null)}
          onPersistRotation={handlePersistRotation}
        />
      )}
    </div>
  )
}
