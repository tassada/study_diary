import { useCallback, useEffect, useState } from 'react'
import { LockedLandscapeStage } from './components/LockedLandscapeStage'
import { getTodayDateStr } from './config/pixelTheme'
import { CalendarSection } from './features/CalendarSection'
import { ChildEntryGate } from './features/ChildEntryGate'
import { DailyReviewModal } from './features/DailyReviewModal'
import { DictionaryModal } from './features/DictionaryModal'
import { FocusTimerModal } from './features/FocusTimerModal'
import { HomeworkSubmitModal } from './features/HomeworkSubmitModal'
import { ParentBoardModal } from './features/ParentBoardModal'
import { StellaCompanionSidePanel } from './features/StellaCompanionSidePanel'
import { TimelinePanel } from './features/TimelinePanel'
import { TopRibbonBar } from './features/TopRibbonBar'
import { VoiceTaskModal } from './features/VoiceTaskModal'
import { studyApi } from './services/apiClient'
import { pixelAudio } from './services/pixelAudio'
import type {
  AsyncJobInfo,
  CalendarDaySummary,
  ChildProfile,
  DailyEvaluation,
  StudyTask,
  UploadKind,
} from './types/study'

function getMonthRange(ymd: string): { start: string; end: string } {
  const [y, m] = ymd.split('-').map(Number)
  const first = new Date(y, (m || 1) - 1, -6)
  const last = new Date(y, m || 1, 7)
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { start: fmt(first), end: fmt(last) }
}

export function App() {
  const [profiles, setProfiles] = useState<ChildProfile[]>([])
  const [loadingProfiles, setLoadingProfiles] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)

  const [selectedChild, setSelectedChild] = useState<ChildProfile | null>(null)
  const [selectedDate, setSelectedDate] = useState<string>(() => getTodayDateStr())
  const [soundEnabled, setSoundEnabled] = useState(true)

  const [calendarDays, setCalendarDays] = useState<Record<string, CalendarDaySummary>>({})
  const [dayTasks, setDayTasks] = useState<StudyTask[]>([])
  const [dayEvaluation, setDayEvaluation] = useState<DailyEvaluation | null>(null)

  const [activeJobsByTask, setActiveJobsByTask] = useState<Record<string, AsyncJobInfo>>({})
  const [dailyEvalJob, setDailyEvalJob] = useState<AsyncJobInfo | null>(null)

  const [voiceModalOpen, setVoiceModalOpen] = useState(false)
  const [activeTimerTask, setActiveTimerTask] = useState<StudyTask | null>(null)
  const [homeworkModalState, setHomeworkModalState] = useState<{
    taskId: string
    mode: UploadKind | 'inspect'
  } | null>(null)
  const [dailyReviewOpen, setDailyReviewOpen] = useState(false)
  const [dictionaryOpen, setDictionaryOpen] = useState(false)
  const [parentBoardOpen, setParentBoardOpen] = useState(false)
  const [toastBanner, setToastBanner] = useState<string | null>(null)

  const showToast = useCallback((msg: string) => {
    setToastBanner(msg)
    window.setTimeout(() => {
      setToastBanner((curr) => (curr === msg ? null : curr))
    }, 4500)
  }, [])

  const loadProfiles = useCallback(async () => {
    setLoadingProfiles(true)
    setBootError(null)
    try {
      const list = await studyApi.listChildren()
      setProfiles(list)
      setSelectedChild((prev) =>
        prev ? (list.find((c) => c.id === prev.id) ?? prev) : null,
      )
    } catch (err) {
      setBootError(err instanceof Error ? err.message : '无法连接学习服务器')
    } finally {
      setLoadingProfiles(false)
    }
  }, [])

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  const refreshChildWorkspace = useCallback(
    async (childId: string, dateStr: string) => {
      const { start, end } = getMonthRange(dateStr)
      const [cal, timeline, dailyEval, freshProfiles] = await Promise.all([
        studyApi.getCalendar(childId, start, end),
        studyApi.getTimeline(childId, dateStr),
        studyApi.getDailyEvaluation(childId, dateStr),
        studyApi.listChildren(),
      ])
      setCalendarDays(cal)
      setDayTasks(timeline)
      setDayEvaluation(dailyEval)
      setProfiles(freshProfiles)
      const updatedChild = freshProfiles.find((c) => c.id === childId)
      if (updatedChild) {
        setSelectedChild(updatedChild)
      }
      const runningNow = timeline.find((t) => t.status === 'in_progress')
      if (runningNow) {
        setActiveTimerTask((curr) => curr ?? runningNow)
      }
    },
    [],
  )

  useEffect(() => {
    if (!selectedChild) return
    void refreshChildWorkspace(selectedChild.id, selectedDate)
  }, [selectedChild?.id, selectedDate, refreshChildWorkspace])

  useEffect(() => {
    const runningTaskJobEntries = Object.entries(activeJobsByTask).filter(
      ([, j]) => j.status !== 'succeeded' && j.status !== 'failed',
    )
    const isEvalRunning =
      dailyEvalJob !== null &&
      dailyEvalJob.status !== 'succeeded' &&
      dailyEvalJob.status !== 'failed'

    if (runningTaskJobEntries.length === 0 && !isEvalRunning) return

    const pollTimer = window.setInterval(async () => {
      for (const [taskId, job] of runningTaskJobEntries) {
        try {
          const fresh = await studyApi.getJobStatus(job.id)
          if (fresh.status === 'succeeded' && selectedChild) {
            pixelAudio.playChime('fanfare', soundEnabled)
            await refreshChildWorkspace(selectedChild.id, selectedDate)
            setActiveJobsByTask((prev) => ({ ...prev, [taskId]: fresh }))
            showToast('🎉 海星老师已完成作业批阅与错题讲解！')
          } else if (fresh.status === 'failed') {
            setActiveJobsByTask((prev) => ({ ...prev, [taskId]: fresh }))
            showToast(`⚠️ 作业批阅未完成：${fresh.errorDetail ?? '请重试'}`)
          } else {
            setActiveJobsByTask((prev) => ({ ...prev, [taskId]: fresh }))
          }
        } catch {
          void 0
        }
      }

      if (isEvalRunning && dailyEvalJob) {
        try {
          const freshEvalJob = await studyApi.getJobStatus(dailyEvalJob.id)
          setDailyEvalJob(freshEvalJob)
          if (freshEvalJob.status === 'succeeded' && selectedChild) {
            pixelAudio.playChime('fanfare', soundEnabled)
            await refreshChildWorkspace(selectedChild.id, selectedDate)
            setDailyReviewOpen(true)
            showToast('🏆 今日 100 分总评与海星老师语音讲评已生成！')
          } else if (freshEvalJob.status === 'failed') {
            showToast(`⚠️ 生成总评失败：${freshEvalJob.errorDetail ?? '请稍后重试'}`)
          }
        } catch {
          void 0
        }
      }
    }, 1800)

    return () => window.clearInterval(pollTimer)
  }, [
    activeJobsByTask,
    dailyEvalJob,
    refreshChildWorkspace,
    selectedChild,
    selectedDate,
    showToast,
    soundEnabled,
  ])

  const handleStartTimer = async (task: StudyTask) => {
    try {
      const started = await studyApi.startTimer(task.id)
      pixelAudio.playChime('sparkle', soundEnabled)
      setActiveTimerTask(started)
      if (selectedChild) {
        await refreshChildWorkspace(selectedChild.id, selectedDate)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '无法启动计时器')
    }
  }

  const handleToggleMode = async (task: StudyTask) => {
    try {
      const nextMode = task.timerMode === 'countdown' ? 'stopwatch' : 'countdown'
      await studyApi.switchTimerMode(task.id, nextMode)
      pixelAudio.playChime('tap', soundEnabled)
      if (selectedChild) {
        await refreshChildWorkspace(selectedChild.id, selectedDate)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '模式已锁定，无法切换')
    }
  }

  const handleDeletePending = async (taskId: string) => {
    try {
      await studyApi.deleteOrVoidTask(taskId, 'child')
      pixelAudio.playChime('tap', soundEnabled)
      if (selectedChild) {
        await refreshChildWorkspace(selectedChild.id, selectedDate)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '无法删除该任务')
    }
  }

  const handleTriggerDailyEval = async () => {
    if (!selectedChild) return
    try {
      const job = await studyApi.triggerDailyEvaluation(selectedChild.id, selectedDate)
      pixelAudio.playChime('sparkle', soundEnabled)
      setDailyEvalJob(job)
      showToast(`⏳ 海星老师正在为 ${selectedChild.displayName} 生成今日总评...`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '触发每日总评失败')
    }
  }

  const handleCreateTomorrowFromTips = async (tips: string[]) => {
    if (!selectedChild || tips.length === 0) return
    const [y, m, d] = selectedDate.split('-').map(Number)
    const nextD = new Date(y, (m || 1) - 1, (d || 1) + 1)
    const tomorrowYmd = `${nextD.getFullYear()}-${String(nextD.getMonth() + 1).padStart(2, '0')}-${String(nextD.getDate()).padStart(2, '0')}`

    try {
      showToast('⏳ 正在将明日建议安排到明天时间线...')
      const parsed = await studyApi.parseVoiceTasks(selectedChild.id, {
        transcript: tips.join('，'),
        targetDate: tomorrowYmd,
      })
      await studyApi.createTasksBatch(selectedChild.id, {
        targetDate: tomorrowYmd,
        rawTranscript: tips.join('；'),
        drafts: parsed.drafts,
      })
      setDailyReviewOpen(false)
      setSelectedDate(tomorrowYmd)
      showToast(`🌱 已排入明日 (${tomorrowYmd}) 时间线！`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '生成明日任务失败')
    }
  }

  const activeHomeworkTask = homeworkModalState
    ? dayTasks.find((t) => t.id === homeworkModalState.taskId) ?? null
    : null

  return (
    <LockedLandscapeStage>
      {toastBanner && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 pixel-card-butter px-6 py-2.5 text-[16px] font-extrabold text-[#332230] flex items-center gap-4 shadow-lg whitespace-nowrap">
          <span>{toastBanner}</span>
          <button
            type="button"
            onClick={() => setToastBanner(null)}
            className="text-[14px] underline cursor-pointer"
          >
            关闭
          </button>
        </div>
      )}

      {!selectedChild ? (
        <ChildEntryGate
          profiles={profiles}
          loading={loadingProfiles}
          errorMsg={bootError}
          onRetry={loadProfiles}
          onEnterChildSpace={(child) => {
            pixelAudio.playChime('sparkle', soundEnabled)
            setSelectedChild(child)
          }}
        />
      ) : (
        <div className="relative w-full h-full p-4 flex flex-col gap-3.5 overflow-hidden">
          <TopRibbonBar
            activeGirl={selectedChild}
            soundEnabled={soundEnabled}
            onBackToChildGate={() => {
              pixelAudio.playChime('tap', soundEnabled)
              setSelectedChild(null)
            }}
            onOpenDictionary={() => {
              pixelAudio.playChime('sparkle', soundEnabled)
              setDictionaryOpen(true)
            }}
            onToggleSound={() => setSoundEnabled((v) => !v)}
            onOpenParentBoard={() => {
              pixelAudio.playChime('sparkle', soundEnabled)
              setParentBoardOpen(true)
            }}
          />

          <div className="flex-1 min-h-0 grid grid-cols-12 gap-4">
            <div className="col-span-7 flex flex-col gap-3.5 min-h-0">
              <CalendarSection
                selectedDate={selectedDate}
                calendarDays={calendarDays}
                onSelectDate={(ymd) => {
                  pixelAudio.playChime('tap', soundEnabled)
                  setSelectedDate(ymd)
                }}
              />

              <TimelinePanel
                selectedDate={selectedDate}
                dayTasks={dayTasks}
                activeJobsByTask={activeJobsByTask}
                onOpenVoiceCreator={() => setVoiceModalOpen(true)}
                onStartTaskTimer={handleStartTimer}
                onToggleTaskTimerMode={handleToggleMode}
                onOpenHomeworkModal={(task, mode) =>
                  setHomeworkModalState({ taskId: task.id, mode })
                }
                onDeletePendingTask={handleDeletePending}
              />
            </div>

            <div className="col-span-5 min-h-0">
              <StellaCompanionSidePanel
                girl={selectedChild}
                selectedDate={selectedDate}
                dayTasks={dayTasks}
                dayEvaluation={dayEvaluation}
                dailyEvalJob={dailyEvalJob}
                onGenerateDailyEval={handleTriggerDailyEval}
                onOpenDailyEvalModal={() => setDailyReviewOpen(true)}
                onOpenVoiceCreator={() => setVoiceModalOpen(true)}
              />
            </div>
          </div>

          {voiceModalOpen && (
            <VoiceTaskModal
              childId={selectedChild.id}
              girlName={selectedChild.displayName}
              selectedDate={selectedDate}
              soundEnabled={soundEnabled}
              onClose={() => setVoiceModalOpen(false)}
              onTasksCreated={async (count) => {
                setVoiceModalOpen(false)
                await refreshChildWorkspace(selectedChild.id, selectedDate)
                showToast(`✨ 已加入 ${count} 项新任务！`)
              }}
            />
          )}

          {activeTimerTask && (
            <FocusTimerModal
              task={activeTimerTask}
              girlName={selectedChild.displayName}
              soundEnabled={soundEnabled}
              onPauseAndExit={async () => {
                setActiveTimerTask(null)
                await refreshChildWorkspace(selectedChild.id, selectedDate)
                showToast('⏸ 已暂停专注计时（已用时间安全锁定不可重置）')
              }}
              onFinishToSubmit={async (settled) => {
                setActiveTimerTask(null)
                await refreshChildWorkspace(selectedChild.id, selectedDate)
                setHomeworkModalState({ taskId: settled.id, mode: 'initial' })
              }}
            />
          )}

          {homeworkModalState && activeHomeworkTask && (
            <HomeworkSubmitModal
              task={activeHomeworkTask}
              initialMode={homeworkModalState.mode}
              activeJob={activeJobsByTask[activeHomeworkTask.id] ?? null}
              soundEnabled={soundEnabled}
              onClose={() => setHomeworkModalState(null)}
              onJobStarted={(taskId, job) => {
                setActiveJobsByTask((prev) => ({ ...prev, [taskId]: job }))
              }}
              onRefreshTask={() => refreshChildWorkspace(selectedChild.id, selectedDate)}
            />
          )}

          {dailyReviewOpen && dayEvaluation && (
            <DailyReviewModal
              girl={selectedChild}
              evaluation={dayEvaluation}
              onClose={() => setDailyReviewOpen(false)}
              onCreateTomorrowTasksFromTips={handleCreateTomorrowFromTips}
            />
          )}

          {parentBoardOpen && (
            <ParentBoardModal
              girl={selectedChild}
              onClose={() => setParentBoardOpen(false)}
              onVoidedTask={() => refreshChildWorkspace(selectedChild.id, selectedDate)}
            />
          )}

          {dictionaryOpen && (
            <DictionaryModal
              childId={selectedChild.id}
              girlName={selectedChild.displayName}
              soundEnabled={soundEnabled}
              onClose={() => setDictionaryOpen(false)}
            />
          )}
        </div>
      )}
    </LockedLandscapeStage>
  )
}
