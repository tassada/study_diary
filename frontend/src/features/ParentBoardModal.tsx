import { useEffect, useState } from 'react'
import { GirlAvatarSprite, PixelStarBadge } from '../components/PixelSprites'
import { formatCnDateTime, SUBJECT_CONFIG } from '../config/pixelTheme'
import { studyApi } from '../services/apiClient'
import type { AuditLogResponse, ChildProfile, StudyTask } from '../types/study'
import { ParentAttentionPanel } from './ParentAttentionPanel'

interface ParentBoardModalProps {
  girl: ChildProfile
  onClose: () => void
  onVoidedTask: () => Promise<void>
}

export function ParentBoardModal({
  girl,
  onClose,
  onVoidedTask,
}: ParentBoardModalProps) {
  const [activeTab, setActiveTab] = useState<'tasks' | 'attention' | 'logs'>('tasks')
  const [allTasks, setAllTasks] = useState<StudyTask[]>([])
  const [loadingTasks, setLoadingTasks] = useState(true)
  const [logLevel, setLogLevel] = useState<'all' | 'error'>('all')
  const [logData, setLogData] = useState<AuditLogResponse | null>(null)
  const [loadingLogs, setLoadingLogs] = useState(false)

  const loadTasks = async () => {
    setLoadingTasks(true)
    try {
      const rows = await studyApi.listParentAllTasks(girl.id)
      setAllTasks(rows)
    } finally {
      setLoadingTasks(false)
    }
  }

  const loadLogs = async (lvl: 'all' | 'error' = logLevel) => {
    setLoadingLogs(true)
    try {
      const res = await studyApi.listParentAuditLogs(girl.id, lvl, 100)
      setLogData(res)
    } finally {
      setLoadingLogs(false)
    }
  }

  useEffect(() => {
    void loadTasks()
    void loadLogs('all')
  }, [girl.id])

  const handleParentVoid = async (taskId: string) => {
    await studyApi.deleteOrVoidTask(taskId, 'parent')
    await loadTasks()
    await loadLogs(logLevel)
    await onVoidedTask()
  }

  const completedTasks = allTasks.filter((t) => t.status === 'completed')
  const totalMinutes = Math.round(
    completedTasks.reduce((acc, t) => acc + t.actualDurationSec, 0) / 60,
  )
  const openMistakes = allTasks.reduce(
    (acc, t) => acc + t.mistakes.filter((m) => m.masteryStatus === 'open').length,
    0,
  )
  const masteredMistakes = allTasks.reduce(
    (acc, t) => acc + t.mistakes.filter((m) => m.masteryStatus === 'mastered').length,
    0,
  )
  const errTotal = (logData?.summary.errorCount ?? 0) + (logData?.summary.warnCount ?? 0)

  return (
    <div className="absolute inset-0 z-40 bg-[#2A1829]/65 p-5 flex items-center justify-center">
      <div className="pixel-card-lavender w-full h-full p-6 flex flex-col justify-between">
        <div className="flex items-center justify-between gap-3 pb-3 border-b-3 border-[#4A2B44] shrink-0">
          <div className="flex items-center gap-3">
            <div className="border-2 border-[#4A2B44] bg-white rounded">
              <GirlAvatarSprite avatar={girl.avatarKey} size={48} />
            </div>
            <div>
              <h2 className="text-[23px] font-extrabold text-[#332230]">
                📊 家长监护屋 — {girl.displayName}（生日 {girl.birthDate} · {girl.gradeLabel}）
              </h2>
              <p className="text-[15px] font-semibold text-[#5E3F8A]">
                查看学习统计、作废异常任务、实时追踪使用情况与系统报错日志
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('tasks')}
              className={`pixel-btn px-3.5 py-2 text-[15px] font-extrabold ${
                activeTab === 'tasks' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              🗂️ 任务流水
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('attention')}
              className={`pixel-btn px-3.5 py-2 text-[15px] font-extrabold ${
                activeTab === 'attention' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              👀 专注统计与点阵回放
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('logs')
                void loadLogs(logLevel)
              }}
              className={`pixel-btn px-3.5 py-2 text-[15px] font-extrabold ${
                activeTab === 'logs' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              📜 日志{errTotal > 0 ? ` (${errTotal})` : ''}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="pixel-btn bg-[#FFFDF9] px-4 py-2 text-[16px] font-extrabold text-[#332230]"
            >
              ✕ 退出
            </button>
          </div>
        </div>

        {activeTab !== 'attention' && (
          <div className="grid grid-cols-4 gap-4 py-4 shrink-0">
          <div className="pixel-card p-3.5 text-center">
            <div className="text-[14px] font-bold text-[#5C4056]">累计完成任务</div>
            <div className="font-num text-[26px] font-extrabold text-[#C92A6A] mt-0.5">
              {completedTasks.length}/{allTasks.length}
            </div>
          </div>
          <div className="pixel-card p-3.5 text-center">
            <div className="text-[14px] font-bold text-[#5C4056]">累计有效专注</div>
            <div className="font-num text-[26px] font-extrabold text-[#2563EB] mt-0.5">
              {totalMinutes}分钟
            </div>
          </div>
          <div className="pixel-card p-3.5 text-center">
            <div className="text-[14px] font-bold text-[#5C4056]">错题本攻克进度</div>
            <div className="font-num text-[24px] font-extrabold text-[#1E7A55] mt-0.5">
              已掌握 {masteredMistakes} / 待订正 {openMistakes}
            </div>
          </div>
          <div className="pixel-card p-3.5 text-center">
            <div className="text-[14px] font-bold text-[#5C4056]">今日日志 / 告警报错</div>
            <div className="font-num text-[24px] font-extrabold text-[#B56B00] mt-0.5 flex items-center justify-center gap-1.5">
              <span>{logData?.summary.todayEvents ?? 0} 条</span>
              <span className="text-[#C92A6A]">/ 异常 {errTotal}</span>
            </div>
          </div>
        </div>
        )}

        {activeTab === 'attention' ? (
          <div className="pt-3 flex-1 min-h-0 flex flex-col">
            <ParentAttentionPanel childId={girl.id} />
          </div>
        ) : activeTab === 'tasks' ? (
          <div className="pixel-card p-4 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between pb-2.5 border-b-2 border-[#EAD6E2] shrink-0">
              <span className="font-extrabold text-[18px] text-[#332230]">
                🗂️ 全部任务流水与家长作废管理
              </span>
              <span className="text-[14px] font-bold text-[#5C4056] flex items-center gap-1 font-num">
                <PixelStarBadge size={14} /> 当前星莓币：{girl.starCoins}
              </span>
            </div>
            <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pt-3 pr-2 space-y-2.5">
              {loadingTasks ? (
                <div className="p-8 text-center text-[17px] font-bold text-[#5C4056]">
                  正在加载历史任务流水...
                </div>
              ) : allTasks.length === 0 ? (
                <div className="p-8 text-center text-[17px] font-bold text-[#5C4056]">
                  暂无任务记录
                </div>
              ) : (
                allTasks.map((t) => {
                  const subj = SUBJECT_CONFIG[t.subject] ?? SUBJECT_CONFIG.chinese
                  return (
                    <div
                      key={t.id}
                      className="border-2 border-[#4A2B44] rounded p-3 flex items-center justify-between gap-3 bg-[#FAF4EC]"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-num text-[14px] font-bold bg-white border border-[#4A2B44] px-2 py-0.5 rounded shrink-0">
                          {t.taskDate} · 开始 {t.plannedStartTime || '待开始'}
                        </span>
                        <span
                          className="px-2 py-0.5 rounded text-[13px] font-bold text-white shrink-0"
                          style={{ backgroundColor: subj.pillHex }}
                        >
                          {subj.label}
                        </span>
                        <span className="font-extrabold text-[17px] text-[#332230] truncate">
                          {t.title}
                        </span>
                        <span className="text-[14px] font-semibold text-[#5C4056] font-num shrink-0">
                          实专注 {Math.round(t.actualDurationSec / 60)}m · 状态: {t.status}
                          {t.earnedScore !== null ? ` · 得分 ${t.earnedScore}/100` : ''} · 最后更新{' '}
                          {formatCnDateTime(t.updatedAt)}
                        </span>
                      </div>

                      {t.status !== 'completed' && (
                        <button
                          type="button"
                          onClick={() => handleParentVoid(t.id)}
                          className="pixel-btn bg-[#FFE8F0] text-[#7A1C3E] px-3.5 py-1.5 text-[14px] font-extrabold shrink-0"
                        >
                          🗑️ 家长作废此任务
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        ) : (
          <div className="pixel-card p-4 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between gap-2 pb-2.5 border-b-2 border-[#EAD6E2] shrink-0">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setLogLevel('all')
                    void loadLogs('all')
                  }}
                  className={`pixel-btn px-3.5 py-1 text-[14px] font-extrabold ${
                    logLevel === 'all' ? 'bg-[#EC5F9B] text-white' : 'bg-[#FFFDF9]'
                  }`}
                >
                  全部使用轨迹 ({logData?.summary.totalEvents ?? 0})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLogLevel('error')
                    void loadLogs('error')
                  }}
                  className={`pixel-btn px-3.5 py-1 text-[14px] font-extrabold ${
                    logLevel === 'error' ? 'bg-[#E11D74] text-white' : 'bg-[#FFFDF9]'
                  }`}
                >
                  ⚠️ 仅看报错与告警 ({errTotal})
                </button>
              </div>

              <button
                type="button"
                disabled={loadingLogs}
                onClick={() => void loadLogs(logLevel)}
                className="pixel-btn bg-[#FFFDF9] px-3.5 py-1 text-[14px] font-extrabold"
              >
                {loadingLogs ? '⏳ 刷新中...' : '🔄 刷新日志'}
              </button>
            </div>

            <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pt-3 pr-2 space-y-2">
              {loadingLogs && !logData ? (
                <div className="p-8 text-center text-[16px] font-bold text-[#5C4056]">
                  正在读取后台日志...
                </div>
              ) : !logData || logData.items.length === 0 ? (
                <div className="p-8 text-center text-[16px] font-bold text-[#5C4056]">
                  {logLevel === 'error' ? '🎉 太棒啦！当前没有任何报错或告警记录' : '暂无日志记录'}
                </div>
              ) : (
                logData.items.map((item, idx) => {
                  const isErr = item.level === 'ERROR'
                  const isWarn = item.level === 'WARNING'
                  const latency = item.elapsedMs ?? item.durationMs
                  return (
                    <div
                      key={`${item.ts}-${item.requestId}-${idx}`}
                      className={`border-2 rounded p-2.5 text-[14px] space-y-1 ${
                        isErr
                          ? 'bg-[#FFF0F5] border-[#C92A6A]'
                          : isWarn
                            ? 'bg-[#FFF9E6] border-[#B56B00]'
                            : 'bg-[#FAF4EC] border-[#4A2B44]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 font-num">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`px-2 py-0.2 rounded text-[12px] font-extrabold text-white shrink-0 ${
                              isErr
                                ? 'bg-[#E11D74]'
                                : isWarn
                                  ? 'bg-[#D97706]'
                                  : 'bg-[#2563EB]'
                            }`}
                          >
                            {item.level}
                          </span>
                          <span className="font-bold text-[#5C4056] shrink-0">
                            {item.ts.slice(5, 19).replace('T', ' ')}
                          </span>
                          <span className="bg-white border border-[#4A2B44] px-1.5 rounded text-[12px] font-bold shrink-0">
                            {item.device}
                          </span>
                          <span className="font-extrabold text-[#332230] truncate">
                            {item.event}
                          </span>
                        </div>
                        <span className="text-[12px] font-semibold text-[#5C4056] shrink-0">
                          {latency !== undefined ? `${latency}ms · ` : ''}#{item.requestId}
                        </span>
                      </div>

                      <div className="font-semibold text-[#332230]">{item.message}</div>

                      {item.errorDetail && (
                        <div className="text-[13px] font-bold text-[#B51D5B]">
                          原因：{item.errorDetail}
                        </div>
                      )}
                      {item.traceback && (
                        <pre className="mt-1 p-2 bg-white/90 border border-[#DFC1D4] rounded text-[12px] leading-snug overflow-x-auto text-[#4A2B44]">
                          {item.traceback}
                        </pre>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
