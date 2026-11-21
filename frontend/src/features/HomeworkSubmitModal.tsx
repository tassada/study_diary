import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  ImagePreviewLightbox,
  type LightboxMediaItem,
  type LightboxRotatableTarget,
} from '../components/ImagePreviewLightbox'
import { StellaTeacherSprite } from '../components/PixelSprites'
import { usePixelVoiceRecorder } from '../hooks/usePixelVoiceRecorder'
import { studyApi } from '../services/apiClient'
import { pixelAudio } from '../services/pixelAudio'
import type { AsyncJobInfo, StudyTask, TaskImageItem, UploadKind } from '../types/study'

interface HomeworkSubmitModalProps {
  task: StudyTask
  initialMode: UploadKind | 'inspect'
  activeJob: AsyncJobInfo | null
  soundEnabled: boolean
  onClose: () => void
  onJobStarted: (taskId: string, job: AsyncJobInfo) => void
  onRefreshTask: () => Promise<void>
}

export function HomeworkSubmitModal({
  task,
  initialMode,
  activeJob,
  soundEnabled,
  onClose,
  onJobStarted,
  onRefreshTask,
}: HomeworkSubmitModalProps) {
  const recorder = usePixelVoiceRecorder()
  const [viewTab, setViewTab] = useState<'upload_submit' | 'mistakes_result' | 'ocr_pages'>(
    initialMode === 'inspect'
      ? task.mistakes.length > 0
        ? 'mistakes_result'
        : 'ocr_pages'
      : 'upload_submit',
  )
  const [uploadKind, setUploadKind] = useState<UploadKind>(
    initialMode === 'inspect'
      ? task.status === 'completed'
        ? 'correction'
        : 'initial'
      : initialMode,
  )
  const [images, setImages] = useState<TaskImageItem[]>(task.images)
  const [selectedImgIdx, setSelectedImgIdx] = useState(0)
  const [showBoxes, setShowBoxes] = useState(true)
  const [uploadingCount, setUploadingCount] = useState<number>(0)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceSummary, setVoiceSummary] = useState(task.summaryVoiceText ?? '')
  const [summaryAudioKey, setSummaryAudioKey] = useState<string | null>(null)
  const [summaryAudioUrl, setSummaryAudioUrl] = useState<string | null>(task.summaryAudioUrl)
  const [revealedPracticeIds, setRevealedPracticeIds] = useState<Record<string, boolean>>({})
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [lightboxState, setLightboxState] = useState<{
    items: LightboxMediaItem[]
    initialIndex: number
  } | null>(null)
  const [urlOverrides, setUrlOverrides] = useState<Record<string, string>>({})
  const prevJobStatusRef = useRef<AsyncJobInfo['status'] | undefined>(activeJob?.status)

  const resolveMediaUrl = (entityId: string, rawUrl: string | null | undefined): string => {
    if (!rawUrl) return ''
    return urlOverrides[entityId] ?? rawUrl
  }

  const handlePersistRotation = async (
    target: LightboxRotatableTarget,
    degreesCw: 90 | 180 | 270,
  ): Promise<string> => {
    if (target.kind === 'task_image') {
      const res = await studyApi.rotateTaskImage(target.id, degreesCw)
      setUrlOverrides((prev) => ({ ...prev, [target.id]: res.imageUrl }))
      await onRefreshTask()
      return res.imageUrl
    }
    const res = await studyApi.rotateMistakeCrop(target.id, degreesCw)
    setUrlOverrides((prev) => ({ ...prev, [target.id]: res.cropImageUrl }))
    await onRefreshTask()
    return res.cropImageUrl
  }

  const openMistakePreview = (
    m: StudyTask['mistakes'][number],
    preferred: 'full' | 'crop' | 'diagram',
  ) => {
    const sourceImg =
      (m.imageId ? images.find((im) => im.id === m.imageId) : null) ?? images[0] ?? null
    const items: LightboxMediaItem[] = []
    let fullIdx = -1
    let cropIdx = -1
    let diagIdx = -1

    if (sourceImg) {
      fullIdx = items.length
      items.push({
        key: `stu-full-${sourceImg.id}`,
        label: '📄 原卷全图',
        url: resolveMediaUrl(sourceImg.id, sourceImg.imageUrl),
        subTitle: m.questionTitle,
        sideTitle: '错题剖析',
        sideBody: `【原卷易错点】\n${m.wrongSnippet}\n\n【错因剖析】\n${m.errorCause}`,
        rotatableTarget: { kind: 'task_image', id: sourceImg.id },
      })
    }
    if (m.cropImageUrl) {
      cropIdx = items.length
      items.push({
        key: `stu-crop-${m.id}`,
        label: '✂️ 错题裁切图',
        url: resolveMediaUrl(m.id, m.cropImageUrl),
        subTitle: m.questionTitle,
        rotatableTarget: { kind: 'mistake_crop', id: m.id },
      })
    }
    if (m.diagramImageUrl) {
      diagIdx = items.length
      items.push({
        key: `stu-diag-${m.id}`,
        label: '📊 精讲图卡',
        url: m.diagramImageUrl,
        subTitle: m.questionTitle,
      })
    }
    if (items.length === 0) return
    let initialIndex = 0
    if (preferred === 'full' && fullIdx >= 0) initialIndex = fullIdx
    else if (preferred === 'crop' && cropIdx >= 0) initialIndex = cropIdx
    else if (preferred === 'diagram' && diagIdx >= 0) initialIndex = diagIdx
    setLightboxState({ items, initialIndex })
  }

  useEffect(() => {
    setImages(task.images)
  }, [task.images])

  useEffect(() => {
    const prevStatus = prevJobStatusRef.current
    const currStatus = activeJob?.status
    prevJobStatusRef.current = currStatus

    const wasRunning =
      prevStatus === 'queued' ||
      prevStatus === 'ocr_running' ||
      prevStatus === 'dsh_running' ||
      prevStatus === 'tts_running'

    if (wasRunning && currStatus === 'succeeded') {
      setViewTab(task.mistakes.length > 0 ? 'mistakes_result' : 'ocr_pages')
    }
  }, [activeJob?.status, task.mistakes.length])

  const isJobRunning =
    activeJob !== null && activeJob.status !== 'succeeded' && activeJob.status !== 'failed'

  const handleFilesSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    const rawFiles = Array.from(fileList)
    e.target.value = ''

    setErrorMsg(null)
    setUploadingCount(rawFiles.length)
    try {
      const saved = await studyApi.uploadHomeworkImages(task.id, uploadKind, rawFiles)
      pixelAudio.playChime('sparkle', soundEnabled)
      setImages((prev) => {
        const merged = [...prev, ...saved]
        setSelectedImgIdx(merged.length - 1)
        return merged
      })
      await onRefreshTask()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '图片压缩上传失败，请重试')
    } finally {
      setUploadingCount(0)
    }
  }

  const handleVoiceSummaryRecord = async () => {
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
      const asr = await studyApi.transcribeAudio(task.childId, rec.wavBlob)
      const finalSummary = (asr.transcript || rec.liveTranscript).trim()
      if (!finalSummary) {
        setErrorMsg('未识别到清晰语音，请靠近麦克风再说一次哦！')
        return
      }
      setSummaryAudioKey(asr.audioMinioKey)
      setSummaryAudioUrl(asr.audioUrl)
      setVoiceSummary(finalSummary)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '语音识别失败')
    } finally {
      setVoiceBusy(false)
    }
  }

  const handleStartAsyncDshReview = async () => {
    if (uploadingCount > 0 || isJobRunning) return
    if (images.length === 0 && !voiceSummary.trim()) {
      setErrorMsg('请先上传至少一张作业图片或用语音汇报学习情况哦！')
      return
    }
    setErrorMsg(null)
    try {
      const job = await studyApi.submitHomeworkForDshReview(task.id, {
        uploadKind,
        summaryVoiceText: voiceSummary.trim(),
        summaryAudioKey,
      })
      pixelAudio.playChime('sparkle', soundEnabled)
      onJobStarted(task.id, job)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '提交异步批阅失败')
    }
  }

  const [ttsLoadingId, setTtsLoadingId] = useState<string | null>(null)

  const playOnDemandAudio = async (params: {
    keyId: string
    text: string
    bindKind?: 'task_praise' | 'mistake_explain'
    bindId?: string
    prebuiltUrl?: string | null
  }) => {
    if (ttsLoadingId === params.keyId) return
    setTtsLoadingId(params.keyId)
    try {
      const url = await studyApi.speakOnDemand({
        text: params.text,
        bindKind: params.bindKind,
        bindId: params.bindId,
        prebuiltUrl: params.prebuiltUrl,
      })
      const audio = new Audio(url)
      audio.onended = () => setTtsLoadingId(null)
      audio.onerror = () => setTtsLoadingId(null)
      await audio.play()
    } catch {
      setTtsLoadingId(null)
    }
  }

  const currentImage = images[selectedImgIdx]

  return (
    <div className="absolute inset-0 z-40 bg-[#2A1829]/70 p-4 flex items-center justify-center">
      <div className="pixel-card-pink w-full h-full p-5 flex flex-col justify-between relative">
        {uploadingCount > 0 && (
          <div className="absolute inset-0 z-50 bg-[#2A1829]/75 flex items-center justify-center p-8">
            <div className="pixel-card-butter px-10 py-8 text-center space-y-3 max-w-lg">
              <div className="text-4xl animate-bounce">☁️📸</div>
              <div className="text-[23px] font-extrabold text-[#332230]">
                图片压缩与上传中，请等待...
              </div>
              <div className="text-[16px] font-semibold text-[#5C4056]">
                正在处理并上传 {uploadingCount} 张作业照片，请稍候
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pb-3 border-b-3 border-[#4A2B44] shrink-0">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-[22px] font-extrabold text-[#332230] flex items-center gap-2">
                <span>📚 {task.title}</span>
                {task.earnedScore !== null && (
                  <span className="bg-[#FFE484] border-2 border-[#4A2B44] px-3 py-0.5 rounded font-num text-[18px] text-[#C92A6A]">
                    {task.revisionCount > 0 && task.initialScore !== null
                      ? `初交${task.initialScore} → 订正后 ${task.earnedScore}/100分`
                      : `得分 ${task.earnedScore}/100分`}
                  </span>
                )}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setViewTab('upload_submit')}
              className={`pixel-btn px-3.5 py-1.5 text-[15px] font-extrabold ${
                viewTab === 'upload_submit' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              📸 上传/重传作业 ({images.length})
            </button>
            <button
              type="button"
              onClick={() => setViewTab('mistakes_result')}
              className={`pixel-btn px-3.5 py-1.5 text-[15px] font-extrabold ${
                viewTab === 'mistakes_result' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              🎓 错题图文精讲 ({task.mistakes.length})
            </button>
            <button
              type="button"
              onClick={() => setViewTab('ocr_pages')}
              className={`pixel-btn px-3.5 py-1.5 text-[15px] font-extrabold ${
                viewTab === 'ocr_pages' ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
              }`}
            >
              🔍 原卷与 OCR 框
            </button>
            <button
              type="button"
              onClick={onClose}
              className="pixel-btn bg-[#FFFDF9] px-4 py-1.5 text-[16px] font-extrabold text-[#332230]"
            >
              ✕ 关闭
            </button>
          </div>
        </div>

        {isJobRunning && (
          <div className="mt-3 bg-[#FFF5C2] border-3 border-[#4A2B44] rounded-md px-4 py-3 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3">
              <StellaTeacherSprite talking size={42} />
              <div>
                <div className="text-[17px] font-extrabold text-[#332230]">
                  🔄 异步智能体处理中，请稍候（也可先关闭窗口做别的事）
                </div>
                <div className="text-[15px] font-bold text-[#7A4B00]">{activeJob?.progressText}</div>
              </div>
            </div>
            <span className="bg-white border-2 border-[#4A2B44] px-3 py-1 rounded text-[14px] font-extrabold font-num">
              状态：{activeJob?.status}
            </span>
          </div>
        )}

        {activeJob?.status === 'failed' && activeJob.errorDetail && (
          <div className="mt-3 bg-[#FFE8F0] border-2 border-[#C92A6A] rounded p-2.5 text-[15px] font-bold text-[#7A1C3E] shrink-0">
            ⚠️ 异步处理报错：{activeJob.errorDetail}
          </div>
        )}

        {viewTab === 'upload_submit' && (
          <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 pt-3.5">
            <div className="col-span-7 pixel-card p-4 flex flex-col justify-between min-h-0">
              <div className="space-y-3 shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {task.status === 'completed' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setUploadKind('correction')}
                          className={`pixel-btn px-3 py-1.5 text-[14px] font-extrabold ${
                            uploadKind === 'correction'
                              ? 'bg-[#EC5F9B] text-white'
                              : 'bg-[#FFFDF9]'
                          }`}
                        >
                          ✏️ 错题订正重传（追回扣分）
                        </button>
                        <button
                          type="button"
                          onClick={() => setUploadKind('supplement')}
                          className={`pixel-btn px-3 py-1.5 text-[14px] font-extrabold ${
                            uploadKind === 'supplement'
                              ? 'bg-[#EC5F9B] text-white'
                              : 'bg-[#FFFDF9]'
                          }`}
                        >
                          ➕ 补传漏拍作业页
                        </button>
                      </>
                    ) : (
                      <span className="text-[18px] font-extrabold text-[#332230]">
                        📷 拍照或上传作业图片
                      </span>
                    )}
                  </div>

                  <label className="pixel-btn bg-[#EC5F9B] text-white px-4 py-2 text-[16px] font-extrabold inline-flex items-center gap-2 shrink-0">
                    <span>📸 选择作业照片</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={uploadingCount > 0 || isJobRunning}
                      onChange={handleFilesSelected}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              <div className="eye-scroll flex-1 min-h-0 overflow-y-auto my-3 pr-1">
                {images.length === 0 ? (
                  <div className="h-full bg-[#FAF4EC] border-2 border-dashed border-[#D6A6C2] rounded flex flex-col items-center justify-center p-6 text-center">
                    <div className="text-4xl mb-2">📷</div>
                    <div className="text-[18px] font-extrabold text-[#332230]">
                      尚未上传作业照片
                    </div>
                    <div className="text-[15px] font-semibold text-[#5C4056] mt-1">
                      支持一次选择多张照片上传
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {images.map((im, idx) => (
                      <div
                        key={im.id}
                        onClick={() => {
                          setSelectedImgIdx(idx)
                          setViewTab('ocr_pages')
                        }}
                        className="border-2 border-[#4A2B44] rounded bg-[#FFFDF9] p-2 cursor-pointer hover:brightness-98 flex flex-col justify-between"
                      >
                        <img
                          src={im.imageUrl}
                          alt={im.fileName}
                          className="w-full h-[145px] object-cover rounded border border-[#E5D4DF]"
                        />
                        <div className="mt-2 flex items-center justify-between text-[12px] font-bold">
                          <span className="truncate max-w-[95px]">第{idx + 1}张</span>
                          <span
                            className={`px-1.5 py-0.5 rounded border ${
                              im.ocrStatus === 'done'
                                ? 'bg-[#ECFDF3] text-[#104530] border-[#1E7A55]'
                                : 'bg-[#FFF5C2] text-[#7A4B00] border-[#B56B00]'
                            }`}
                          >
                            {im.ocrStatus === 'done' ? '✓ 已识别' : '待识别'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="text-[13px] font-semibold text-[#5C4056] shrink-0">
                共 {images.length} 张作业照片
              </div>
            </div>

            <div className="col-span-5 flex flex-col justify-between gap-3 min-h-0">
              <div className="pixel-card p-5 flex-1 min-h-0 flex flex-col justify-between">
                <div className="space-y-4">
                  <div className="font-extrabold text-[18px] text-[#332230]">
                    🎙️ 语音小结（可选）
                  </div>

                  <button
                    type="button"
                    disabled={voiceBusy || isJobRunning}
                    onClick={handleVoiceSummaryRecord}
                    className={`pixel-btn w-full py-3.5 px-4 text-[18px] font-extrabold h-[68px] flex items-center justify-center gap-2 ${
                      recorder.isRecording
                        ? 'bg-[#E11D74] text-white animate-pulse'
                        : 'bg-[#FFE484] text-[#332230]'
                    }`}
                  >
                    <span className="text-[22px]">{recorder.isRecording ? '⏹️' : '🎤'}</span>
                    <span>
                      {voiceBusy
                        ? '⏳ 正在转写语音...'
                        : recorder.isRecording
                          ? `正在录音 (${recorder.durationSec}秒)... 再点结束`
                          : '点击用语音说说完成情况'}
                    </span>
                  </button>
                </div>

                <div className="bg-[#F6F2FC] border-2 border-[#4A2B44] rounded p-3.5 text-[15px] leading-relaxed mt-3">
                  <div className="text-[13px] text-[#5E3F8A] font-extrabold mb-1">
                    语音内容：
                  </div>
                  <div className="font-medium text-[#332230]">
                    {voiceSummary || '暂无语音小结'}
                  </div>
                  {summaryAudioUrl && (
                    <audio controls src={summaryAudioUrl} className="mt-2 h-7 w-full" />
                  )}
                </div>
              </div>

              {errorMsg && (
                <div className="bg-[#FFE8F0] border-2 border-[#C92A6A] rounded p-2.5 text-[14px] font-bold text-[#7A1C3E]">
                  ⚠️ {errorMsg}
                </div>
              )}

              <button
                type="button"
                disabled={uploadingCount > 0 || isJobRunning}
                onClick={handleStartAsyncDshReview}
                className="pixel-btn w-full bg-[#52CE9B] text-[#104530] py-3.5 px-5 text-[19px] font-extrabold h-[58px] shrink-0"
              >
                {isJobRunning
                  ? '⏳ 海星老师正在后台批阅...'
                  : uploadKind === 'correction' && task.status === 'completed'
                    ? '🚀 提交订正照片复核加分'
                    : '🚀 提交作业批阅 & 错题讲解'}
              </button>
            </div>
          </div>
        )}

        {viewTab === 'mistakes_result' && (
          <div className="eye-scroll flex-1 min-h-0 overflow-y-auto pt-3.5 pr-2 space-y-4">
            {task.aiQuickPraise && (
              <div className="pixel-card bg-[#FFFDF9] p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <StellaTeacherSprite size={48} />
                  <div>
                    <div className="text-[18px] font-extrabold text-[#B51D5B]">
                      🌟 海星老师总体批阅评语（得分：{task.earnedScore ?? '—'}/100）
                    </div>
                    <div className="text-[16px] font-medium text-[#332230] mt-0.5 leading-relaxed">
                      {task.aiQuickPraise}
                    </div>
                  </div>
                </div>
                  <button
                    type="button"
                    disabled={ttsLoadingId === `praise-${task.id}`}
                    onClick={() =>
                      void playOnDemandAudio({
                        keyId: `praise-${task.id}`,
                        text: task.aiQuickPraise ?? '',
                        bindKind: 'task_praise',
                        bindId: task.id,
                        prebuiltUrl: task.praiseAudioUrl,
                      })
                    }
                    className="pixel-btn bg-[#FFE484] px-4 py-2 text-[15px] font-extrabold shrink-0"
                  >
                    {ttsLoadingId === `praise-${task.id}` ? '⏳ 合成语音中...' : '🔊 播放评语语音'}
                  </button>
              </div>
            )}

            {task.mistakes.length === 0 ? (
              <div className="pixel-card p-10 text-center space-y-3">
                <div className="text-4xl">🏆✨</div>
                <div className="text-[21px] font-extrabold text-[#332230]">
                  {task.status === 'completed'
                    ? '太厉害啦！本次作业未发现错题，卷面表现超棒！'
                    : '提交作业后，海星老师会在这里生成图文并茂的错题讲解卡片'}
                </div>
              </div>
            ) : (
              task.mistakes.map((m, idx) => (
                <div key={m.id} className="pixel-card p-4 space-y-3.5">
                  <div className="flex items-center justify-between border-b-2 border-[#EAD6E2] pb-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="bg-[#EC5F9B] text-white border-2 border-[#4A2B44] rounded px-2.5 py-0.5 text-[14px] font-extrabold">
                        错题精讲 #{idx + 1}
                      </span>
                      <h3 className="text-[20px] font-extrabold text-[#332230]">
                        {m.questionTitle}
                      </h3>
                      <span
                        className={`px-2.5 py-0.5 rounded border-2 text-[13px] font-extrabold ${
                          m.masteryStatus === 'mastered'
                            ? 'bg-[#52CE9B] text-[#104530] border-[#4A2B44]'
                            : 'bg-[#FFF5C2] text-[#7A4B00] border-[#4A2B44]'
                        }`}
                      >
                        {m.masteryStatus === 'mastered' ? '🌟 订正重传已攻克' : '📌 待订正巩固'}
                      </span>
                    </div>

                    <button
                      type="button"
                      disabled={ttsLoadingId === `mstk-${m.id}`}
                      onClick={() =>
                        void playOnDemandAudio({
                          keyId: `mstk-${m.id}`,
                          text: `${m.questionTitle}。${m.errorCause}。${m.correctSteps.join('；')}`,
                          bindKind: 'mistake_explain',
                          bindId: m.id,
                          prebuiltUrl: m.ttsAudioUrl,
                        })
                      }
                      className="pixel-btn bg-[#FFE484] px-4 py-1.5 text-[15px] font-extrabold"
                    >
                      {ttsLoadingId === `mstk-${m.id}` ? '⏳ 合成语音中...' : '🔊 听海星老师语音讲题'}
                    </button>
                  </div>

                  <div className="grid grid-cols-12 gap-4 items-start">
                    <div className="col-span-5 space-y-3">
                      {m.cropImageUrl && (
                        <div
                          onClick={() => openMistakePreview(m, 'full')}
                          className="bg-[#FAF4EC] border-2 border-[#4A2B44] rounded p-2.5 cursor-pointer hover:brightness-98"
                        >
                          <div className="flex items-center justify-between text-[13px] font-extrabold text-[#5C4056] mb-1.5">
                            <span>✂️ 原卷错题裁切：</span>
                            <span className="text-[#C92A6A] underline">🔍 点击看原卷全图 / 旋转</span>
                          </div>
                          <img
                            src={resolveMediaUrl(m.id, m.cropImageUrl)}
                            alt={m.questionTitle}
                            className="w-full max-h-[170px] object-contain bg-white rounded border border-[#DFC1D4]"
                          />
                        </div>
                      )}

                      <div className="bg-[#FFF0F5] border-2 border-[#4A2B44] rounded p-3 text-[15px] space-y-1.5">
                        <div>
                          <b className="text-[#B51D5B]">❌ 原卷易错点：</b>
                          <span>{m.wrongSnippet}</span>
                        </div>
                        <div>
                          <b className="text-[#4A2B44]">💡 错因剖析：</b>
                          <span>{m.errorCause}</span>
                        </div>
                      </div>

                      {m.practiceQuestion && (
                        <div className="bg-[#FFF8DF] border-2 border-[#4A2B44] rounded p-3 text-[15px] space-y-2">
                          <div className="font-extrabold text-[#5C3D00]">
                            🎯 同类举一反三小闯关：
                          </div>
                          <div className="font-semibold text-[#332230]">{m.practiceQuestion}</div>
                          {revealedPracticeIds[m.id] ? (
                            <div className="bg-[#ECFDF3] border border-[#1E7A55] rounded p-2 text-[14px] font-bold text-[#104530]">
                              ✅ 参考答案：{m.practiceAnswer}
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setRevealedPracticeIds((prev) => ({ ...prev, [m.id]: true }))
                              }
                              className="pixel-btn bg-white px-3 py-1 text-[13px] font-bold"
                            >
                              👀 我算好啦，点此核对答案
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="col-span-7 space-y-3">
                      {m.diagramImageUrl && (
                        <div
                          onClick={() => openMistakePreview(m, 'diagram')}
                          className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-2 cursor-pointer"
                        >
                          <img
                            src={m.diagramImageUrl}
                            alt={`${m.questionTitle} 图解卡`}
                            className="w-full h-auto rounded"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {viewTab === 'ocr_pages' && (
          <div className="flex-1 min-h-0 flex flex-col justify-between pt-3.5 gap-3">
            {images.length === 0 ? (
              <div className="pixel-card flex-1 flex items-center justify-center text-[18px] font-bold text-[#5C4056]">
                尚未上传作业图片
              </div>
            ) : (
              currentImage && (
                <>
                  <div className="flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                      {images.map((im, idx) => (
                        <button
                          key={im.id}
                          type="button"
                          onClick={() => setSelectedImgIdx(idx)}
                          className={`pixel-btn px-3.5 py-1 text-[15px] font-bold ${
                            idx === selectedImgIdx ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
                          }`}
                        >
                          第 {idx + 1} 张 ({im.uploadKind === 'correction' ? '订正图' : '作业图'})
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowBoxes((v) => !v)}
                      className="pixel-btn bg-[#FFFDF9] px-3.5 py-1 text-[14px] font-bold"
                    >
                      {showBoxes ? '👁️ 隐藏 OCR 坐标框' : '👁️ 显示 OCR 坐标框'}
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 grid grid-cols-12 gap-4">
                    <div className="col-span-7 pixel-card p-3 flex items-center justify-center overflow-auto">
                      <div className="relative inline-block max-h-full">
                        <img
                          src={currentImage.imageUrl}
                          alt={currentImage.fileName}
                          className="max-h-[470px] w-auto object-contain block rounded"
                        />
                        {showBoxes &&
                          currentImage.boxes.map((b) => {
                            const [x1, y1, x2, y2] = b.box
                            return (
                              <div
                                key={b.id}
                                className="absolute border-2 border-[#16A34A] bg-[#22C55E]/10 pointer-events-none"
                                style={{
                                  left: `${x1 / 10}%`,
                                  top: `${y1 / 10}%`,
                                  width: `${(x2 - x1) / 10}%`,
                                  height: `${(y2 - y1) / 10}%`,
                                }}
                              />
                            )
                          })}
                      </div>
                    </div>

                    <div className="col-span-5 pixel-card p-4 flex flex-col justify-between min-h-0">
                      <div className="font-extrabold text-[17px] text-[#332230] pb-2 border-b border-[#EAD6E2]">
                        📄 识别文本
                      </div>
                      <div className="eye-scroll flex-1 min-h-0 overflow-y-auto py-2 text-[15px] leading-relaxed whitespace-pre-wrap text-[#332230]">
                        {currentImage.ocrPlainText || '提交批阅后自动识别'}
                      </div>
                      <div className="text-[13px] font-semibold text-[#5C4056] pt-2 border-t border-[#EAD6E2] font-num">
                        尺寸：{currentImage.width}×{currentImage.height} · 压缩后体积：
                        {Math.round(currentImage.fileSize / 1024)} KB · 识别框：{currentImage.boxes.length} 处
                      </div>
                    </div>
                  </div>
                </>
              )
            )}
          </div>
        )}
      </div>

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
