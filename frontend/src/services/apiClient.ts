import type {
  AsyncJobInfo,
  AttentionSegmentItem,
  AuditLogResponse,
  CalendarDaySummary,
  ChildProfile,
  DailyAttentionReport,
  DailyEvaluation,
  DictionaryLookup,
  StudyTask,
  TaskImageItem,
  TimerMode,
  UploadKind,
  VoiceTaskDraft,
} from '../types/study'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? ''

export function apiUrl(path: string): string {
  if (!API_BASE_URL || path.startsWith('http://') || path.startsWith('https://')) {
    return path
  }
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

function absolutizeMediaPaths<T>(val: T): T {
  if (!API_BASE_URL || val === null || val === undefined) {
    return val
  }
  if (typeof val === 'string') {
    if (val.startsWith('/api/v1/')) {
      return `${API_BASE_URL}${val}` as unknown as T
    }
    return val
  }
  if (Array.isArray(val)) {
    return val.map((item) => absolutizeMediaPaths(item)) as unknown as T
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = absolutizeMediaPaths(v)
    }
    return out as T
  }
  return val
}

async function readApiResponse<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = `请求失败 (HTTP ${resp.status})`
    try {
      const errBody = (await resp.json()) as { detail?: string }
      if (errBody.detail) detail = errBody.detail
    } catch {
      void 0
    }
    throw new Error(detail)
  }
  const parsed = (await resp.json()) as T
  return absolutizeMediaPaths(parsed)
}

export async function compressImageForModel(
  file: File,
  maxEdge = 1600,
  quality = 0.84,
): Promise<File> {
  const bitmapUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`无法解析图片文件: ${file.name}`))
      el.src = bitmapUrl
    })

    let targetW = img.naturalWidth || img.width
    let targetH = img.naturalHeight || img.height
    const longest = Math.max(targetW, targetH)
    if (longest > maxEdge) {
      const scale = maxEdge / longest
      targetW = Math.max(1, Math.round(targetW * scale))
      targetH = Math.max(1, Math.round(targetH * scale))
    }

    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return file
    }
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, targetW, targetH)
    ctx.drawImage(img, 0, 0, targetW, targetH)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
    )
    if (!blob) return file

    const cleanName = file.name.replace(/\.[^.]+$/, '') + '.jpg'
    return new File([blob], cleanName, { type: 'image/jpeg' })
  } finally {
    URL.revokeObjectURL(bitmapUrl)
  }
}

const ttsUrlMemoryCache = new Map<string, string>()

export const studyApi = {
  async speakOnDemand(params: {
    text: string
    bindKind?: 'task_praise' | 'mistake_explain' | 'daily_eval'
    bindId?: string
    prebuiltUrl?: string | null
  }): Promise<string> {
    if (params.prebuiltUrl) {
      return params.prebuiltUrl
    }
    const cacheKey = `${params.bindKind ?? 'raw'}:${params.bindId ?? ''}:${params.text.trim()}`
    const memHit = ttsUrlMemoryCache.get(cacheKey)
    if (memHit) {
      return memHit
    }
    const form = new FormData()
    form.append('text', params.text)
    if (params.bindKind) form.append('bind_kind', params.bindKind)
    if (params.bindId) form.append('bind_id', params.bindId)
    const resp = await fetch(apiUrl('/api/v1/tts/speak'), {
      method: 'POST',
      body: form,
    })
    const res = await readApiResponse<{ audioUrl: string; cached?: boolean }>(resp)
    ttsUrlMemoryCache.set(cacheKey, res.audioUrl)
    return res.audioUrl
  },

  async listChildren(): Promise<ChildProfile[]> {
    const resp = await fetch(apiUrl('/api/v1/children'))
    return readApiResponse<ChildProfile[]>(resp)
  },

  async getCalendar(
    childId: string,
    start: string,
    end: string,
  ): Promise<Record<string, CalendarDaySummary>> {
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/calendar?start=${start}&end=${end}`),
    )
    const data = await readApiResponse<{ days: Record<string, CalendarDaySummary> }>(resp)
    return data.days
  },

  async getTimeline(childId: string, dateStr: string): Promise<StudyTask[]> {
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/timeline?date=${dateStr}`),
    )
    return readApiResponse<StudyTask[]>(resp)
  },

  async transcribeAudio(
    childId: string,
    wavBlob: Blob,
  ): Promise<{ transcript: string; durationMs: number; audioMinioKey: string; audioUrl: string }> {
    const form = new FormData()
    form.append('child_id', childId)
    form.append('file', wavBlob, 'speech.wav')
    const resp = await fetch(apiUrl('/api/v1/asr/transcribe'), {
      method: 'POST',
      body: form,
    })
    return readApiResponse(resp)
  },

  async parseVoiceTasks(
    childId: string,
    payload: {
      transcript: string
      targetDate: string
      existingDrafts?: VoiceTaskDraft[]
      isRefinement?: boolean
    },
  ): Promise<{
    transcript: string
    spokenReply: string
    ttsAudioUrl: string | null
    drafts: VoiceTaskDraft[]
  }> {
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/tasks/voice-parse`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    return readApiResponse(resp)
  },

  async createTasksBatch(
    childId: string,
    payload: {
      targetDate: string
      rawTranscript: string
      voiceMinioKey?: string | null
      drafts: VoiceTaskDraft[]
    },
  ): Promise<StudyTask[]> {
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/tasks/batch`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    return readApiResponse<StudyTask[]>(resp)
  },

  async switchTimerMode(taskId: string, timerMode: TimerMode): Promise<StudyTask> {
    const resp = await fetch(apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/mode`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timerMode }),
    })
    return readApiResponse<StudyTask>(resp)
  },

  async deleteOrVoidTask(taskId: string, actor: 'child' | 'parent'): Promise<void> {
    const resp = await fetch(
      apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}?actor=${actor}`),
      { method: 'DELETE' },
    )
    await readApiResponse(resp)
  },

  async startTimer(taskId: string): Promise<StudyTask> {
    const resp = await fetch(apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/timer/start`), {
      method: 'POST',
    })
    return readApiResponse<StudyTask>(resp)
  },

  async heartbeatTimer(taskId: string): Promise<StudyTask> {
    const resp = await fetch(
      apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/timer/heartbeat`),
      {
        method: 'POST',
      },
    )
    return readApiResponse<StudyTask>(resp)
  },

  async pauseTimer(taskId: string): Promise<StudyTask> {
    const resp = await fetch(apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/timer/pause`), {
      method: 'POST',
    })
    return readApiResponse<StudyTask>(resp)
  },

  async uploadHomeworkImages(
    taskId: string,
    uploadKind: UploadKind,
    rawFiles: File[],
  ): Promise<TaskImageItem[]> {
    const compressedFiles: File[] = []
    for (const f of rawFiles) {
      const comp = await compressImageForModel(f, 1600, 0.84)
      compressedFiles.push(comp)
    }

    const form = new FormData()
    form.append('upload_kind', uploadKind)
    for (const cf of compressedFiles) {
      form.append('files', cf, cf.name)
    }

    const resp = await fetch(apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/images/upload`), {
      method: 'POST',
      body: form,
    })
    return readApiResponse<TaskImageItem[]>(resp)
  },

  async submitHomeworkForDshReview(
    taskId: string,
    payload: {
      uploadKind: UploadKind
      summaryVoiceText: string
      summaryAudioKey?: string | null
    },
  ): Promise<AsyncJobInfo> {
    const resp = await fetch(apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/submit`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readApiResponse<AsyncJobInfo>(resp)
  },

  async getJobStatus(jobId: string): Promise<AsyncJobInfo> {
    const resp = await fetch(apiUrl(`/api/v1/jobs/${encodeURIComponent(jobId)}`))
    return readApiResponse<AsyncJobInfo>(resp)
  },

  async getDailyEvaluation(
    childId: string,
    evalDate: string,
  ): Promise<DailyEvaluation | null> {
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/evaluations/${evalDate}`),
    )
    return readApiResponse<DailyEvaluation | null>(resp)
  },

  async triggerDailyEvaluation(childId: string, evalDate: string): Promise<AsyncJobInfo> {
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/evaluations/${evalDate}/generate`),
      { method: 'POST' },
    )
    return readApiResponse<AsyncJobInfo>(resp)
  },

  async listParentAllTasks(childId: string): Promise<StudyTask[]> {
    const resp = await fetch(apiUrl(`/api/v1/parent/tasks/${encodeURIComponent(childId)}`))
    return readApiResponse<StudyTask[]>(resp)
  },

  async listParentAuditLogs(
    childId: string,
    level: 'all' | 'error' = 'all',
    limit = 80,
  ): Promise<AuditLogResponse> {
    const resp = await fetch(
      apiUrl(
        `/api/v1/parent/logs?child_id=${encodeURIComponent(childId)}&level=${level}&limit=${limit}`,
      ),
    )
    return readApiResponse<AuditLogResponse>(resp)
  },

  async submitDictionaryLookup(
    childId: string,
    rawPhotoFile: File,
    maskPngBlob: Blob,
    instruction: string,
  ): Promise<AsyncJobInfo> {
    const normalizedFile = await compressImageForModel(rawPhotoFile, 1600, 0.88)
    const form = new FormData()
    form.append('instruction', instruction)
    form.append('image_file', normalizedFile, normalizedFile.name)
    form.append('mask_file', maskPngBlob, 'mask.png')
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/dictionary/lookup`),
      {
        method: 'POST',
        body: form,
      },
    )
    return readApiResponse<AsyncJobInfo>(resp)
  },

  async getDictionaryLookup(lookupId: string): Promise<DictionaryLookup> {
    const resp = await fetch(apiUrl(`/api/v1/dictionary/lookups/${encodeURIComponent(lookupId)}`))
    return readApiResponse<DictionaryLookup>(resp)
  },

  async listDictionaryHistory(childId: string, limit = 30): Promise<DictionaryLookup[]> {
    const resp = await fetch(
      apiUrl(`/api/v1/children/${encodeURIComponent(childId)}/dictionary/history?limit=${limit}`),
    )
    return readApiResponse<DictionaryLookup[]>(resp)
  },

  async pronounceDictionaryWord(word: string): Promise<{ word: string; audioUrl: string }> {
    const form = new FormData()
    form.append('word', word)
    const resp = await fetch(apiUrl('/api/v1/dictionary/pronounce'), {
      method: 'POST',
      body: form,
    })
    return readApiResponse<{ word: string; audioUrl: string }>(resp)
  },

  async uploadTaskAttentionSegments(
    taskId: string,
    segments: AttentionSegmentItem[],
  ): Promise<{ savedCount: number; taskId: string }> {
    const resp = await fetch(
      apiUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/attention-segments`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments }),
      },
    )
    return readApiResponse<{ savedCount: number; taskId: string }>(resp)
  },

  async getDailyAttentionReport(childId: string, dateStr: string): Promise<DailyAttentionReport> {
    const resp = await fetch(
      apiUrl(
        `/api/v1/parent/attention/${encodeURIComponent(childId)}/daily?date=${encodeURIComponent(dateStr)}`,
      ),
    )
    return readApiResponse<DailyAttentionReport>(resp)
  },

  async rotateTaskImage(
    imageId: string,
    degreesCw: 90 | 180 | 270,
  ): Promise<{ imageId: string; width: number; height: number; imageUrl: string }> {
    const resp = await fetch(apiUrl(`/api/v1/images/${encodeURIComponent(imageId)}/rotate`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ degreesCw }),
    })
    return readApiResponse(resp)
  },

  async rotateMistakeCrop(
    mistakeId: string,
    degreesCw: 90 | 180 | 270,
  ): Promise<{ mistakeId: string; width: number; height: number; cropImageUrl: string }> {
    const resp = await fetch(
      apiUrl(`/api/v1/mistakes/${encodeURIComponent(mistakeId)}/rotate-crop`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ degreesCw }),
      },
    )
    return readApiResponse(resp)
  },
}
