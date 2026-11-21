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
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [brushIdx, setBrushIdx] = useState<number>(1)

  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [hasMaskPixels, setHasMaskPixels] = useState(false)

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
  const maskBufferRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
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
      if (photoUrl) {
        URL.revokeObjectURL(photoUrl)
      }
    }
  }, [photoUrl, stopWordAudio])

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

  const syncVisibleCanvasFromBuffer = useCallback(() => {
    const vis = visibleCanvasRef.current
    const buf = maskBufferRef.current
    if (!vis || !buf || buf.width === 0 || buf.height === 0) return
    if (vis.width !== buf.width || vis.height !== buf.height) {
      vis.width = buf.width
      vis.height = buf.height
    }
    const ctx = vis.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, vis.width, vis.height)
    ctx.drawImage(buf, 0, 0)
  }, [])

  useEffect(() => {
    if (viewTab === 'paint' && imgSize.w > 0) {
      syncVisibleCanvasFromBuffer()
    }
  }, [viewTab, imgSize.w, imgSize.h, syncVisibleCanvasFromBuffer])

  const checkBufferHasInk = (): boolean => {
    const buf = maskBufferRef.current
    if (!buf || buf.width === 0 || buf.height === 0) return false
    const sample = document.createElement('canvas')
    sample.width = 96
    sample.height = Math.max(1, Math.round((96 * buf.height) / buf.width))
    const sctx = sample.getContext('2d')
    if (!sctx) return false
    sctx.drawImage(buf, 0, 0, sample.width, sample.height)
    const data = sctx.getImageData(0, 0, sample.width, sample.height).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 24) return true
    }
    return false
  }

  const handlePhotoSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.files?.[0]
    e.target.value = ''
    if (!raw) return

    setErrorMsg(null)
    setPreparingPhoto(true)
    try {
      const compressed = await compressImageForModel(raw, 1600, 0.88)
      const nextUrl = URL.createObjectURL(compressed)
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const probe = new Image()
        probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight })
        probe.onerror = () => reject(new Error('无法读取照片尺寸'))
        probe.src = nextUrl
      })

      const off = document.createElement('canvas')
      off.width = dims.w
      off.height = dims.h
      maskBufferRef.current = off

      setPhotoFile(compressed)
      setPhotoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return nextUrl
      })
      setImgSize(dims)
      setHasMaskPixels(false)
      setTool('brush')
      setViewTab('paint')
      pixelAudio.playChime('sparkle', soundEnabled)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取照片失败，请重试')
    } finally {
      setPreparingPhoto(false)
    }
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
    const x = ((e.clientX - rect.left) / rect.width) * vis.width
    const y = ((e.clientY - rect.top) / rect.height) * vis.height
    return { x, y }
  }

  const paintSegment = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const buf = maskBufferRef.current
    if (!buf) return
    const bctx = buf.getContext('2d')
    if (!bctx) return

    const strokeW = getScaledStrokeWidth()
    bctx.save()
    bctx.lineCap = 'round'
    bctx.lineJoin = 'round'
    bctx.lineWidth = strokeW
    if (tool === 'eraser') {
      bctx.globalCompositeOperation = 'destination-out'
      bctx.strokeStyle = 'rgba(0,0,0,1)'
      bctx.fillStyle = 'rgba(0,0,0,1)'
    } else {
      bctx.globalCompositeOperation = 'source-over'
      bctx.strokeStyle = '#FF3D8B'
      bctx.fillStyle = '#FF3D8B'
    }

    bctx.beginPath()
    bctx.moveTo(from.x, from.y)
    bctx.lineTo(to.x, to.y)
    bctx.stroke()

    if (from.x === to.x && from.y === to.y) {
      bctx.beginPath()
      bctx.arc(from.x, from.y, strokeW / 2, 0, Math.PI * 2)
      bctx.fill()
    }
    bctx.restore()

    syncVisibleCanvasFromBuffer()
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!photoUrl || isJobRunning) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = pointerToCanvasCoords(e)
    if (!pt) return
    drawingRef.current = true
    lastPointRef.current = pt
    paintSegment(pt, pt)
    if (tool === 'brush') {
      setHasMaskPixels(true)
    }
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !lastPointRef.current) return
    const pt = pointerToCanvasCoords(e)
    if (!pt) return
    paintSegment(lastPointRef.current, pt)
    lastPointRef.current = pt
  }

  const handlePointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    lastPointRef.current = null
    setHasMaskPixels(checkBufferHasInk())
  }

  const handleClearMask = () => {
    const buf = maskBufferRef.current
    if (buf) {
      const ctx = buf.getContext('2d')
      ctx?.clearRect(0, 0, buf.width, buf.height)
    }
    syncVisibleCanvasFromBuffer()
    setHasMaskPixels(false)
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
    if (!photoFile || !maskBufferRef.current || isJobRunning) return
    if (!checkBufferHasInk()) {
      setErrorMsg('还没有涂抹要查的字词哦！请先选画笔在照片文字上涂一下')
      return
    }
    setErrorMsg(null)
    try {
      const exportCanvas = document.createElement('canvas')
      const maxMaskEdge = 900
      const longest = Math.max(maskBufferRef.current.width, maskBufferRef.current.height)
      const ratio = longest > maxMaskEdge ? maxMaskEdge / longest : 1
      exportCanvas.width = Math.max(1, Math.round(maskBufferRef.current.width * ratio))
      exportCanvas.height = Math.max(1, Math.round(maskBufferRef.current.height * ratio))
      const ectx = exportCanvas.getContext('2d')
      ectx?.drawImage(maskBufferRef.current, 0, 0, exportCanvas.width, exportCanvas.height)

      const maskBlob = await new Promise<Blob | null>((resolve) =>
        exportCanvas.toBlob((b) => resolve(b), 'image/png'),
      )
      if (!maskBlob) {
        setErrorMsg('生成涂抹蒙版失败，请重试')
        return
      }

      const job = await studyApi.submitDictionaryLookup(
        childId,
        photoFile,
        maskBlob,
        instruction.trim(),
      )
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
                涂抹处 #{entry.regionIndex} · 无法辨认
              </div>
              <div className="text-[19px] font-extrabold text-[#7A4B00]">
                🤔 {entry.unrecognizedReason || '这处涂抹实在猜不出是什么字词哦'}
              </div>
            </div>
          </div>
          {photoUrl && (
            <button
              type="button"
              onClick={() => setViewTab('paint')}
              className="pixel-btn bg-[#FFFDF9] px-4 py-2 text-[15px] font-extrabold shrink-0"
            >
              🖌️ 返回擦掉重涂
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
                拍照后用荧光画笔涂出要查的字词（可一次涂多处），点喇叭只读被查词本身
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
              🖌️ 拍照涂字
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
                <div className="flex items-center gap-2">
                  <label className="pixel-btn bg-[#EC5F9B] text-white px-3.5 py-1.5 text-[15px] font-extrabold cursor-pointer">
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
                  <label className="pixel-btn bg-[#FFFDF9] text-[#332230] px-3.5 py-1.5 text-[15px] font-extrabold cursor-pointer">
                    <span>🖼️ 从相册选图</span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={isJobRunning}
                      onChange={handlePhotoSelected}
                      className="hidden"
                    />
                  </label>
                </div>

                {photoUrl && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setTool('brush')}
                      className={`pixel-btn px-3 py-1.5 text-[14px] font-extrabold ${
                        tool === 'brush' ? 'bg-[#EC5F9B] text-white' : 'bg-[#FFFDF9]'
                      }`}
                    >
                      🖌️ 画笔涂字
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool('eraser')}
                      className={`pixel-btn px-3 py-1.5 text-[14px] font-extrabold ${
                        tool === 'eraser' ? 'bg-[#2563EB] text-white' : 'bg-[#FFFDF9]'
                      }`}
                    >
                      🧽 橡皮擦
                    </button>
                    <button
                      type="button"
                      onClick={handleClearMask}
                      className="pixel-btn bg-[#FFFDF9] px-3 py-1.5 text-[14px] font-bold text-[#8E3B63]"
                    >
                      🗑️ 清空重涂
                    </button>
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 bg-[#FAF4EC] border-2 border-[#4A2B44] rounded my-2.5 flex items-center justify-center overflow-hidden p-2">
                {!photoUrl ? (
                  <div className="text-center space-y-4 p-6">
                    <div className="text-5xl">📷📖</div>
                    <div className="text-[21px] font-extrabold text-[#332230]">
                      拍下课本或绘本页面，手指一涂就能查字词！
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
                  <div className="relative inline-flex items-center justify-center max-w-full max-h-full">
                    <img
                      src={photoUrl}
                      alt="待查词原图"
                      draggable={false}
                      className="block max-w-full max-h-[455px] w-auto h-auto object-contain select-none pointer-events-none rounded"
                    />
                    <canvas
                      ref={visibleCanvasRef}
                      width={imgSize.w}
                      height={imgSize.h}
                      onPointerDown={handlePointerDown}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={handlePointerUp}
                      className="absolute inset-0 w-full h-full touch-none opacity-45 cursor-crosshair rounded"
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-extrabold text-[#332230]">
                    {tool === 'eraser' ? '橡皮大小：' : '画笔粗细：'}
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
                          backgroundColor: tool === 'eraser' ? '#FFFFFF' : '#FF3D8B',
                        }}
                      />
                      <span>{bp.label}</span>
                    </button>
                  ))}
                </div>

                <span className="text-[13px] font-bold text-[#5C4056]">
                  {hasMaskPixels ? '✅ 已涂抹待查字词（可涂多处）' : '在文字上涂抹即可框定生字词'}
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
                    默认自动识别涂抹的所有中英字词并生成完整字典卡；你也可以补充说明：
                  </p>

                  <textarea
                    rows={3}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="例如：帮我查涂出来的字词，顺便看看在句子里是什么意思（不填也可以直接查）"
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
                  <div>📌 支持一次涂多个中文字、词语或英文单词</div>
                  <div>📌 中文带笔画笔顺、拼音、分项字义、同反义词</div>
                  <div>📌 英文带音标与双解，点喇叭只读词本身</div>
                </div>
              </div>

              <button
                type="button"
                disabled={!photoFile || !hasMaskPixels || isJobRunning}
                onClick={() => void handleSubmitLookup()}
                className="pixel-btn w-full bg-[#52CE9B] text-[#104530] py-3.5 px-5 text-[20px] font-extrabold h-[62px] shrink-0"
              >
                {isJobRunning ? '⏳ 正在查字典...' : '🔍 开始查涂抹的字词'}
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
