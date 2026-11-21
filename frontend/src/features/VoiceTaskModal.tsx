import { useState } from 'react'
import { PixelStarBadge, StellaTeacherSprite, SubjectPixelIcon } from '../components/PixelSprites'
import { SUBJECT_CONFIG } from '../config/pixelTheme'
import { usePixelVoiceRecorder } from '../hooks/usePixelVoiceRecorder'
import { studyApi } from '../services/apiClient'
import { pixelAudio, speakStellaSentences } from '../services/pixelAudio'
import type { SubjectKey, VoiceTaskDraft } from '../types/study'

interface VoiceTaskModalProps {
  childId: string
  girlName: string
  selectedDate: string
  soundEnabled: boolean
  onClose: () => void
  onTasksCreated: (count: number) => void
}

export function VoiceTaskModal({
  childId,
  girlName,
  selectedDate,
  soundEnabled,
  onClose,
  onTasksCreated,
}: VoiceTaskModalProps) {
  const recorder = usePixelVoiceRecorder()
  const [transcript, setTranscript] = useState('')
  const [voiceMinioKey, setVoiceMinioKey] = useState<string | null>(null)
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null)
  const [stellaReply, setStellaReply] = useState(
    `${girlName}，点下方麦克风说出今天要做什么作业、大概做多久吧！`,
  )
  const [drafts, setDrafts] = useState<VoiceTaskDraft[]>([])
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [refineMode, setRefineMode] = useState(false)
  const [speakingReply, setSpeakingReply] = useState(false)

  const handlePlayReplyVoice = async () => {
    const clean = stellaReply.trim()
    if (!clean || speakingReply) return
    setSpeakingReply(true)
    try {
      const url = await studyApi.speakOnDemand({ text: clean })
      const audio = new Audio(url)
      audio.onended = () => setSpeakingReply(false)
      audio.onerror = () => setSpeakingReply(false)
      await audio.play()
    } catch {
      setSpeakingReply(false)
      speakStellaSentences([clean], 1.0, () => undefined, () => undefined)
    }
  }

  const runDshVoiceParse = async (spokenText: string) => {
    setErrorMsg(null)
    setBusyMessage('⏳ 海星老师正在整理学习任务卡片...')
    try {
      const res = await studyApi.parseVoiceTasks(childId, {
        transcript: spokenText,
        targetDate: selectedDate,
        existingDrafts: refineMode && drafts.length > 0 ? drafts : undefined,
        isRefinement: refineMode && drafts.length > 0,
      })
      setTranscript(res.transcript)
      setDrafts(res.drafts)
      setStellaReply(res.spokenReply)
      setRefineMode(false)
      pixelAudio.playChime('sparkle', soundEnabled)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '语音任务整理失败，请重试')
    } finally {
      setBusyMessage(null)
    }
  }

  const handleMicClick = async () => {
    setErrorMsg(null)
    if (!recorder.isRecording) {
      pixelAudio.playChime('tap', soundEnabled)
      await recorder.startRecording()
      return
    }

    const recorded = recorder.stopRecording()
    if (!recorded) return

    setBusyMessage('⏳ 正在识别语音内容...')
    try {
      const asrOut = await studyApi.transcribeAudio(childId, recorded.wavBlob)
      setVoiceMinioKey(asrOut.audioMinioKey)
      setRecordedAudioUrl(asrOut.audioUrl)
      const finalText = asrOut.transcript.trim() || recorded.liveTranscript.trim()
      if (!finalText) {
        setErrorMsg('未识别到清晰说话内容，请靠近麦克风再说一次哦！')
        setBusyMessage(null)
        return
      }
      await runDshVoiceParse(finalText)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '语音识别失败')
      setBusyMessage(null)
    }
  }

  const adjustDuration = (draftId: string, deltaMin: number) => {
    pixelAudio.playChime('tap', soundEnabled)
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.draftId !== draftId) return d
        const nextMin = Math.max(1, Math.min(120, d.plannedDurationMinutes + deltaMin))
        return { ...d, plannedDurationMinutes: nextMin }
      }),
    )
  }

  const toggleDraftMode = (draftId: string) => {
    pixelAudio.playChime('tap', soundEnabled)
    setDrafts((prev) =>
      prev.map((d) =>
        d.draftId === draftId
          ? { ...d, timerMode: d.timerMode === 'countdown' ? 'stopwatch' : 'countdown' }
          : d,
      ),
    )
  }

  const cycleDraftSubject = (draftId: string) => {
    const order: SubjectKey[] = ['math', 'chinese', 'english', 'reading', 'science', 'art']
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.draftId !== draftId) return d
        const idx = order.indexOf(d.subject)
        const nextSubj = order[(idx + 1) % order.length]
        return { ...d, subject: nextSubj }
      }),
    )
  }

  const handleConfirmCreate = async () => {
    if (drafts.length === 0 || busyMessage) return
    setBusyMessage('⏳ 正在将学习任务写入时间线...')
    setErrorMsg(null)
    try {
      const created = await studyApi.createTasksBatch(childId, {
        targetDate: selectedDate,
        rawTranscript: transcript,
        voiceMinioKey,
        drafts,
      })
      pixelAudio.playChime('fanfare', soundEnabled)
      onTasksCreated(created.length)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '保存任务失败')
      setBusyMessage(null)
    }
  }

  return (
    <div className="absolute inset-0 z-40 bg-[#2A1829]/65 p-5 flex items-center justify-center">
      <div className="pixel-card-pink w-full h-full p-5 flex flex-col justify-between">
        <div className="flex items-center justify-between gap-3 pb-3 border-b-3 border-[#4A2B44] shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-[26px]">🎤</span>
            <div>
              <h2 className="text-[22px] font-extrabold text-[#332230]">语音添加学习任务</h2>
              <p className="text-[15px] font-semibold text-[#5C4056]">
                日期：{selectedDate} · 开始前可自由切换倒计时或正计时
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={Boolean(busyMessage)}
            onClick={onClose}
            className="pixel-btn bg-[#FFFDF9] px-4 py-2 text-[17px] font-extrabold text-[#332230]"
          >
            ✕ 关闭窗口
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 pt-4">
          <div className="col-span-5 flex flex-col justify-between gap-3 min-h-0">
            <div className="bg-[#FFFDF9] border-3 border-[#4A2B44] rounded-md p-3.5 flex items-start gap-3">
              <StellaTeacherSprite talking={recorder.isRecording || Boolean(busyMessage) || speakingReply} size={46} />
              <div className="text-[15px] font-medium leading-relaxed text-[#332230] flex-1 space-y-1.5">
                <div>{busyMessage ?? stellaReply}</div>
                {!busyMessage && stellaReply && (
                  <button
                    type="button"
                    disabled={speakingReply}
                    onClick={() => void handlePlayReplyVoice()}
                    className="pixel-btn bg-[#FFE484] px-2.5 py-0.5 text-[12px] font-extrabold"
                  >
                    {speakingReply ? '⏳ 语音准备中...' : '🔊 点击播放语音'}
                  </button>
                )}
              </div>
            </div>

            <div className="pixel-card p-6 flex-1 flex flex-col justify-center text-center min-h-0">
              <div className="flex flex-col items-center gap-3">
                <button
                  type="button"
                  disabled={Boolean(busyMessage)}
                  onClick={handleMicClick}
                  className={`pixel-btn w-full py-4 px-5 h-[82px] text-[20px] font-extrabold flex items-center justify-center gap-3 ${
                    recorder.isRecording
                      ? 'bg-[#E11D74] text-white animate-pulse'
                      : refineMode
                        ? 'bg-[#9333EA] text-white'
                        : 'bg-[#EC5F9B] text-white'
                  }`}
                >
                  <span className="text-[26px]">{recorder.isRecording ? '⏹️' : '🎙️'}</span>
                  <span>
                    {recorder.isRecording
                      ? `正在录音 (${recorder.durationSec}秒)... 再点完成`
                      : refineMode
                        ? '点击用语音修改右边卡片'
                        : '点击开始语音说任务'}
                  </span>
                </button>

                {recorder.isRecording && (
                  <div className="mt-1 flex items-end justify-center gap-2 h-9">
                    {recorder.waveBars.map((h, i) => (
                      <div
                        key={i}
                        className="w-3.5 bg-[#EC5F9B] border border-[#4A2B44] rounded-xs"
                        style={{ height: `${Math.max(14, Math.round(h * 0.32))}px` }}
                      />
                    ))}
                  </div>
                )}

                {recordedAudioUrl && !recorder.isRecording && (
                  <div className="w-full flex items-center justify-between gap-2 text-[14px] font-bold bg-[#ECFDF3] border-2 border-[#4A2B44] px-3 py-1.5 rounded">
                    <span>🎙️ 我的录音</span>
                    <audio controls src={recordedAudioUrl} className="h-7 w-48" />
                  </div>
                )}

                {transcript && (
                  <div className="w-full bg-[#F6F2FC] border-2 border-[#4A2B44] rounded p-3 text-left text-[15px] leading-relaxed">
                    <span className="font-extrabold text-[#5E3F8A]">语音内容：</span>“{transcript}”
                  </div>
                )}
              </div>
            </div>

            {(errorMsg || recorder.recorderError) && (
              <div className="bg-[#FFE8F0] border-2 border-[#C92A6A] rounded p-2 text-[14px] font-semibold text-[#7A1C3E]">
                ⚠️ {errorMsg ?? recorder.recorderError}
              </div>
            )}
          </div>

          <div className="col-span-7 pixel-card p-4 flex flex-col justify-between min-h-0">
            <div className="flex items-center justify-between pb-2.5 border-b-2 border-[#EAD6E2] shrink-0">
              <h3 className="font-extrabold text-[19px] text-[#332230]">
                ✨ 待添加任务卡片（{drafts.length} 项）
              </h3>
              {drafts.length > 0 && (
                <button
                  type="button"
                  disabled={Boolean(busyMessage)}
                  onClick={() => setRefineMode((v) => !v)}
                  className={`pixel-btn px-3.5 py-1.5 text-[14px] font-bold ${
                    refineMode ? 'bg-[#9333EA] text-white' : 'bg-[#F6F2FC] text-[#5E3F8A]'
                  }`}
                >
                  🪄 {refineMode ? '取消语音修改' : '用语音改一改'}
                </button>
              )}
            </div>

            <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pr-2 py-3 space-y-3">
              {busyMessage ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6">
                  <div className="text-4xl mb-3 animate-bounce">🌟</div>
                  <div className="text-[19px] font-extrabold text-[#332230]">{busyMessage}</div>
                </div>
              ) : drafts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[#5C4056]">
                  <div className="text-4xl mb-2">🪄</div>
                  <div className="text-[20px] font-extrabold text-[#332230]">
                    点击左侧麦克风说出学习安排
                  </div>
                </div>
              ) : (
                drafts.map((draft) => {
                  const subj = SUBJECT_CONFIG[draft.subject] ?? SUBJECT_CONFIG.chinese
                  return (
                    <div
                      key={draft.draftId}
                      className="border-3 border-[#4A2B44] rounded-md p-3.5 shadow-[3px_3px_0_rgba(74,43,68,0.16)]"
                      style={{ backgroundColor: subj.bgHex }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => cycleDraftSubject(draft.draftId)}
                            className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-1.5 cursor-pointer"
                            title="点击切换学科图标"
                          >
                            <SubjectPixelIcon subject={draft.subject} size={32} />
                          </button>
                          <div>
                            <div className="font-extrabold text-[19px] text-[#332230] flex items-center gap-2">
                              <span>{draft.title}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              <span
                                className="pixel-tag px-2.5 py-0.5 text-[13px] font-bold text-white"
                                style={{ backgroundColor: subj.pillHex }}
                              >
                                {subj.label}
                              </span>
                              {draft.categoryTags.map((tag) => (
                                <span
                                  key={tag}
                                  className="pixel-tag bg-[#FFFDF9] px-2.5 py-0.5 text-[13px] font-bold"
                                >
                                  #{tag}
                                </span>
                              ))}
                              <span className="pixel-tag bg-[#FFF9DE] px-2.5 py-0.5 text-[13px] font-bold flex items-center gap-1">
                                难度
                                {[1, 2, 3].map((n) => (
                                  <PixelStarBadge key={n} filled={n <= draft.difficulty} size={12} />
                                ))}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded px-3 py-1 text-right shrink-0">
                          <div className="text-[12px] font-bold text-[#5C4056]">
                            通关奖 +{draft.rewardStars}★
                          </div>
                          <div className="font-num text-[18px] font-extrabold text-[#C92A6A]">
                            🎯 满分100分
                          </div>
                        </div>
                      </div>

                      <div className="mt-2.5 pt-2 border-t border-[#4A2B44]/20 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleDraftMode(draft.draftId)}
                            className="pixel-btn bg-[#FFFDF9] px-3 py-1 text-[14px] font-bold"
                          >
                            {draft.timerMode === 'countdown' ? '⏳ 倒计时模式' : '⏱️ 正计时模式'}
                          </button>
                          <button
                            type="button"
                            onClick={() => adjustDuration(draft.draftId, -5)}
                            className="pixel-btn bg-[#FFFDF9] px-2.5 py-1 text-[14px] font-bold font-num"
                          >
                            -5分
                          </button>
                          <span className="font-num text-[16px] font-extrabold px-1">
                            {draft.plannedDurationMinutes}分钟
                          </span>
                          <button
                            type="button"
                            onClick={() => adjustDuration(draft.draftId, 5)}
                            className="pixel-btn bg-[#FFFDF9] px-2.5 py-1 text-[14px] font-bold font-num"
                          >
                            +5分
                          </button>
                        </div>

                        <span className="text-[13px] font-bold text-[#4A2B44] font-num">
                          专注{draft.scoringRubric.focus} + 完整{draft.scoringRubric.completeness} + 准确{draft.scoringRubric.accuracy}
                        </span>

                        {drafts.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setDrafts((prev) => prev.filter((x) => x.draftId !== draft.draftId))
                            }
                            className="pixel-btn bg-[#FFFDF9] px-2.5 py-1 text-[13px] font-bold text-[#8E3B63]"
                          >
                            移除
                          </button>
                        )}
                      </div>
                      <div className="mt-1.5 text-[13px] font-semibold text-[#5C4056]">
                        💡 {draft.scoreHint}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="pt-3 border-t-2 border-[#EAD6E2] flex items-center justify-end gap-3 shrink-0">
              <button
                type="button"
                disabled={Boolean(busyMessage)}
                onClick={onClose}
                className="pixel-btn bg-[#FFFDF9] px-5 py-2.5 text-[17px] font-bold h-[52px]"
              >
                先不加了
              </button>
              <button
                type="button"
                disabled={drafts.length === 0 || Boolean(busyMessage)}
                onClick={handleConfirmCreate}
                className="pixel-btn bg-[#52CE9B] text-[#104530] px-7 py-2.5 text-[19px] font-extrabold h-[52px]"
              >
                ✅ 确认加入今日时间线
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
