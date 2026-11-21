import { useEffect, useRef, useState } from 'react'
import { GirlAvatarSprite, StellaTeacherSprite } from '../components/PixelSprites'
import { studyApi } from '../services/apiClient'
import { speakStellaSentences } from '../services/pixelAudio'
import type { ChildProfile, DailyEvaluation } from '../types/study'

interface DailyReviewModalProps {
  girl: ChildProfile
  evaluation: DailyEvaluation
  onClose: () => void
  onCreateTomorrowTasksFromTips: (tips: string[]) => Promise<void>
}

export function DailyReviewModal({
  girl,
  evaluation,
  onClose,
  onCreateTomorrowTasksFromTips,
}: DailyReviewModalProps) {
  const [activeSentenceIdx, setActiveSentenceIdx] = useState<number>(-1)
  const [speechRate, setSpeechRate] = useState<number>(1.0)
  const [creatingTomorrow, setCreatingTomorrow] = useState(false)
  const [loadingTts, setLoadingTts] = useState(false)
  const [cachedEvalTtsUrl, setCachedEvalTtsUrl] = useState<string | null>(evaluation.ttsAudioUrl)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const timerIdRef = useRef<number | null>(null)
  const stopFallbackRef = useRef<(() => void) | null>(null)

  const stopAllPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (timerIdRef.current !== null) {
      window.clearInterval(timerIdRef.current)
      timerIdRef.current = null
    }
    if (stopFallbackRef.current) {
      stopFallbackRef.current()
      stopFallbackRef.current = null
    }
    setActiveSentenceIdx(-1)
  }

  useEffect(() => stopAllPlayback, [])

  const startReading = async (rate: number) => {
    stopAllPlayback()
    const sentences = evaluation.childCommentarySentences
    if (sentences.length === 0 || loadingTts) return

    try {
      setLoadingTts(true)
      const ttsUrl = await studyApi.speakOnDemand({
        text: sentences.join(' '),
        prebuiltUrl: cachedEvalTtsUrl,
      })
      setCachedEvalTtsUrl(ttsUrl)
      setLoadingTts(false)

      const audio = new Audio(ttsUrl)
      audio.playbackRate = rate
      audioRef.current = audio
      setActiveSentenceIdx(0)

      const totalChars = Math.max(1, sentences.reduce((a, s) => a + s.length, 0))
      const cumulativeRatios: number[] = []
      let running = 0
      for (const s of sentences) {
        running += s.length
        cumulativeRatios.push(running / totalChars)
      }

      timerIdRef.current = window.setInterval(() => {
        if (!audioRef.current || !audioRef.current.duration) return
        const ratio = audioRef.current.currentTime / audioRef.current.duration
        const idx = cumulativeRatios.findIndex((r) => ratio <= r)
        setActiveSentenceIdx(idx === -1 ? sentences.length - 1 : idx)
      }, 150)

      audio.onended = () => stopAllPlayback()
      audio.onerror = () => {
        stopAllPlayback()
        stopFallbackRef.current = speakStellaSentences(
          sentences,
          rate,
          (idx) => setActiveSentenceIdx(idx),
          () => setActiveSentenceIdx(-1),
        )
      }
      await audio.play()
    } catch {
      setLoadingTts(false)
      stopFallbackRef.current = speakStellaSentences(
        sentences,
        rate,
        (idx) => setActiveSentenceIdx(idx),
        () => setActiveSentenceIdx(-1),
      )
    }
  }

  const dimensions = [
    { label: '计划完成度', val: evaluation.dimensionScores.completion ?? 0, max: 30, color: '#EC5F9B' },
    { label: '专注与效率', val: evaluation.dimensionScores.focus ?? 0, max: 25, color: '#4A90E2' },
    { label: 'OCR与错题质量', val: evaluation.dimensionScores.quality ?? 0, max: 30, color: '#44B98A' },
    { label: '表达复盘习惯', val: evaluation.dimensionScores.habit ?? 0, max: 15, color: '#9B6BFF' },
  ]

  return (
    <div className="absolute inset-0 z-40 bg-[#2A1829]/65 p-5 flex items-center justify-center">
      <div className="pixel-card-butter w-full h-full p-5 flex flex-col justify-between">
        <div className="flex items-center justify-between gap-3 pb-3 border-b-3 border-[#4A2B44] shrink-0">
          <div className="flex items-center gap-3">
            <div className="border-2 border-[#4A2B44] bg-[#FFFDF9] rounded">
              <GirlAvatarSprite avatar={girl.avatarKey} size={46} />
            </div>
            <div>
              <h2 className="text-[22px] font-extrabold text-[#332230]">
                🏆 {girl.displayName}的今日学习成绩单
              </h2>
              <p className="text-[14px] font-semibold text-[#5C4056] font-num">
                评估日期：{evaluation.evalDate}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              stopAllPlayback()
              onClose()
            }}
            className="pixel-btn bg-[#FFFDF9] px-4 py-2 text-[17px] font-extrabold text-[#332230]"
          >
            ✕ 关闭成绩单
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 pt-4">
          <div className="col-span-5 flex flex-col justify-between gap-3.5 min-h-0">
            <div className="pixel-card p-5 text-center">
              <div className="inline-block bg-[#EC5F9B] text-white border-2 border-[#4A2B44] rounded px-3 py-0.5 text-[14px] font-num font-extrabold">
                RANK · {evaluation.badgeRank}
              </div>
              <div className="font-num text-[70px] font-extrabold text-[#C92A6A] leading-none my-2">
                {evaluation.totalScore}
                <span className="text-[22px] ml-1">分</span>
              </div>
              <div className="pixel-stamp inline-block px-4 py-1 text-[16px] font-extrabold">
                ★ {evaluation.badgeTitle} ★
              </div>

              <div className="mt-4 space-y-2.5 text-left">
                {dimensions.map((d) => {
                  const pct = Math.min(100, Math.round((d.val / d.max) * 100))
                  return (
                    <div key={d.label}>
                      <div className="flex justify-between text-[14px] font-bold mb-1">
                        <span className="text-[#332230]">{d.label}</span>
                        <span className="font-num text-[#5C4056]">
                          {d.val} / {d.max} 分
                        </span>
                      </div>
                      <div className="h-3.5 bg-[#FAF4EC] border-2 border-[#4A2B44] rounded p-0.5">
                        <div
                          className="h-full rounded-xs"
                          style={{ width: `${pct}%`, backgroundColor: d.color }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="pixel-card p-4 flex-1 min-h-0 flex flex-col justify-between">
              <div>
                <div className="font-extrabold text-[17px] text-[#332230] mb-1.5">
                  📋 给家长的客观学情小结
                </div>
                <p className="text-[15px] font-medium text-[#4A3346] leading-relaxed">
                  {evaluation.parentSummary}
                </p>
              </div>
              {evaluation.tomorrowTips.length > 0 && (
                <button
                  type="button"
                  disabled={creatingTomorrow}
                  onClick={async () => {
                    setCreatingTomorrow(true)
                    try {
                      await onCreateTomorrowTasksFromTips(evaluation.tomorrowTips)
                    } finally {
                      setCreatingTomorrow(false)
                    }
                  }}
                  className="pixel-btn w-full bg-[#ECFDF3] text-[#104530] py-2.5 px-3 text-[15px] font-extrabold mt-2"
                >
                  {creatingTomorrow
                    ? '⏳ 正在排入明日时间线，请稍候...'
                    : '✨ 一键排入明日时间线'}
                </button>
              )}
            </div>
          </div>

          <div className="col-span-7 flex flex-col justify-between gap-3.5 min-h-0">
            <div className="pixel-card-pink p-5 flex-1 min-h-0 flex flex-col justify-between">
              <div className="flex items-center justify-between gap-2 pb-3 border-b-2 border-[#EAD6E2] shrink-0">
                <div className="flex items-center gap-3">
                  <StellaTeacherSprite talking={activeSentenceIdx >= 0} size={46} />
                  <div>
                    <div className="font-extrabold text-[19px] text-[#332230]">
                      🌟 海星老师给{girl.displayName}的语音讲评
                    </div>
                    <div className="text-[14px] font-medium text-[#5C4056]">
                      点击右上角播放，跟着海星老师的声音与黄色高亮一起听讲评吧！
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const nextRate = speechRate === 1.0 ? 0.88 : 1.0
                      setSpeechRate(nextRate)
                      if (activeSentenceIdx >= 0) startReading(nextRate)
                    }}
                    className="pixel-btn bg-[#FFFDF9] px-3 py-2 text-[14px] font-num font-bold"
                  >
                    {speechRate === 1.0 ? '1.0x 标准' : '0.88x 慢速护耳'}
                  </button>

                  {activeSentenceIdx >= 0 ? (
                    <button
                      type="button"
                      onClick={stopAllPlayback}
                      className="pixel-btn bg-[#E11D74] text-white px-4 py-2 text-[15px] font-extrabold"
                    >
                      ⏹️ 停止播报
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startReading(speechRate)}
                      className="pixel-btn bg-[#FFE484] text-[#332230] px-5 py-2 text-[16px] font-extrabold"
                    >
                      🔊 播放讲评语音
                    </button>
                  )}
                </div>
              </div>

              <div className="eye-scroll flex-1 min-h-0 overflow-y-auto bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-4 my-3 space-y-2.5 text-[18px] leading-relaxed">
                {evaluation.childCommentarySentences.map((sentence, idx) => (
                  <p
                    key={idx}
                    onClick={() => startReading(speechRate)}
                    className={`p-2 rounded transition-colors cursor-pointer ${
                      idx === activeSentenceIdx
                        ? 'bg-[#FFE484] border-l-4 border-[#C92A6A] font-extrabold text-[#332230]'
                        : 'font-medium text-[#332230] hover:bg-[#FAF4EC]'
                    }`}
                  >
                    {sentence}
                  </p>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3 shrink-0 text-[14px]">
                <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-3">
                  <div className="font-extrabold text-[#B51D5B] mb-1">🔍 近期关注薄弱点：</div>
                  <ul className="list-disc pl-5 space-y-1 font-medium text-[#332230]">
                    {evaluation.weakPoints.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
                <div className="bg-[#ECFDF3] border-2 border-[#4A2B44] rounded p-3">
                  <div className="font-extrabold text-[#104530] mb-1">🌱 明日进步小锦囊：</div>
                  <ul className="list-disc pl-5 space-y-1 font-medium text-[#332230]">
                    {evaluation.tomorrowTips.map((tip, i) => (
                      <li key={i}>{tip}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
