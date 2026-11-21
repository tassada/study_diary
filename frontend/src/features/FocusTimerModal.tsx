import { useEffect, useRef, useState } from 'react'
import { StellaTeacherSprite, SubjectPixelIcon } from '../components/PixelSprites'
import { SUBJECT_CONFIG } from '../config/pixelTheme'
import { studyApi } from '../services/apiClient'
import {
  startSilentAttentionTracker,
  type SilentAttentionSessionHandle,
} from '../services/attentionTracker'
import { pixelAudio } from '../services/pixelAudio'
import type { StudyTask } from '../types/study'

interface FocusTimerModalProps {
  task: StudyTask
  girlName: string
  soundEnabled: boolean
  onPauseAndExit: (updatedTask: StudyTask) => void
  onFinishToSubmit: (settledTask: StudyTask) => void
}

function formatClockDigits(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function FocusTimerModal({
  task,
  girlName,
  soundEnabled,
  onPauseAndExit,
  onFinishToSubmit,
}: FocusTimerModalProps) {
  const [isRunning, setIsRunning] = useState(task.status === 'in_progress')
  const [nightMode, setNightMode] = useState(false)
  const [pauseCount, setPauseCount] = useState(task.pauseCount)
  const [elapsedSec, setElapsedSec] = useState(task.actualDurationSec)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [autoPauseAlert, setAutoPauseAlert] = useState<string | null>(task.autoPausedReason)
  const [busyAction, setBusyAction] = useState(false)
  const alarmTriggeredRef = useRef(false)
  const lastInteractionMsRef = useRef(Date.now())
  const attentionHandleRef = useRef<SilentAttentionSessionHandle | null>(null)

  useEffect(() => {
    let cancelled = false
    startSilentAttentionTracker({
      taskId: task.id,
      childId: task.childId,
      taskDate: task.taskDate,
      taskTitle: task.title,
      initialElapsedSec: task.actualDurationSec,
    })
      .then((handle) => {
        if (cancelled) {
          void handle.stopAndFlush(task.actualDurationSec)
          return
        }
        attentionHandleRef.current = handle
        if (task.status !== 'in_progress') {
          void handle.pauseCapture()
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      const h = attentionHandleRef.current
      attentionHandleRef.current = null
      if (h) {
        void h.stopAndFlush(task.actualDurationSec)
      }
    }
  }, [task.id])

  useEffect(() => {
    let lockSentinel: { release: () => Promise<void> } | null = null
    const navWithWake = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
    }
    if (navWithWake.wakeLock) {
      navWithWake.wakeLock
        .request('screen')
        .then((sentinel) => {
          lockSentinel = sentinel
          setWakeLockActive(true)
        })
        .catch(() => setWakeLockActive(false))
    }
    return () => {
      if (lockSentinel) {
        void lockSentinel.release()
      }
    }
  }, [])

  useEffect(() => {
    if (!isRunning) return
    const lastTick = { ms: performance.now() }
    const timer = window.setInterval(() => {
      const now = performance.now()
      const deltaSec = Math.floor((now - lastTick.ms) / 1000)
      if (deltaSec >= 1) {
        lastTick.ms += deltaSec * 1000
        setElapsedSec((prev) => prev + deltaSec)
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [isRunning])

  useEffect(() => {
    if (!isRunning) return
    const hb = window.setInterval(() => {
      if (Date.now() - lastInteractionMsRef.current >= 5400 * 1000) {
        studyApi
          .pauseTimer(task.id)
          .then((paused) => {
            setIsRunning(false)
            setPauseCount(paused.pauseCount)
            setElapsedSec(paused.actualDurationSec)
            setAutoPauseAlert('已连续 90 分钟无交互操作，系统自动暂停防止挂机计时')
          })
          .catch(() => undefined)
        return
      }
      studyApi
        .heartbeatTimer(task.id)
        .then((synced) => {
          if (synced.status !== 'in_progress') {
            setIsRunning(false)
            setAutoPauseAlert(synced.autoPausedReason ?? '计时已暂停')
          }
        })
        .catch(() => undefined)
    }, 20000)
    return () => window.clearInterval(hb)
  }, [isRunning, task.id])

  useEffect(() => {
    if (
      task.timerMode === 'countdown' &&
      elapsedSec >= task.plannedDurationSec &&
      !alarmTriggeredRef.current
    ) {
      alarmTriggeredRef.current = true
      pixelAudio.playChime('gentle_alarm', soundEnabled)
    }
  }, [elapsedSec, soundEnabled, task.plannedDurationSec, task.timerMode])

  const markUserInteraction = () => {
    lastInteractionMsRef.current = Date.now()
    setAutoPauseAlert(null)
  }

  const handleTogglePause = async () => {
    if (busyAction) return
    markUserInteraction()
    setBusyAction(true)
    pixelAudio.playChime('tap', soundEnabled)
    try {
      if (isRunning) {
        await attentionHandleRef.current?.pauseCapture()
        const paused = await studyApi.pauseTimer(task.id)
        setIsRunning(false)
        setPauseCount(paused.pauseCount)
        setElapsedSec(paused.actualDurationSec)
      } else {
        const resumed = await studyApi.startTimer(task.id)
        setIsRunning(true)
        setPauseCount(resumed.pauseCount)
        setElapsedSec(resumed.actualDurationSec)
        await attentionHandleRef.current?.resumeCapture(resumed.actualDurationSec)
      }
    } finally {
      setBusyAction(false)
    }
  }

  const handlePauseAndBack = async () => {
    if (busyAction) return
    setBusyAction(true)
    try {
      const h = attentionHandleRef.current
      attentionHandleRef.current = null
      if (h) {
        await h.stopAndFlush(elapsedSec)
      }
      const updated = isRunning ? await studyApi.pauseTimer(task.id) : task
      onPauseAndExit({
        ...updated,
        actualDurationSec: Math.max(updated.actualDurationSec, elapsedSec),
      })
    } finally {
      setBusyAction(false)
    }
  }

  const handleFinish = async () => {
    if (busyAction) return
    setBusyAction(true)
    pixelAudio.playChime('fanfare', soundEnabled)
    try {
      const h = attentionHandleRef.current
      attentionHandleRef.current = null
      if (h) {
        await h.stopAndFlush(elapsedSec)
      }
      const settled = isRunning ? await studyApi.pauseTimer(task.id) : task
      onFinishToSubmit({
        ...settled,
        actualDurationSec: Math.max(settled.actualDurationSec, elapsedSec, 15),
      })
    } finally {
      setBusyAction(false)
    }
  }

  const isOvertime = task.timerMode === 'countdown' && elapsedSec > task.plannedDurationSec
  const remainingSec = Math.max(0, task.plannedDurationSec - elapsedSec)
  const overtimeSec = Math.max(0, elapsedSec - task.plannedDurationSec)

  const progressPct =
    task.timerMode === 'countdown'
      ? Math.min(100, Math.round((remainingSec / Math.max(1, task.plannedDurationSec)) * 100))
      : Math.min(100, Math.round((elapsedSec / Math.max(1, task.plannedDurationSec)) * 100))

  const earnedStarBeans = Math.floor(elapsedSec / 300)
  const subj = SUBJECT_CONFIG[task.subject] ?? SUBJECT_CONFIG.chinese

  return (
    <div
      onPointerDown={markUserInteraction}
      className={`absolute inset-0 z-50 flex flex-col justify-between p-6 transition-colors ${
        nightMode ? 'eye-night-stage text-white' : 'eye-gingham-stage text-[#332230]'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={busyAction}
          onClick={handlePauseAndBack}
          className="pixel-btn bg-[#FFFDF9] text-[#332230] px-5 py-2.5 text-[17px] font-extrabold h-[50px]"
        >
          ⬅ 暂停并返回时间线
        </button>

        <div className="inline-flex items-center gap-3 bg-[#FFFDF9] text-[#332230] border-3 border-[#4A2B44] rounded-md px-5 py-2 shadow-[3px_3px_0_#EC5F9B]">
          <SubjectPixelIcon subject={task.subject} size={32} />
          <div className="text-left">
            <div className="text-[20px] font-extrabold leading-tight">{task.title}</div>
            <div className="text-[14px] font-semibold text-[#5C4056] font-num">
              {subj.label} · 独立 100 分制 · 已暂停 {pauseCount} 次 · 🔒 禁止重置
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {wakeLockActive && (
            <span className="text-[14px] font-bold bg-[#FFFDF9] text-[#332230] border-2 border-[#4A2B44] rounded px-3 py-2">
              🔆 常亮模式
            </span>
          )}
          <button
            type="button"
            onClick={() => setNightMode((v) => !v)}
            className="pixel-btn bg-[#FFFDF9] text-[#332230] px-4 py-2 text-[16px] font-bold h-[48px]"
          >
            {nightMode ? '🌸 昼间护眼' : '🌙 夜间护眼'}
          </button>
        </div>
      </div>

      <div className="max-w-[920px] w-full mx-auto text-center space-y-5 my-auto">
        <div className="inline-flex items-center gap-2 bg-[#FFFDF9] text-[#332230] border-2 border-[#4A2B44] rounded px-5 py-2 text-[16px] font-extrabold">
          <span>
            {task.timerMode === 'countdown'
              ? `🔒 当前锁定：⏳ 沙漏倒计时模式（目标 ${Math.round(task.plannedDurationSec / 60)} 分钟，不可重置）`
              : `🔒 当前锁定：⏱️ 星星正计时模式（目标 ${Math.round(task.plannedDurationSec / 60)} 分钟，不可重置）`}
          </span>
        </div>

        {autoPauseAlert && (
          <div className="bg-[#FFE8F0] border-3 border-[#C92A6A] rounded px-5 py-2.5 text-[16px] font-extrabold text-[#7A1C3E]">
            🛡️ {autoPauseAlert}
          </div>
        )}

        <div className="pixel-card bg-[#FFFDF9] text-[#332230] px-10 py-8">
          <div className="text-[19px] font-bold text-[#5C4056] mb-1">
            {!isRunning
              ? '⏸ 已暂停计时（时间已锁定保留，准备好请点下方继续）'
              : task.timerMode === 'countdown'
                ? isOvertime
                  ? '💜 倒计时已到点！正在温柔累积你的收尾完成时间~'
                  : remainingSec <= 180
                    ? '🧡 最后冲刺时间，认真检查一下哦！'
                    : `✨ ${girlName}正在专注学习，海星老师安静陪着你！`
                : `🌟 正向累积专注时长 · 每满 5 分钟点亮一颗星莓豆（已亮 ${earnedStarBeans} 颗）`}
          </div>

          <div
            className={`font-num text-[112px] font-extrabold leading-none tracking-tight py-4 ${
              isOvertime
                ? 'text-[#7C3AED]'
                : task.timerMode === 'countdown' && remainingSec <= 180
                  ? 'text-[#D97706]'
                  : 'text-[#C92A6A]'
            }`}
          >
            {task.timerMode === 'countdown'
              ? isOvertime
                ? `+${formatClockDigits(overtimeSec)}`
                : formatClockDigits(remainingSec)
              : formatClockDigits(elapsedSec)}
          </div>

          <div className="text-[18px] font-bold text-[#5C4056] font-num mb-5">
            累计有效专注：{formatClockDigits(elapsedSec)} &nbsp;|&nbsp; 计划目标时长：
            {formatClockDigits(task.plannedDurationSec)}
          </div>

          <div className="h-7 bg-[#F9E6F0] border-3 border-[#4A2B44] rounded p-0.5">
            <div
              className={`h-full rounded-xs transition-all duration-300 ${
                isOvertime
                  ? 'bg-[#9333EA]'
                  : task.timerMode === 'countdown'
                    ? 'bg-[#EC5F9B]'
                    : 'bg-[#44B98A]'
              }`}
              style={{ width: `${isOvertime ? 100 : progressPct}%` }}
            />
          </div>

          <div className="mt-4 flex items-center justify-center gap-2.5 text-[16px] font-semibold text-[#5C4056]">
            <StellaTeacherSprite talking={false} size={34} />
            <span>{task.scoreHint}</span>
          </div>
        </div>

        <div className="flex items-center justify-center gap-6 pt-1">
          <button
            type="button"
            disabled={busyAction}
            onClick={handleTogglePause}
            className="pixel-btn bg-[#FFE484] text-[#332230] px-9 py-4 text-[22px] font-extrabold h-[72px] min-w-[250px]"
          >
            {isRunning ? '⏸ 暂停休息一下' : '▶️ 继续专注计时'}
          </button>

          <button
            type="button"
            disabled={busyAction}
            onClick={handleFinish}
            className="pixel-btn bg-[#52CE9B] text-[#104530] px-10 py-4 text-[22px] font-extrabold h-[72px] min-w-[300px]"
          >
            🎉 做完啦！上传作业图
          </button>
        </div>
      </div>

      <div className="h-2" />
    </div>
  )
}
