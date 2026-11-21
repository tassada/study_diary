import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { StellaTeacherSprite } from '../components/PixelSprites'
import { usePixelVoiceRecorder } from '../hooks/usePixelVoiceRecorder'
import { compressImageForModel, studyApi } from '../services/apiClient'
import { pixelAudio } from '../services/pixelAudio'
import type { AsyncJobInfo, DictionaryEntry, DictionaryLookup } from '../types/study'

import {
  canvasToJpegBlob,
  compositePixelBakedDictionaryCanvas,
  findHitBoxId,
  normalizeBoxCoords,
  rotateCanvas90Cw,
  type DictionaryAnnotation,
} from '../utils/dictionaryCanvas'

interface DictionaryModalProps {
  childId: string
  girlName: string
  soundEnabled: boolean
  onClose: () => void
}

const BRUSH_PRESETS = [
  { id: 's', label: '细笔', basePx: 20, dotPx: 8 },
  { id: 'm', label: '中笔', basePx: 38, dotPx: 13 },
  { id: 'l', label: '粗笔', basePx: 62, dotPx: 18 },
  { id: 'xl', label: '特粗', basePx: 92, dotPx: 24 },
] as const

export function DictionaryModal({
  childId,
  girlName,
  soundEnabled,
  onClose,
}: DictionaryModalProps) {
  const recorder = usePixelVoiceRecorder()
  const [viewTab, setViewTab] = useState<'paint' | 'result' | 'history'>('paint')
  const [tool, setTool] = useState<'box' | 'brush' | 'eraser'>('box')
  const [brushIdx, setBrushIdx] = useState<number>(1)

  const [hasPhoto, setHasPhoto] = useState(false)
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [regionCount, setRegionCount] = useState(0)
  const [actionCount, setActionCount] = useState(0)

  const [instruction, setInstruction] = useState('')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [preparingPhoto, setPreparingPhoto] = useState(false)
  const [activeJob, setActiveJob] = useState<AsyncJobInfo | null>(null)
  const [currentLookup, setCurrentLookup] = useState<DictionaryLookup | null>(null)
  const [historyList, setHistoryList] = useState<DictionaryLookup[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [playingAudioKey, setPlayingAudioKey] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const baseImageCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const actionsRef = useRef<DictionaryAnnotation[]>([])
  const draftBoxRef = useRef<[number, number, number, number] | null>(null)
  const boxAnchorRef = useRef<{ x: number; y: number } | null>(null)
  const activeStrokeIdRef = useRef<string | null>(null)
  const drawingRef = useRef(false)
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)

  const stopWordAudio = useCallback(() => {
    if (activeAudioRef.current) {
      activeAudioRef.current.pause()
      activeAudioRef.current = null
    }
    setPlayingAudioKey(null)
  }, [])

  useEffect(() => {
    return () => {
      stopWordAudio()
    }
  }, [stopWordAudio])

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const list = await studyApi.listDictionaryHistory(childId, 30)
      setHistoryList(list)
    } catch {
      void 0
    } finally {
      setLoadingHistory(false)
    }
  }, [childId])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const redrawVisibleCanvas = useCallback(() => {
    const vis = visibleCanvasRef.current
    const base = baseImageCanvasRef.current
    if (!vis || !base || base.width === 0 || base.height === 0) return []
    const regions = compositePixelBakedDictionaryCanvas(
      vis,
      base,
      actionsRef.current,
      draftBoxRef.current,
    )
    setRegionCount(regions.length)
    setActionCount(actionsRef.current.length)
    return regions
  }, [])

  useEffect(() => {
    if (viewTab === 'paint' && hasPhoto && imgSize.w > 0) {
      redrawVisibleCanvas()
    }
  }, [viewTab, hasPhoto, imgSize.w, imgSize.h, redrawVisibleCanvas])

  const handlePhotoSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.files?.[0]
    e.target.value = ''
    if (!raw) return

    setErrorMsg(null)
    setPreparingPhoto(true)
    try {
      const compressed = await compressImageForModel(raw, 1600, 0.9)
      const tempUrl = URL.createObjectURL(compressed)
      try {
        const loadedImg = await new Promise<HTMLImageElement>((resolve, reject) => {
          const probe = new Image()
          probe.onload = () => resolve(probe)
          probe.onerror = () => reject(new Error('无法读取照片尺寸'))
          probe.src = tempUrl
        })
        const base = document.createElement('canvas')
        base.width = loadedImg.naturalWidth
        base.height = loadedImg.naturalHeight
        const bctx = base.getContext('2d')
        if (!bctx) {
          throw new Error('初始化照片画布失败')
        }
        bctx.drawImage(loadedImg, 0, 0, base.width, base.height)
        baseImageCanvasRef.current = base
        actionsRef.current = []
        draftBoxRef.current = null
        setImgSize({ w: base.width, h: base.height })
        setHasPhoto(true)
        setRegionCount(0)
        setActionCount(0)
        setTool('box')
        setViewTab('paint')
        pixelAudio.playChime('sparkle', soundEnabled)
      } finally {
        URL.revokeObjectURL(tempUrl)
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取照片失败，请重试')
    } finally {
      setPreparingPhoto(false)
    }
  }

  const handleRotatePhoto = () => {
    const base = baseImageCanvasRef.current
    if (!base || isJobRunning) return
    const rotated = rotateCanvas90Cw(base)
    baseImageCanvasRef.current = rotated
    actionsRef.current = []
    draftBoxRef.current = null
    setImgSize({ w: rotated.width, h: rotated.height })
    setRegionCount(0)
    setActionCount(0)
    pixelAudio.playChime('tap', soundEnabled)
  }

  const getScaledStrokeWidth = (): number => {
    const preset = BRUSH_PRESETS[brushIdx] ?? BRUSH_PRESETS[1]
    const longest = Math.max(800, imgSize.w, imgSize.h)
    return Math.max(10, Math.round((preset.basePx * longest) / 1300))
  }

  const pointerToCanvasCoords = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const vis = visibleCanvasRef.current
    if (!vis) return null
    const rect = vis.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = Math.max(0, Math.min(vis.width, ((e.clientX - rect.left) / rect.width) * vis.width))
    const y = Math.max(0, Math.min(vis.height, ((e.clientY - rect.top) / rect.height) * vis.height))
    return { x, y }
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!hasPhoto || isJobRunning || !baseImageCanvasRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = pointerToCanvasCoords(e)
    if (!pt) return
    drawingRef.current = true

    if (tool === 'box') {
      boxAnchorRef.current = pt
      draftBoxRef.current = normalizeBoxCoords(
        pt.x,
        pt.y,
        pt.x,
        pt.y,
        baseImageCanvasRef.current.width,
        baseImageCanvasRef.current.height,
      )
      redrawVisibleCanvas()
      return
    }

    if (tool === 'eraser') {
      const hitBoxId = findHitBoxId(actionsRef.current, pt, 10)
      if (hitBoxId) {
        actionsRef.current = actionsRef.current.filter((a) => a.id !== hitBoxId)
      }
    }

    const strokeId = `st-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    activeStrokeIdRef.current = strokeId
    actionsRef.current = [
      ...actionsRef.current,
      {
        kind: 'stroke',
        id: strokeId,
        tool: tool === 'eraser' ? 'eraser' : 'brush',
        width: getScaledStrokeWidth(),
        points: [pt],
      },
    ]
    redrawVisibleCanvas()
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !baseImageCanvasRef.current) return
    const pt = pointerToCanvasCoords(e)
    if (!pt) return

    if (tool === 'box' && boxAnchorRef.current) {
      draftBoxRef.current = normalizeBoxCoords(
        boxAnchorRef.current.x,
        boxAnchorRef.current.y,
        pt.x,
        pt.y,
        baseImageCanvasRef.current.width,
        baseImageCanvasRef.current.height,
      )
      redrawVisibleCanvas()
      return
    }

    if (tool === 'eraser') {
      const hitBoxId = findHitBoxId(actionsRef.current, pt, 10)
      if (hitBoxId) {
        actionsRef.current = actionsRef.current.filter((a) => a.id !== hitBoxId)
      }
    }

    const activeId = activeStrokeIdRef.current
    if (!activeId) return
    const list = actionsRef.current
    const idx = list.findIndex((a) => a.id === activeId)
    if (idx >= 0 && list[idx].kind === 'stroke') {
      const target = list[idx]
      target.points.push(pt)
      redrawVisibleCanvas()
    }
  }

  const handlePointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false

    if (tool === 'box') {
      const box = draftBoxRef.current
      draftBoxRef.current = null
      boxAnchorRef.current = null
      if (box && box[2] - box[0] >= 10 && box[3] - box[1] >= 10) {
        actionsRef.current = [
          ...actionsRef.current,
          {
            kind: 'box',
            id: `bx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            x1: box[0],
            y1: box[1],
            x2: box[2],
            y2: box[3],
          },
        ]
        pixelAudio.playChime('tap', soundEnabled)
      }
      redrawVisibleCanvas()
      return
    }

    activeStrokeIdRef.current = null
    redrawVisibleCanvas()
  }

  const handleUndo = () => {
    if (actionsRef.current.length === 0 || isJobRunning) return
    actionsRef.current = actionsRef.current.slice(0, -1)
    draftBoxRef.current = null
    redrawVisibleCanvas()
    pixelAudio.playChime('tap', soundEnabled)
  }

  const handleClearMask = () => {
    actionsRef.current = []
    draftBoxRef.current = null
    redrawVisibleCanvas()
    pixelAudio.playChime('tap', soundEnabled)
  }

  const handleVoiceInstruction = async () => {
    setErrorMsg(null)
    if (!recorder.isRecording) {
      pixelAudio.playChime('tap', soundEnabled)
      await recorder.startRecording()
      return
    }
    const rec = recorder.stopRecording()
    if (!rec) return
    setVoiceBusy(true)
    try {
      const asr = await studyApi.transcribeAudio(childId, rec.wavBlob)
      const spoken = (asr.transcript || rec.liveTranscript).trim()
      if (!spoken) {
        setErrorMsg('未识别到清晰语音，请靠近麦克风再试一次')
        return
      }
      setInstruction(spoken)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '语音识别失败')
    } finally {
      setVoiceBusy(false)
    }
  }

  const isJobRunning =
    activeJob !== null && activeJob.status !== 'succeeded' && activeJob.status !== 'failed'

  useEffect(() => {
    if (!isJobRunning || !activeJob) return
    const timer = window.setInterval(async () => {
      try {
        const fresh = await studyApi.getJobStatus(activeJob.id)
        setActiveJob(fresh)
        if (fresh.status === 'succeeded' && fresh.taskId) {
          const detail = await studyApi.getDictionaryLookup(fresh.taskId)
          setCurrentLookup(detail)
          setViewTab('result')
          pixelAudio.playChime('fanfare', soundEnabled)
          void loadHistory()
        } else if (fresh.status === 'failed') {
          setErrorMsg(fresh.errorDetail ?? '查字典解析未完成，请重试')
        }
      } catch {
        void 0
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [activeJob, isJobRunning, loadHistory, soundEnabled])

  const handleSubmitLookup = async () => {
    const base = baseImageCanvasRef.current
    if (!hasPhoto || !base || isJobRunning) return

    draftBoxRef.current = null
    const exportCanvas = document.createElement('canvas')
    const regions = compositePixelBakedDictionaryCanvas(
      exportCanvas,
      base,
      actionsRef.current,
      null,
    )
    redrawVisibleCanvas()

    if (regions.length === 0) {
      setErrorMsg('还没有标记要查的字词哦！请用「⬜ 画框」圈住或用「🖍️ 涂色」涂在目标字词上')
      return
    }

    setErrorMsg(null)
    try {
      const [rawPhotoBlob, annotatedPhotoBlob] = await Promise.all([
        canvasToJpegBlob(base, 0.88),
        canvasToJpegBlob(exportCanvas, 0.88),
      ])

      const job = await studyApi.submitDictionaryLookup(childId, {
        rawPhotoBlob,
        annotatedPhotoBlob,
        regions1000: regions.map((r) => r.box1000),
        instruction: instruction.trim(),
      })
      setActiveJob(job)
      pixelAudio.playChime('sparkle', soundEnabled)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '提交查词失败')
    }
  }

  const playWordOnly = async (word: string, prebuiltUrl: string | null, keyId: string) => {
    const cleanWord = word.trim()
    if (!cleanWord) return
    stopWordAudio()
    setPlayingAudioKey(keyId)
    try {
      let targetUrl = prebuiltUrl
      if (!targetUrl) {
        const res = await studyApi.pronounceDictionaryWord(cleanWord)
        targetUrl = res.audioUrl
      }
      const audio = new Audio(targetUrl)
      activeAudioRef.current = audio
      audio.onended = () => setPlayingAudioKey(null)
      audio.onerror = () => setPlayingAudioKey(null)
      await audio.play()
    } catch {
      setPlayingAudioKey(null)
    }
  }

  const renderEntryCard = (entry: DictionaryEntry, idx: number) => {
    if (entry.unrecognized) {
      return (
        <div
          key={entry.entryId}
          className="pixel-card bg-[#FFF8EB] border-3 border-[#B56B00] p-4 flex items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3.5">
            {entry.cropImageUrl && (
              <img
                src={entry.cropImageUrl}
                alt={`涂抹区域${entry.regionIndex}`}
                className="w-24 h-20 object-contain bg-white border-2 border-[#4A2B44] rounded p-1 shrink-0"
              />
            )}
            <div>
              <div className="inline-block bg-[#FFE484] border-2 border-[#4A2B44] rounded px-2.5 py-0.5 text-[13px] font-extrabold text-[#332230] mb-1">
                标记处 #{entry.regionIndex} · 无法辨认
              </div>
              <div className="text-[19px] font-extrabold text-[#7A4B00]">
                🤔 {entry.unrecognizedReason || '这处标记实在猜不出是什么字词哦'}
              </div>
            </div>
          </div>
          {hasPhoto && (
            <button
              type="button"
              onClick={() => setViewTab('paint')}
              className="pixel-btn bg-[#FFFDF9] px-4 py-2 text-[15px] font-extrabold shrink-0"
            >
              ⬜ 返回重标
            </button>
          )}
        </div>
      )
    }

    const zhKey = `${entry.entryId}-zh`
    const enKey = `${entry.entryId}-en`

    return (
      <div key={entry.entryId} className="pixel-card bg-[#FFFDF9] p-5 space-y-4">
        {entry.guessedCorrection && (
          <div className="bg-[#F6EEFF] border-2 border-[#7C3AED] rounded px-3.5 py-2 text-[15px] font-bold text-[#4C1D95] flex items-center gap-2">
            <span>💡</span>
            <span>
              猜你想查：<b>「{entry.headword}」</b>
              {entry.guessExplanation ? `（${entry.guessExplanation}）` : ''}
            </span>
          </div>
        )}

        <div className="flex items-start justify-between gap-4 pb-3.5 border-b-2 border-[#EAD6E2]">
          <div className="flex flex-wrap items-stretch gap-3.5 flex-1">
            <div className="bg-[#FFF0F6] border-2 border-[#4A2B44] rounded-md px-4 py-2.5 flex items-center gap-3">
              <div>
                <div className="text-[12px] font-bold text-[#8E3B63]">
                  中文词条 #{idx + 1}
                </div>
                <div className="text-[28px] font-extrabold text-[#332230] leading-tight">
                  {entry.chineseWord || entry.headword}
                </div>
                {entry.pinyin && (
                  <div className="text-[16px] font-bold text-[#C92A6A] font-num mt-0.5">
                    [ {entry.pinyin} ]
                  </div>
                )}
              </div>
              {entry.chineseWord && (
                <button
                  type="button"
                  onClick={() =>
                    void playWordOnly(entry.chineseWord, entry.chineseAudioUrl, zhKey)
                  }
                  className={`pixel-btn px-3 py-2 text-[14px] font-extrabold shrink-0 ${
                    playingAudioKey === zhKey ? 'bg-[#EC5F9B] text-white' : 'bg-[#FFE484]'
                  }`}
                >
                  {playingAudioKey === zhKey ? '🔊 朗读中' : '🔊 读词'}
                </button>
              )}
            </div>

            {entry.englishWord && (
              <div className="bg-[#EEF7FF] border-2 border-[#4A2B44] rounded-md px-4 py-2.5 flex items-center gap-3">
                <div>
                  <div className="text-[12px] font-bold text-[#1E4E8C]">英文对照 · 音标</div>
                  <div className="text-[26px] font-extrabold text-[#1A365D] leading-tight font-num">
                    {entry.englishWord}
                  </div>
                  {entry.ipa && (
                    <div className="text-[16px] font-bold text-[#2563EB] font-num mt-0.5">
                      {entry.ipa}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void playWordOnly(entry.englishWord, entry.englishAudioUrl, enKey)
                  }
                  className={`pixel-btn px-3.5 py-2 text-[14px] font-extrabold shrink-0 ${
                    playingAudioKey === enKey ? 'bg-[#2563EB] text-white' : 'bg-[#FFE484]'
                  }`}
                >
                  {playingAudioKey === enKey ? '🔊 朗读中' : '🔊 读英文'}
                </button>
              </div>
            )}
          </div>

          {entry.cropImageUrl && (
            <div className="text-center shrink-0">
              <img
                src={entry.cropImageUrl}
                alt={entry.headword}
                className="h-[68px] max-w-[140px] object-contain bg-[#FAF4EC] border-2 border-[#4A2B44] rounded p-1"
              />
              <div className="text-[11px] font-bold text-[#5C4056] mt-0.5">
                涂抹原图 #{entry.regionIndex}
              </div>
            </div>
          )}
        </div>

        {entry.charStrokes.length > 0 && (
          <div className="bg-[#FAF4EC] border-2 border-[#4A2B44] rounded p-3 space-y-2">
            <div className="text-[15px] font-extrabold text-[#332230]">
              ✍️ 汉字笔画与笔顺
            </div>
            <div className="grid grid-cols-1 gap-2">
              {entry.charStrokes.map((st, sIdx) => (
                <div
                  key={`${st.char}-${sIdx}`}
                  className="bg-white border border-[#DFC1D4] rounded px-3 py-2 flex items-center gap-3.5"
                >
                  <div className="w-11 h-11 bg-[#FFF0F6] border-2 border-[#4A2B44] rounded flex items-center justify-center text-[24px] font-extrabold text-[#332230] shrink-0">
                    {st.char}
                  </div>
                  <div className="text-[15px] leading-relaxed flex-1">
                    <div className="flex flex-wrap items-center gap-3 font-bold text-[#332230]">
                      <span className="bg-[#FFE484] border border-[#4A2B44] px-2 py-0.2 rounded text-[13px]">
                        部首：{st.radical}
                      </span>
                      <span className="bg-[#E3F2FF] border border-[#4A2B44] px-2 py-0.2 rounded text-[13px] font-num">
                        共 {st.totalStrokes} 画
                      </span>
                    </div>
                    {st.strokeOrder && (
                      <div className="text-[14px] text-[#5C4056] font-medium mt-1">
                        <b>笔顺：</b>
                        {st.strokeOrder}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {entry.senses.length > 0 && (
          <div className="space-y-2">
            <div className="text-[15px] font-extrabold text-[#332230]">
              📖 字典分项释义（中英双解）
            </div>
            <div className="space-y-2">
              {entry.senses.map((sn) => (
                <div
                  key={sn.index}
                  className="bg-[#FAF4EC] border-2 border-[#4A2B44]/80 rounded p-3 flex items-start gap-3"
                >
                  <span className="w-7 h-7 bg-[#EC5F9B] text-white border-2 border-[#4A2B44] rounded flex items-center justify-center font-num font-extrabold text-[15px] shrink-0 mt-0.5">
                    {sn.index}
                  </span>
                  <div className="space-y-1 flex-1 text-[16px]">
                    <div className="font-bold text-[#332230] flex flex-wrap items-center gap-2">
                      {sn.pos && (
                        <span className="text-[13px] bg-white border border-[#4A2B44] px-2 py-0.2 rounded font-num text-[#5E3F8A]">
                          {sn.pos}
                        </span>
                      )}
                      <span>{sn.zhMeaning}</span>
                    </div>
                    {sn.enMeaning && (
                      <div className="text-[15px] font-semibold text-[#1E4E8C]">
                        EN: {sn.enMeaning}
                      </div>
                    )}
                    {sn.example && (
                      <div className="text-[14px] text-[#5C4056] bg-white/80 rounded px-2.5 py-1 border border-[#EAD6E2]">
                        例：{sn.example}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="bg-[#ECFDF3] border-2 border-[#4A2B44] rounded p-3">
            <div className="text-[14px] font-extrabold text-[#104530] mb-1.5">
              🟢 同义词 / 近义词
            </div>
            {entry.synonyms.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {entry.synonyms.map((w, i) => (
                  <span
                    key={i}
                    className="bg-white border border-[#1E7A55] rounded px-2.5 py-0.5 text-[15px] font-bold text-[#104530]"
                  >
                    {w}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[14px] text-[#5C4056] font-medium">暂无常用同义词</span>
            )}
          </div>

          <div className="bg-[#FFF4ED] border-2 border-[#4A2B44] rounded p-3">
            <div className="text-[14px] font-extrabold text-[#7C2D12] mb-1.5">
              🟠 反义词
            </div>
            {entry.antonyms.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {entry.antonyms.map((w, i) => (
                  <span
                    key={i}
                    className="bg-white border border-[#C2410C] rounded px-2.5 py-0.5 text-[15px] font-bold text-[#7C2D12]"
                  >
                    {w}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[14px] text-[#5C4056] font-medium">暂无固定反义词</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-40 bg-[#2A1829]/70 p-4 flex items-center justify-center">
      <div className="pixel-card-pink w-full h-full p-5 flex flex-col justify-between relative">
        {preparingPhoto && (
          <div className="absolute inset-0 z-50 bg-[#2A1829]/75 flex items-center justify-center p-8">
            <div className="pixel-card-butter px-10 py-7 text-center space-y-2">
              <div className="text-4xl animate-bounce">📷✨</div>
              <div className="text-[22px] font-extrabold text-[#332230]">
                正在载入照片，请稍候...
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pb-3 border-b-3 border-[#4A2B44] shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-[26px]">📖</span>
            <div>
              <h2 className="text-[22px] font-extrabold text-[#332230]">
                星莓中英双解字典 — {girlName}
              </h2>
              <p className="text-[14px] font-semibold text-[#5C4056]">
                支持「⬜ 画框」精准圈词或「🖍️ 涂色」荧光标记，直接写入图像像素交由多模态解析
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setViewTab('paint')}
              className={`pixel-btn px-3.5 py-1.5 text-[15px] font-extrabold ${
                viewTab === 'paint' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              ⬜ 画框/涂色
            </button>
            <button
              type="button"
              onClick={() => setViewTab('result')}
              className={`pixel-btn px-3.5 py-1.5 text-[15px] font-extrabold ${
                viewTab === 'result' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              📚 字典卡 ({currentLookup?.entries.length ?? 0})
            </button>
            <button
              type="button"
              onClick={() => {
                setViewTab('history')
                void loadHistory()
              }}
              className={`pixel-btn px-3.5 py-1.5 text-[15px] font-extrabold ${
                viewTab === 'history' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              📒 查词本 ({historyList.length})
            </button>
            <button
              type="button"
              onClick={() => {
                stopWordAudio()
                onClose()
              }}
              className="pixel-btn bg-[#FFFDF9] px-4 py-1.5 text-[16px] font-extrabold text-[#332230]"
            >
              ✕ 关闭
            </button>
          </div>
        </div>

        {isJobRunning && (
          <div className="mt-3 bg-[#FFF5C2] border-3 border-[#4A2B44] rounded-md px-4 py-2.5 flex items-center gap-3 shrink-0">
            <StellaTeacherSprite talking size={40} />
            <div className="flex-1">
              <div className="text-[16px] font-extrabold text-[#332230]">
                🔍 {activeJob?.progressText}
              </div>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="mt-2.5 bg-[#FFE8F0] border-2 border-[#C92A6A] rounded px-3.5 py-2 text-[14px] font-bold text-[#7A1C3E] shrink-0">
            ⚠️ {errorMsg}
          </div>
        )}

        {viewTab === 'paint' && (
          <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 pt-3.5">
            <div className="col-span-8 pixel-card p-3.5 flex flex-col justify-between min-h-0">
              <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#EAD6E2] shrink-0 flex-wrap">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <label className="pixel-btn bg-[#EC5F9B] text-white px-3 py-1.5 text-[14px] font-extrabold cursor-pointer">
                    <span>📷 拍照</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      disabled={isJobRunning}
                      onChange={handlePhotoSelected}
                      className="hidden"
                    />
                  </label>
                  <label className="pixel-btn bg-[#FFFDF9] text-[#332230] px-3 py-1.5 text-[14px] font-extrabold cursor-pointer">
                    <span>🖼️ 选图</span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={isJobRunning}
                      onChange={handlePhotoSelected}
                      className="hidden"
                    />
                  </label>
                  {hasPhoto && (
                    <button
                      type="button"
                      disabled={isJobRunning}
                      onClick={handleRotatePhoto}
                      className="pixel-btn bg-[#FFFDF9] px-2.5 py-1.5 text-[13px] font-extrabold text-[#332230]"
                    >
                      ↻ 旋转90°
                    </button>
                  )}
                </div>

                {hasPhoto && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setTool('box')}
                      className={`pixel-btn px-3 py-1.5 text-[14px] font-extrabold ${
                        tool === 'box' ? 'bg-[#E11D48] text-white' : 'bg-[#FFFDF9]'
                      }`}
                    >
                      ⬜ 画框
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool('brush')}
                      className={`pixel-btn px-3 py-1.5 text-[14px] font-extrabold ${
                        tool === 'brush' ? 'bg-[#FFE484] text-[#332230]' : 'bg-[#FFFDF9]'
                      }`}
                    >
                      🖍️ 涂色
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool('eraser')}
                      className={`pixel-btn px-2.5 py-1.5 text-[14px] font-extrabold ${
                        tool === 'eraser' ? 'bg-[#2563EB] text-white' : 'bg-[#FFFDF9]'
                      }`}
                    >
                      🧽 橡皮
                    </button>
                    <button
                      type="button"
                      disabled={actionCount === 0 || isJobRunning}
                      onClick={handleUndo}
                      className="pixel-btn bg-[#FFFDF9] px-2.5 py-1.5 text-[13px] font-bold text-[#332230]"
                    >
                      ↩️ 撤销
                    </button>
                    <button
                      type="button"
                      disabled={actionCount === 0 || isJobRunning}
                      onClick={handleClearMask}
                      className="pixel-btn bg-[#FFFDF9] px-2.5 py-1.5 text-[13px] font-bold text-[#8E3B63]"
                    >
                      🗑️ 清空
                    </button>
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 bg-[#FAF4EC] border-2 border-[#4A2B44] rounded my-2.5 flex items-center justify-center overflow-hidden p-2">
                {!hasPhoto ? (
                  <div className="text-center space-y-4 p-6">
                    <div className="text-5xl">📷📖</div>
                    <div className="text-[21px] font-extrabold text-[#332230]">
                      拍下课本或绘本页面，画框或涂色就能精准查字词！
                    </div>
                    <div className="flex items-center justify-center gap-4 pt-1">
                      <label className="pixel-btn bg-[#EC5F9B] text-white px-6 py-3 text-[18px] font-extrabold cursor-pointer">
                        <span>📷 直接拍照查词</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={handlePhotoSelected}
                          className="hidden"
                        />
                      </label>
                      <label className="pixel-btn bg-[#FFE484] text-[#332230] px-6 py-3 text-[18px] font-extrabold cursor-pointer">
                        <span>🖼️ 从相册选照片</span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handlePhotoSelected}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>
                ) : (
                  <canvas
                    ref={visibleCanvasRef}
                    width={imgSize.w}
                    height={imgSize.h}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    className="block max-w-full max-h-[455px] w-auto h-auto touch-none select-none cursor-crosshair rounded shadow-sm"
                  />
                )}
              </div>

              <div className="flex items-center justify-between gap-2 shrink-0 flex-wrap">
                {tool === 'box' ? (
                  <div className="text-[13px] font-extrabold text-[#9F1239] bg-[#FFF0F3] border border-[#E11D48] rounded px-3 py-1">
                    ⬜ 推荐精准模式：按住拖动红框圈住单词、词语或整句话（零偏移写入图像像素）
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-extrabold text-[#332230]">
                      {tool === 'eraser' ? '橡皮大小：' : '荧光笔粗细：'}
                    </span>
                    {BRUSH_PRESETS.map((bp, idx) => (
                      <button
                        key={bp.id}
                        type="button"
                        onClick={() => setBrushIdx(idx)}
                        className={`pixel-btn px-3 py-1 text-[13px] font-extrabold inline-flex items-center gap-1.5 ${
                          brushIdx === idx ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
                        }`}
                      >
                        <span
                          className="inline-block rounded-full border border-[#4A2B44]"
                          style={{
                            width: `${bp.dotPx}px`,
                            height: `${bp.dotPx}px`,
                            backgroundColor: tool === 'eraser' ? '#FFFFFF' : '#FFE600',
                          }}
                        />
                        <span>{bp.label}</span>
                      </button>
                    ))}
                  </div>
                )}

                <span className="text-[13px] font-bold text-[#5C4056]">
                  {regionCount > 0
                    ? `✅ 已精准标记 ${regionCount} 处目标（可继续画框或涂色）`
                    : '拖动红框或涂抹荧光笔框定要查的内容'}
                </span>
              </div>
            </div>

            <div className="col-span-4 flex flex-col justify-between gap-3 min-h-0">
              <div className="pixel-card p-4 flex-1 min-h-0 flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="font-extrabold text-[18px] text-[#332230]">
                    💬 查词指令（可选）
                  </div>
                  <p className="text-[14px] font-semibold text-[#5C4056] leading-relaxed">
                    默认自动识别画框/涂色的字词或句子并生成双解卡片；也可补充要求：
                  </p>

                  <textarea
                    rows={3}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="例如：帮我查框出来的单词，或者翻译框出来的整句话（不填也可直接查）"
                    className="w-full bg-[#FAF4EC] border-2 border-[#4A2B44] rounded p-2.5 text-[15px] font-medium text-[#332230] resize-none focus:outline-none"
                  />

                  <button
                    type="button"
                    disabled={voiceBusy || isJobRunning}
                    onClick={() => void handleVoiceInstruction()}
                    className={`pixel-btn w-full py-2.5 px-3 text-[15px] font-extrabold flex items-center justify-center gap-2 ${
                      recorder.isRecording
                        ? 'bg-[#E11D74] text-white animate-pulse'
                        : 'bg-[#FFFDF9] text-[#332230]'
                    }`}
                  >
                    <span>{recorder.isRecording ? '⏹️' : '🎤'}</span>
                    <span>
                      {voiceBusy
                        ? '⏳ 正在转写语音...'
                        : recorder.isRecording
                          ? `录音中 (${recorder.durationSec}秒)... 再点完成`
                          : '用语音说出查词要求'}
                    </span>
                  </button>
                </div>

                <div className="bg-[#F6F2FC] border-2 border-[#4A2B44] rounded p-3 text-[13px] font-semibold text-[#4A3346] space-y-1">
                  <div>📌 「⬜ 画框」适合密集排版精准圈词或圈整句</div>
                  <div>📌 「🖍️ 涂色」适合快速涂抹生字词，可混合多处</div>
                  <div>📌 点词条旁「🔊」按需标准朗读被查词本身</div>
                </div>
              </div>

              <button
                type="button"
                disabled={!hasPhoto || regionCount === 0 || isJobRunning}
                onClick={() => void handleSubmitLookup()}
                className="pixel-btn w-full bg-[#52CE9B] text-[#104530] py-3.5 px-5 text-[20px] font-extrabold h-[62px] shrink-0"
              >
                {isJobRunning
                  ? '⏳ 正在解析标记图像...'
                  : `🔍 查已标记的 ${regionCount > 0 ? `${regionCount} 处` : '字词'}`}
              </button>
            </div>
          </div>
        )}

        {viewTab === 'result' && (
          <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pt-3.5 pr-2 space-y-4">
            {!currentLookup ? (
              <div className="pixel-card p-10 text-center space-y-3">
                <div className="text-4xl">📖✨</div>
                <div className="text-[20px] font-extrabold text-[#332230]">
                  拍张照片并用画笔涂出想查的字词，这里就会展示详细字典卡啦！
                </div>
                <button
                  type="button"
                  onClick={() => setViewTab('paint')}
                  className="pixel-btn bg-[#FFE484] px-6 py-2.5 text-[17px] font-extrabold"
                >
                  🖌️ 去拍照涂字
                </button>
              </div>
            ) : (
              <>
                <div className="pixel-card bg-[#FFFDF9] p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <img
                      src={currentLookup.previewImageUrl}
                      alt="涂抹预览"
                      className="w-20 h-14 object-cover rounded border-2 border-[#4A2B44]"
                    />
                    <div>
                      <div className="text-[16px] font-extrabold text-[#332230]">
                        本次共解析 {currentLookup.entries.length} 处涂抹词条
                      </div>
                      <div className="text-[13px] font-semibold text-[#5C4056]">
                        点击词条旁「🔊 读词 / 读英文」仅标准朗读被查词本身
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setViewTab('paint')}
                    className="pixel-btn bg-[#FFE484] px-4 py-2 text-[15px] font-extrabold shrink-0"
                  >
                    🖌️ 继续涂改或新拍一张
                  </button>
                </div>

                {currentLookup.entries.map((entry, idx) => renderEntryCard(entry, idx))}
              </>
            )}
          </div>
        )}

        {viewTab === 'history' && (
          <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pt-3.5 pr-2 space-y-3">
            {loadingHistory ? (
              <div className="pixel-card p-10 text-center text-[17px] font-bold text-[#5C4056]">
                正在加载查词历史...
              </div>
            ) : historyList.length === 0 ? (
              <div className="pixel-card p-10 text-center text-[18px] font-bold text-[#5C4056]">
                还没有查词记录哦，快去拍张照片试试吧！
              </div>
            ) : (
              historyList.map((item) => {
                const validWords = item.entries
                  .filter((e) => !e.unrecognized && e.headword)
                  .map((e) => e.headword)
                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      setCurrentLookup(item)
                      setViewTab('result')
                    }}
                    className="pixel-card bg-[#FFFDF9] p-3.5 flex items-center justify-between gap-4 cursor-pointer hover:brightness-98"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <img
                        src={item.previewImageUrl}
                        alt="历史涂抹"
                        className="w-20 h-14 object-cover rounded border-2 border-[#4A2B44] shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {validWords.length > 0 ? (
                            validWords.map((w, i) => (
                              <span
                                key={i}
                                className="bg-[#FFF0F6] border-2 border-[#4A2B44] rounded px-2.5 py-0.5 text-[16px] font-extrabold text-[#332230]"
                              >
                                {w}
                              </span>
                            ))
                          ) : (
                            <span className="text-[15px] font-bold text-[#7A4B00]">
                              未识别涂抹记录
                            </span>
                          )}
                        </div>
                        <div className="text-[13px] font-semibold text-[#5C4056] font-num mt-1">
                          {item.createdAt.slice(0, 16).replace('T', ' ')}
                        </div>
                      </div>
                    </div>
                    <span className="pixel-btn bg-[#FFE484] px-4 py-1.5 text-[14px] font-extrabold shrink-0">
                      查看字典卡 ▶
                    </span>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}
