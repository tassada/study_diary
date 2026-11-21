import { useState } from 'react'
import { PixelStarBadge, SubjectPixelIcon } from '../components/PixelSprites'
import { formatCnTime, SUBJECT_CONFIG } from '../config/pixelTheme'
import { studyApi } from '../services/apiClient'
import { speakStellaSentences } from '../services/pixelAudio'
import type { AsyncJobInfo, StudyTask, UploadKind } from '../types/study'

interface TimelinePanelProps {
  selectedDate: string
  dayTasks: StudyTask[]
  activeJobsByTask: Record<string, AsyncJobInfo>
  onOpenVoiceCreator: () => void
  onStartTaskTimer: (task: StudyTask) => void
  onToggleTaskTimerMode: (task: StudyTask) => void
  onOpenHomeworkModal: (task: StudyTask, defaultMode: UploadKind | 'inspect') => void
  onDeletePendingTask: (taskId: string) => void
}

function formatDurationBadge(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins === 0) return `${secs}秒`
  if (secs === 0) return `${mins}分钟`
  return `${mins}分${secs}秒`
}

export function TimelinePanel({
  selectedDate,
  dayTasks,
  activeJobsByTask,
  onOpenVoiceCreator,
  onStartTaskTimer,
  onToggleTaskTimerMode,
  onOpenHomeworkModal,
  onDeletePendingTask,
}: TimelinePanelProps) {
  const sortedTasks = [...dayTasks].sort((a, b) => {
    const aEmpty = !a.plannedStartTime
    const bEmpty = !b.plannedStartTime
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1
    if (!aEmpty && !bEmpty) {
      const cmp = a.plannedStartTime.localeCompare(b.plannedStartTime)
      if (cmp !== 0) return cmp
    }
    return a.id.localeCompare(b.id)
  })

  const [loadingTtsTaskId, setLoadingTtsTaskId] = useState<string | null>(null)

  const playPraiseAudio = async (task: StudyTask) => {
    if (!task.aiQuickPraise || loadingTtsTaskId === task.id) return
    setLoadingTtsTaskId(task.id)
    try {
      const url = await studyApi.speakOnDemand({
        text: task.aiQuickPraise,
        bindKind: 'task_praise',
        bindId: task.id,
        prebuiltUrl: task.praiseAudioUrl,
      })
      const audio = new Audio(url)
      audio.onended = () => setLoadingTtsTaskId(null)
      audio.onerror = () => setLoadingTtsTaskId(null)
      await audio.play()
    } catch {
      setLoadingTtsTaskId(null)
      speakStellaSentences([task.aiQuickPraise], 1.0, () => undefined, () => undefined)
    }
  }

  return (
    <section className="pixel-card px-4 py-3.5 flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between gap-3 pb-3 border-b-2 border-[#EAD6E2] shrink-0">
        <h2 className="text-[21px] font-extrabold text-[#332230] flex items-center gap-2.5">
          <span>🕒 学习任务时间线</span>
          <span className="font-num text-[15px] bg-[#FFE484] border-2 border-[#4A2B44] px-2.5 py-0.5 rounded">
            {selectedDate}
          </span>
        </h2>

        <button
          type="button"
          onClick={onOpenVoiceCreator}
          className="pixel-btn bg-[#EC5F9B] text-white px-5 py-2.5 text-[18px] font-extrabold h-[48px] flex items-center gap-2 shrink-0 whitespace-nowrap"
        >
          <span className="text-[20px]">🎤</span>
          <span>语音建任务</span>
        </button>
      </div>

      <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pr-2 pt-3.5">
        {sortedTasks.length === 0 ? (
          <div className="pixel-card-pink h-full flex flex-col items-center justify-center p-6 text-center">
            <div className="text-4xl mb-3">🍓✨</div>
            <p className="text-[22px] font-extrabold text-[#332230] mb-5">
              今天还没有安排学习任务哦
            </p>
            <button
              type="button"
              onClick={onOpenVoiceCreator}
              className="pixel-btn bg-[#FFE484] text-[#332230] px-7 py-3.5 text-[19px] font-extrabold"
            >
              🎙️ 语音添加第一个任务
            </button>
          </div>
        ) : (
          <div className="relative pl-2 space-y-3.5 pb-2">
            <div className="absolute left-[38px] top-4 bottom-4 w-[4px] bg-[#E8BFD4]" />

            {sortedTasks.map((task) => {
              const subj = SUBJECT_CONFIG[task.subject] ?? SUBJECT_CONFIG.chinese
              const isDone = task.status === 'completed'
              const isPaused = task.status === 'paused'
              const isRunning = task.status === 'in_progress'
              const isLocked =
                task.timerLocked || task.actualDurationSec > 0 || task.status !== 'pending'
              const runningJob = activeJobsByTask[task.id]
              const openMistakeCount = task.mistakes.filter(
                (m) => m.masteryStatus === 'open',
              ).length

              return (
                <div key={task.id} className="relative flex items-start gap-3.5">
                  <div className="relative z-10 flex flex-col items-center shrink-0 w-[64px] pt-1">
                    <span
                      className={
                        task.plannedStartTime
                          ? 'font-num text-[14px] font-extrabold text-[#332230] bg-[#FFFDF9] border-2 border-[#4A2B44] px-2 py-0.5 rounded whitespace-nowrap'
                          : 'text-[12px] font-extrabold text-[#7A5672] bg-[#FFF5FA] border-2 border-[#4A2B44] px-1.5 py-0.5 rounded whitespace-nowrap'
                      }
                    >
                      {task.plannedStartTime || '待开始'}
                    </span>
                    <div
                      className={`mt-1.5 w-6 h-6 border-2 border-[#4A2B44] rounded flex items-center justify-center text-[13px] font-bold ${
                        isDone
                          ? 'bg-[#52CE9B] text-[#104530]'
                          : isPaused || isRunning
                            ? 'bg-[#FFE484] text-[#332230]'
                            : 'bg-[#EC5F9B] text-white'
                      }`}
                    >
                      {isDone ? '✓' : isPaused ? '⏸' : isRunning ? '▶' : '★'}
                    </div>
                  </div>

                  <div
                    className="flex-1 min-w-0 border-3 border-[#4A2B44] rounded-md p-3.5 shadow-[3px_3px_0_rgba(74,43,68,0.14)]"
                    style={{ backgroundColor: isDone ? '#F5FBF7' : subj.bgHex }}
                  >
                    {runningJob &&
                      runningJob.status !== 'succeeded' &&
                      runningJob.status !== 'failed' && (
                        <div className="mb-3 bg-[#FFF5C2] border-2 border-[#4A2B44] rounded px-3 py-2 flex items-center justify-between gap-2 animate-pulse">
                          <span className="text-[15px] font-extrabold text-[#5C3D00]">
                            ⏳ 后台异步处理中：{runningJob.progressText}
                          </span>
                          <span className="text-[13px] font-bold bg-white border border-[#4A2B44] px-2 py-0.5 rounded">
                            批阅中
                          </span>
                        </div>
                      )}

                    {!isDone &&
                      (runningJob?.status === 'failed' ||
                        (!runningJob && task.latestJobStatus === 'failed')) && (
                        <div className="mb-3 bg-[#FFE8F0] border-2 border-[#C92A6A] rounded px-3 py-2 flex items-center justify-between gap-2">
                          <span className="text-[14px] font-extrabold text-[#7A1C3E]">
                            ⚠️ 上次批阅中断：
                            {runningJob?.errorDetail || task.latestJobError || '请点击右侧重试批阅'}
                          </span>
                          <button
                            type="button"
                            onClick={() => onOpenHomeworkModal(task, 'initial')}
                            className="pixel-btn bg-[#EC5F9B] text-white px-3 py-1 text-[13px] font-extrabold shrink-0"
                          >
                            🔄 点此重试批阅
                          </button>
                        </div>
                      )}

                    {task.autoPausedReason && !isDone && (
                      <div className="mb-2.5 bg-[#FFE8F0] border-2 border-[#C92A6A] rounded px-3 py-1.5 text-[14px] font-bold text-[#7A1C3E]">
                        🛡️ {task.autoPausedReason}
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] p-1.5 rounded shrink-0">
                          <SubjectPixelIcon subject={task.subject} size={34} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-[20px] font-extrabold text-[#332230] leading-snug">
                              {task.title}
                            </h3>
                            {isDone && (
                              <span className="bg-[#52CE9B] border-2 border-[#4A2B44] px-2.5 py-0.5 text-[13px] font-extrabold text-[#104530] rounded">
                                🎉 已完成
                              </span>
                            )}
                            {isPaused && (
                              <span className="bg-[#FFE484] border-2 border-[#4A2B44] px-2.5 py-0.5 text-[13px] font-extrabold rounded">
                                ⏸ 已暂停（不可重置）
                              </span>
                            )}
                            {isRunning && (
                              <span className="bg-[#C4B5FD] border-2 border-[#4A2B44] px-2.5 py-0.5 text-[13px] font-extrabold text-[#2E1065] rounded animate-pulse">
                                ⚡ 计时进行中
                              </span>
                            )}
                            {openMistakeCount > 0 && (
                              <span className="bg-[#FFE4EE] border-2 border-[#C92A6A] px-2.5 py-0.5 text-[13px] font-extrabold text-[#B51D5B] rounded">
                                📌 待订正错题 {openMistakeCount} 道
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                            <span
                              className="pixel-tag px-2.5 py-0.5 text-[14px] font-bold text-white"
                              style={{ backgroundColor: subj.pillHex }}
                            >
                              {subj.label}
                            </span>
                            {task.categoryTags.map((tag) => (
                              <span
                                key={tag}
                                className="pixel-tag bg-[#FFFDF9] px-2.5 py-0.5 text-[14px] font-bold text-[#332230]"
                              >
                                #{tag}
                              </span>
                            ))}
                            <span className="pixel-tag bg-[#FFF9DE] px-2.5 py-0.5 text-[14px] font-bold flex items-center gap-1">
                              难度
                              {[1, 2, 3].map((n) => (
                                <PixelStarBadge key={n} filled={n <= task.difficulty} size={13} />
                              ))}
                            </span>
                            <span className="pixel-tag bg-[#FFFDF9] px-2 py-0.5 text-[13px] font-semibold text-[#5C4056] font-num">
                              细则: 专注{task.scoringRubric.focus}+完整{task.scoringRubric.completeness}+准确{task.scoringRubric.accuracy}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {isDone && task.earnedScore !== null ? (
                          <div className="pixel-stamp px-3 py-1 text-right">
                            <div className="text-[12px] font-bold">
                              {task.revisionCount > 0 && task.initialScore !== null
                                ? `初交${task.initialScore} → 订正后`
                                : '本关得分'}
                            </div>
                            <div className="font-num text-[22px] font-extrabold leading-tight">
                              {task.earnedScore}/100
                            </div>
                          </div>
                        ) : (
                          <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded px-3 py-1 text-right">
                            <div className="text-[12px] font-bold text-[#5C4056]">
                              满分100 · 奖{task.rewardStars}★
                            </div>
                            <div className="font-num text-[18px] font-extrabold text-[#C92A6A] leading-tight">
                              🎯 100分制
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 pt-2.5 border-t-2 border-dashed border-[#4A2B44]/20 flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex flex-wrap items-center gap-2">
                        {!isDone ? (
                          isLocked ? (
                            <span className="bg-[#EFE8F2] border-2 border-[#4A2B44] rounded px-3 py-1.5 text-[14px] font-bold text-[#4A2B44]">
                              🔒 已锁定
                              {task.timerMode === 'countdown'
                                ? `沙漏倒计时 (${Math.round(task.plannedDurationSec / 60)}分钟)`
                                : `星星正计时 (目标${Math.round(task.plannedDurationSec / 60)}分钟)`}
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onToggleTaskTimerMode(task)}
                              className="pixel-btn bg-[#FFFDF9] px-3 py-1.5 text-[15px] font-bold text-[#332230]"
                            >
                              {task.timerMode === 'countdown'
                                ? `⏳ 倒计时 ${Math.round(task.plannedDurationSec / 60)}分钟 (开始前可切)`
                                : `⏱️ 正计时 · 目标${Math.round(task.plannedDurationSec / 60)}分钟 (开始前可切)`}
                            </button>
                          )
                        ) : (
                          <span className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded px-3 py-1 text-[14px] font-semibold text-[#332230] font-num">
                            ⏱️ 开始 <b>{task.plannedStartTime || '—'}</b> · 实耗时{' '}
                            <b>{formatDurationBadge(task.actualDurationSec)}</b> · 最后更新{' '}
                            <b>{formatCnTime(task.updatedAt)}</b> · 图{task.images.length}张
                          </span>
                        )}

                        {isLocked && !isDone && (
                          <span className="bg-[#FFE484] border-2 border-[#4A2B44] rounded px-2.5 py-1 text-[14px] font-bold font-num">
                            开始 {task.plannedStartTime || '—'}
                            {task.actualDurationSec > 0
                              ? ` · 已专注 ${formatDurationBadge(task.actualDurationSec)}`
                              : ''}
                            {' · '}最后更新 {formatCnTime(task.updatedAt)}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {!isDone ? (
                          <>
                            {!isLocked && (
                              <button
                                type="button"
                                onClick={() => onDeletePendingTask(task.id)}
                                className="pixel-btn bg-[#FFFDF9] px-3 py-2 text-[15px] font-bold text-[#8E3B63] h-[46px]"
                                title="未开始前可移除"
                              >
                                🗑️
                              </button>
                            )}
                            {task.images.length > 0 && (
                              <button
                                type="button"
                                onClick={() => onOpenHomeworkModal(task, 'initial')}
                                className="pixel-btn bg-[#EC5F9B] text-white px-4 py-2 text-[15px] font-extrabold h-[48px]"
                              >
                                📤 交作业({task.images.length}张)
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onStartTaskTimer(task)}
                              className="pixel-btn bg-[#FFE484] text-[#332230] px-5 py-2 text-[17px] font-extrabold h-[48px]"
                            >
                              {isPaused || isRunning ? '▶️ 继续专注计时' : '▶️ 开始计时'}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => onOpenHomeworkModal(task, 'inspect')}
                              className="pixel-btn bg-[#FFFDF9] text-[#332230] px-3.5 py-2 text-[15px] font-extrabold h-[46px]"
                            >
                              📖 图文结果 & 错题讲解 ({task.mistakes.length})
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                onOpenHomeworkModal(
                                  task,
                                  openMistakeCount > 0 ? 'correction' : 'supplement',
                                )
                              }
                              className="pixel-btn bg-[#FFE484] text-[#332230] px-3.5 py-2 text-[15px] font-extrabold h-[46px]"
                            >
                              📸 {openMistakeCount > 0 ? '订正重传追分' : '补传作业图'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {isDone && (task.aiQuickPraise || task.summaryVoiceText) && (
                      <div className="mt-2.5 bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-2.5 text-[15px] leading-relaxed space-y-1.5">
                        {task.summaryVoiceText && (
                          <div className="text-[#332230]">
                            🎙️ <b>学习小结：</b>“{task.summaryVoiceText}”
                          </div>
                        )}
                        {task.aiQuickPraise && (
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-[#B51D5B] font-semibold">
                              🌟 海星老师：{task.aiQuickPraise}
                            </div>
                            <button
                              type="button"
                              disabled={loadingTtsTaskId === task.id}
                              onClick={() => void playPraiseAudio(task)}
                              className="pixel-btn bg-[#FDF2F6] px-2.5 py-0.5 text-[13px] font-bold shrink-0"
                            >
                              {loadingTtsTaskId === task.id ? '⏳ 合成中' : '🔊 听点评'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
