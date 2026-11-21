import { useCallback, useEffect, useRef, useState } from 'react'
import { formatCnTime, getTodayDateStr, SUBJECT_CONFIG } from '../config/pixelTheme'
import { studyApi } from '../services/apiClient'
import {
  clearLocalAttentionStreamsForChild,
  decodeAttentionStream,
  getLocalAttentionStorageStats,
  getStoredAttentionStream,
  type DecodedAttentionFrame,
} from '../services/attentionTracker'
import type {
  AttentionStateKey,
  DailyAttentionReport,
  TaskAttentionSummary,
} from '../types/study'

interface ParentAttentionPanelProps {
  childId: string
}

const STATE_META: Record<
  AttentionStateKey,
  { label: string; hex: string; badgeBg: string; dotColor: string }
> = {
  focused: {
    label: '认真看书写字',
    hex: '#22C55E',
    badgeBg: '#DCFCE7',
    dotColor: '#4ADE80',
  },
  distracted: {
    label: '扭头/视线走神',
    hex: '#FACC15',
    badgeBg: '#FEF9C3',
    dotColor: '#FDE047',
  },
  drowsy: {
    label: '闭眼犯困/发呆',
    hex: '#A855F7',
    badgeBg: '#F3E8FF',
    dotColor: '#C084FC',
  },
  near_posture: {
    label: '距离过近(<28cm)',
    hex: '#F97316',
    badgeBg: '#FFEDD5',
    dotColor: '#FB923C',
  },
  away: {
    label: '离开座位',
    hex: '#CBD5E1',
    badgeBg: '#F1F5F9',
    dotColor: '#94A3B8',
  },
}

function formatMmSs(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatDurationLabel(sec: number): string {
  if (sec <= 0) return '0秒'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m === 0) return `${s}秒`
  if (s === 0) return `${m}分钟`
  return `${m}分${s}秒`
}

function formatBytesReadable(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function shiftDateYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, (d || 1) + deltaDays)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

export function ParentAttentionPanel({ childId }: ParentAttentionPanelProps) {
  const [queryDate, setQueryDate] = useState<string>(() => getTodayDateStr())
  const [report, setReport] = useState<DailyAttentionReport | null>(null)
  const [loading, setLoading] = useState(false)

  const [storageBytes, setStorageBytes] = useState(0)
  const [taskBytesMap, setTaskBytesMap] = useState<Record<string, number>>({})

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [frames, setFrames] = useState<DecodedAttentionFrame[]>([])
  const [frameIdx, setFrameIdx] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState<1 | 4 | 8>(1)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const refreshStorageStats = useCallback(async () => {
    const stats = await getLocalAttentionStorageStats(childId).catch(() => ({
      totalBytes: 0,
      taskCount: 0,
      taskBytesMap: {},
    }))
    setStorageBytes(stats.totalBytes)
    setTaskBytesMap(stats.taskBytesMap)
  }, [childId])

  const loadDailyReport = useCallback(
    async (dateStr: string) => {
      setLoading(true)
      try {
        const data = await studyApi.getDailyAttentionReport(childId, dateStr)
        setReport(data)
        await refreshStorageStats()
        const firstWithData =
          data.tasks.find((t) => t.segments.length > 0) ?? data.tasks[0] ?? null
        setSelectedTaskId(firstWithData?.taskId ?? null)
      } finally {
        setLoading(false)
      }
    },
    [childId, refreshStorageStats],
  )

  useEffect(() => {
    void loadDailyReport(queryDate)
  }, [loadDailyReport, queryDate])

  useEffect(() => {
    setIsPlaying(false)
    setFrameIdx(0)
    if (!selectedTaskId) {
      setFrames([])
      return
    }
    getStoredAttentionStream(selectedTaskId)
      .then((rec) => {
        if (!rec) {
          setFrames([])
          return
        }
        setFrames(decodeAttentionStream(rec.buffer))
      })
      .catch(() => setFrames([]))
  }, [selectedTaskId])

  useEffect(() => {
    if (!isPlaying || frames.length <= 1) return
    const intervalMs = Math.max(28, Math.round(250 / speed))
    const timer = window.setInterval(() => {
      setFrameIdx((curr) => {
        if (curr + 1 >= frames.length) {
          setIsPlaying(false)
          return curr
        }
        return curr + 1
      })
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [frames.length, isPlaying, speed])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    ctx.fillStyle = '#181224'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let gx = 40; gx < w; gx += 40) {
      ctx.beginPath()
      ctx.moveTo(gx, 0)
      ctx.lineTo(gx, h)
      ctx.stroke()
    }
    for (let gy = 40; gy < h; gy += 40) {
      ctx.beginPath()
      ctx.moveTo(0, gy)
      ctx.lineTo(w, gy)
      ctx.stroke()
    }

    const frame = frames[frameIdx]
    if (!frame) {
      ctx.fillStyle = '#CBD5E1'
      ctx.font = 'bold 16px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('本机暂无该任务的原始点阵回放流（仅在采集该任务的 iPad 本机保存）', w / 2, h / 2)
      return
    }

    if (!frame.present || !frame.points) {
      ctx.strokeStyle = '#64748B'
      ctx.setLineDash([6, 6])
      ctx.strokeRect(w * 0.25, h * 0.2, w * 0.5, h * 0.6)
      ctx.setLineDash([])
      ctx.fillStyle = '#94A3B8'
      ctx.font = 'bold 20px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('⚪ 空座（孩子未在镜头前）', w / 2, h / 2)
      return
    }

    const pts = frame.points
    const toScreen = (idx: number): [number, number] => {
      const nx = pts[idx * 2] / 1000
      const ny = pts[idx * 2 + 1] / 1000
      return [w * 0.5 + nx * (w * 0.42), h * 0.52 + ny * (h * 0.42)]
    }

    const meta = STATE_META[frame.state] ?? STATE_META.focused
    ctx.fillStyle = meta.dotColor
    for (let i = 0; i < 78; i += 1) {
      const [sx, sy] = toScreen(i)
      ctx.beginPath()
      ctx.arc(sx, sy, 2.8, 0, Math.PI * 2)
      ctx.fill()
    }

    const drawRay = (
      fromIdx: number,
      toIdx: number,
      strokeHex: string,
      pupilRadius: number,
    ) => {
      const [x1, y1] = toScreen(fromIdx)
      const [x2, y2] = toScreen(toIdx)

      ctx.fillStyle = strokeHex
      ctx.beginPath()
      ctx.arc(x1, y1, pupilRadius, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = strokeHex
      ctx.lineWidth = 2.6
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()

      const angle = Math.atan2(y2 - y1, x2 - x1)
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - 8 * Math.cos(angle - 0.45), y2 - 8 * Math.sin(angle - 0.45))
      ctx.lineTo(x2 - 8 * Math.cos(angle + 0.45), y2 - 8 * Math.sin(angle + 0.45))
      ctx.closePath()
      ctx.fill()
    }

    drawRay(82, 83, 'rgba(192,132,252,0.75)', 3.2)
    drawRay(78, 79, '#FDE047', 4.6)
    drawRay(80, 81, '#FDE047', 4.6)
  }, [frameIdx, frames])

  const jumpToOffsetSec = (task: TaskAttentionSummary, targetOffsetSec: number) => {
    if (selectedTaskId !== task.taskId) {
      setSelectedTaskId(task.taskId)
      getStoredAttentionStream(task.taskId)
        .then((rec) => {
          if (!rec) {
            setFrames([])
            return
          }
          const decoded = decodeAttentionStream(rec.buffer)
          setFrames(decoded)
          const idx = decoded.findIndex((f) => f.offsetMs >= targetOffsetSec * 1000)
          setFrameIdx(idx >= 0 ? idx : 0)
        })
        .catch(() => setFrames([]))
      return
    }
    const idx = frames.findIndex((f) => f.offsetMs >= targetOffsetSec * 1000)
    if (idx >= 0) {
      setFrameIdx(idx)
    }
  }

  const activeFrame = frames[frameIdx] ?? null
  const maxOffsetSec =
    frames.length > 0 ? Math.round(frames[frames.length - 1].offsetMs / 1000) : 0

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="pixel-card bg-[#FFFDF9] px-4 py-2.5 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setQueryDate((d) => shiftDateYmd(d, -1))}
            className="pixel-btn bg-[#FAF4EC] px-3 py-1 text-[14px] font-extrabold"
          >
            ◀ 前一天
          </button>
          <span className="font-num text-[16px] font-extrabold bg-[#FFE484] border-2 border-[#4A2B44] px-3 py-0.5 rounded">
            📅 {queryDate}
          </span>
          <button
            type="button"
            onClick={() => setQueryDate((d) => shiftDateYmd(d, 1))}
            className="pixel-btn bg-[#FAF4EC] px-3 py-1 text-[14px] font-extrabold"
          >
            后一天 ▶
          </button>
          <button
            type="button"
            onClick={() => setQueryDate(getTodayDateStr())}
            className="pixel-btn bg-[#FFFDF9] px-2.5 py-1 text-[13px] font-bold"
          >
            今天
          </button>
        </div>

        <div className="flex items-center gap-4 text-[14px] font-bold text-[#332230] font-num">
          <span>
            在座率：
            <b className="text-[#2563EB] text-[16px]">{report?.presentRatePct ?? 0}%</b>（
            {formatDurationLabel(report?.presentSec ?? 0)}）
          </span>
          <span>
            认真看书率：
            <b className="text-[#16A34A] text-[16px]">{report?.focusRatePct ?? 0}%</b>（
            {formatDurationLabel(report?.focusedSec ?? 0)}）
          </span>
          <span>
            平均眼距：
            <b className="text-[#C92A6A] text-[16px]">
              {report && report.avgDistanceCm > 0 ? `${report.avgDistanceCm}cm` : '—'}
            </b>
          </span>
          <span className="bg-[#F6F2FC] border border-[#4A2B44] px-2.5 py-0.5 rounded text-[12px]">
            本机点阵缓存：{formatBytesReadable(storageBytes)}
          </span>
          {storageBytes > 0 && (
            <button
              type="button"
              onClick={async () => {
                await clearLocalAttentionStreamsForChild(childId)
                setFrames([])
                await refreshStorageStats()
              }}
              className="pixel-btn bg-[#FFE8F0] text-[#7A1C3E] px-2.5 py-0.5 text-[12px] font-bold"
            >
              清理本机点阵
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-12 gap-4">
        <div className="col-span-6 pixel-card p-3.5 flex flex-col min-h-0">
          <div className="flex items-center justify-between pb-2 border-b border-[#EAD6E2] shrink-0">
            <span className="font-extrabold text-[16px] text-[#332230]">
              🕒 分段在座与注意力时间轴（点击任意色块跳至点阵回放）
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 py-2 text-[12px] font-bold text-[#4A3346] shrink-0">
            {(Object.keys(STATE_META) as AttentionStateKey[]).map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span
                  className="inline-block w-3 h-3 rounded-xs border border-[#4A2B44]"
                  style={{ backgroundColor: STATE_META[k].hex }}
                />
                <span>{STATE_META[k].label}</span>
              </span>
            ))}
          </div>

          <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pr-1 space-y-2.5">
            {loading ? (
              <div className="p-8 text-center text-[15px] font-bold text-[#5C4056]">
                正在加载当日专注统计...
              </div>
            ) : !report || report.tasks.length === 0 ? (
              <div className="p-8 text-center text-[15px] font-bold text-[#5C4056]">
                当日暂无任务记录
              </div>
            ) : (
              report.tasks.map((t) => {
                const subj = SUBJECT_CONFIG[t.subject] ?? SUBJECT_CONFIG.chinese
                const isSel = selectedTaskId === t.taskId
                const localBytes = taskBytesMap[t.taskId] ?? 0
                return (
                  <div
                    key={t.taskId}
                    onClick={() => setSelectedTaskId(t.taskId)}
                    className={`border-2 rounded p-3 cursor-pointer transition-colors ${
                      isSel
                        ? 'bg-[#FFF5FA] border-[#EC5F9B]'
                        : 'bg-[#FAF4EC] border-[#4A2B44]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="px-2 py-0.5 rounded text-[12px] font-bold text-white shrink-0"
                          style={{ backgroundColor: subj.pillHex }}
                        >
                          {t.plannedStartTime ? `开始 ${t.plannedStartTime}` : '待开始'}
                        </span>
                        <span className="font-extrabold text-[16px] text-[#332230] truncate">
                          {t.title}
                        </span>
                      </div>
                      <span className="text-[12px] font-bold font-num text-[#5C4056] shrink-0">
                        更新 {formatCnTime(t.updatedAt)} ·{' '}
                        {localBytes > 0 ? `🎬 点阵 ${formatBytesReadable(localBytes)}` : '仅云端汇总'}
                      </span>
                    </div>

                    {t.segments.length === 0 ? (
                      <div className="text-[13px] text-[#7A5672] font-medium mt-2">
                        暂无采集分段（在 iPad 端开启专注计时后自动静默生成）
                      </div>
                    ) : (
                      <>
                        <div className="mt-2 flex items-center gap-1 h-6 bg-white border border-[#4A2B44] rounded p-1 overflow-x-auto">
                          {t.segments.map((seg) => {
                            const meta =
                              STATE_META[seg.dominantState] ?? STATE_META.focused
                            return (
                              <button
                                key={seg.segmentIndex}
                                type="button"
                                title={`第${seg.segmentIndex + 1}段 (${formatMmSs(seg.startOffsetSec)}) · ${meta.label}`}
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  jumpToOffsetSec(t, seg.startOffsetSec)
                                }}
                                className="h-full min-w-[16px] flex-1 rounded-xs border border-[#4A2B44]/40 cursor-pointer hover:opacity-80"
                                style={{ backgroundColor: meta.hex }}
                              />
                            )
                          })}
                        </div>

                        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px] font-semibold text-[#4A3346] font-num">
                          <span>在座 {t.presentRatePct}%</span>
                          <span>专注 {formatDurationLabel(t.focusedSec)}</span>
                          <span>走神 {formatDurationLabel(t.distractedSec)}</span>
                          {t.nearPostureSec > 0 && (
                            <span className="text-[#C2410C]">
                              过近 {formatDurationLabel(t.nearPostureSec)}
                            </span>
                          )}
                          {t.awaySec > 0 && <span>离座 {formatDurationLabel(t.awaySec)}</span>}
                          {t.avgDistanceCm > 0 && <span>均距 {t.avgDistanceCm}cm</span>}
                        </div>
                      </>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="col-span-6 pixel-card p-3.5 flex flex-col justify-between min-h-0">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#EAD6E2] shrink-0">
            <span className="font-extrabold text-[16px] text-[#332230]">
              🎯 84点人脸轮廓 + 双眼视线射线回放（纯本机零照片）
            </span>
            {activeFrame && (
              <span
                className="px-2.5 py-0.5 rounded border border-[#4A2B44] text-[12px] font-extrabold"
                style={{
                  backgroundColor: (STATE_META[activeFrame.state] ?? STATE_META.focused).badgeBg,
                }}
              >
                {(STATE_META[activeFrame.state] ?? STATE_META.focused).label}
              </span>
            )}
          </div>

          <div className="flex-1 min-h-0 my-2 relative flex items-center justify-center bg-[#181224] border-2 border-[#4A2B44] rounded overflow-hidden">
            <canvas
              ref={canvasRef}
              width={520}
              height={260}
              className="w-full h-full object-contain block"
            />
            {activeFrame && activeFrame.present && (
              <div className="absolute bottom-2 left-2.5 right-2.5 flex items-center justify-between text-[12px] font-num font-bold text-white/90 bg-black/45 px-2.5 py-1 rounded">
                <span>眼距：{activeFrame.distanceCm}cm</span>
                <span>
                  头姿：俯仰 {activeFrame.headPitchDeg.toFixed(0)}° / 偏航{' '}
                  {activeFrame.headYawDeg.toFixed(0)}°
                </span>
                <span>眨眼：{activeFrame.blinkPct}%</span>
              </div>
            )}
          </div>

          <div className="space-y-2 shrink-0">
            <input
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={Math.min(frameIdx, Math.max(0, frames.length - 1))}
              disabled={frames.length === 0}
              onChange={(e) => {
                setIsPlaying(false)
                setFrameIdx(Number(e.target.value))
              }}
              className="w-full accent-[#EC5F9B]"
            />

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={frames.length === 0}
                  onClick={() => {
                    if (frameIdx + 1 >= frames.length) {
                      setFrameIdx(0)
                    }
                    setIsPlaying((v) => !v)
                  }}
                  className="pixel-btn bg-[#FFE484] px-4 py-1.5 text-[14px] font-extrabold"
                >
                  {isPlaying ? '⏸ 暂停回放' : '▶️ 播放点阵'}
                </button>

                {([1, 4, 8] as const).map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => setSpeed(sp)}
                    className={`pixel-btn px-2.5 py-1.5 text-[13px] font-num font-extrabold ${
                      speed === sp ? 'bg-[#EC5F9B] text-white' : 'bg-[#FFFDF9]'
                    }`}
                  >
                    {sp}x
                  </button>
                ))}
              </div>

              <span className="font-num text-[13px] font-bold text-[#5C4056]">
                {activeFrame ? formatMmSs(Math.round(activeFrame.offsetMs / 1000)) : '00:00'} /{' '}
                {formatMmSs(maxOffsetSec)}（共 {frames.length} 帧）
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
