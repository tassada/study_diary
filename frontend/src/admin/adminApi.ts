import { apiUrl } from '../services/apiClient'
import type {
  AuditLogResponse,
  ChildProfile,
  DailyAttentionReport,
  DailyEvaluation,
  DictionaryLookup,
  StudyTask,
} from '../types/study'

const SESSION_KEY = 'studydiary_admin_token_session'
const LOCAL_KEY = 'studydiary_admin_token_saved'

export interface AdminChildOverviewItem {
  profile: ChildProfile
  stats: {
    totalTasks: number
    completedTasks: number
    totalFocusMinutes: number
    avgScore: number | null
    openMistakes: number
    masteredMistakes: number
    dictionaryLookups: number
    activeTaskTitle: string | null
    activeTaskDate: string | null
  }
}

export interface AdminChildMemoryData {
  childId: string
  dshSessionId: string | null
  agentsMd: string
  memoryMd: string
  mistakesJsonl: string
}

export interface AdminAttentionDateSummary {
  date: string
  trackedSec: number
  presentSec: number
  focusedSec: number
}

export function getStoredAdminToken(): string {
  return sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(LOCAL_KEY) || ''
}

export function saveAdminToken(token: string, remember: boolean): void {
  sessionStorage.setItem(SESSION_KEY, token)
  if (remember) {
    localStorage.setItem(LOCAL_KEY, token)
  } else {
    localStorage.removeItem(LOCAL_KEY)
  }
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(LOCAL_KEY)
}

export class AdminUnauthorizedError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'AdminUnauthorizedError'
  }
}

async function adminFetchJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {})
  headers.set('Authorization', `Bearer ${token}`)
  const resp = await fetch(apiUrl(path), {
    ...init,
    headers,
  })
  if (resp.status === 401) {
    let detail = '预设 Token 无效或已失效，请重新登录'
    try {
      const err = (await resp.json()) as { detail?: string }
      if (err.detail) detail = err.detail
    } catch {
      void 0
    }
    throw new AdminUnauthorizedError(detail)
  }
  if (!resp.ok) {
    let detail = `请求失败 (HTTP ${resp.status})`
    try {
      const err = (await resp.json()) as { detail?: string }
      if (err.detail) detail = err.detail
    } catch {
      void 0
    }
    throw new Error(detail)
  }
  return (await resp.json()) as T
}

export const adminApi = {
  verifyToken(token: string): Promise<{ authenticated: boolean; serverTime: string }> {
    return adminFetchJson('/api/v1/admin/auth/verify', token, { method: 'POST' })
  },

  listChildren(token: string): Promise<AdminChildOverviewItem[]> {
    return adminFetchJson('/api/v1/admin/children', token)
  },

  createChild(
    token: string,
    payload: {
      displayName: string
      birthDate: string
      gender: string
      age: number
      gradeLabel: string
      dailyGoalMinutes: number
    },
  ): Promise<ChildProfile> {
    return adminFetchJson('/api/v1/admin/children', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  },

  listChildTasks(token: string, childId: string, date?: string): Promise<StudyTask[]> {
    const qs = date ? `?date=${encodeURIComponent(date)}` : ''
    return adminFetchJson(`/api/v1/admin/children/${encodeURIComponent(childId)}/tasks${qs}`, token)
  },

  voidTaskAsAdmin(token: string, taskId: string): Promise<{ voided: boolean; taskId: string }> {
    return adminFetchJson(
      `/api/v1/admin/tasks/${encodeURIComponent(taskId)}/void`,
      token,
      { method: 'POST' },
    )
  },

  listChildEvaluations(token: string, childId: string): Promise<DailyEvaluation[]> {
    return adminFetchJson(
      `/api/v1/admin/children/${encodeURIComponent(childId)}/evaluations`,
      token,
    )
  },

  getChildMemory(token: string, childId: string): Promise<AdminChildMemoryData> {
    return adminFetchJson(`/api/v1/admin/children/${encodeURIComponent(childId)}/memory`, token)
  },

  getChildAttention(
    token: string,
    childId: string,
    dateStr: string,
  ): Promise<DailyAttentionReport> {
    return adminFetchJson(
      `/api/v1/admin/children/${encodeURIComponent(childId)}/attention?date=${encodeURIComponent(dateStr)}`,
      token,
    )
  },

  listChildAttentionDates(token: string, childId: string): Promise<AdminAttentionDateSummary[]> {
    return adminFetchJson(
      `/api/v1/admin/children/${encodeURIComponent(childId)}/attention-dates`,
      token,
    )
  },

  listChildDictionary(token: string, childId: string): Promise<DictionaryLookup[]> {
    return adminFetchJson(
      `/api/v1/admin/children/${encodeURIComponent(childId)}/dictionary`,
      token,
    )
  },

  getLogs(
    token: string,
    params: { level: 'all' | 'error'; childId?: string | null; limit?: number },
  ): Promise<AuditLogResponse> {
    const q = new URLSearchParams()
    q.set('level', params.level)
    q.set('limit', String(params.limit ?? 150))
    if (params.childId) q.set('child_id', params.childId)
    return adminFetchJson(`/api/v1/admin/logs?${q.toString()}`, token)
  },

  rotateTaskImage(
    token: string,
    imageId: string,
    degreesCw: 90 | 180 | 270,
  ): Promise<{ imageId: string; width: number; height: number; imageUrl: string }> {
    return adminFetchJson(
      `/api/v1/admin/images/${encodeURIComponent(imageId)}/rotate`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ degreesCw }),
      },
    )
  },

  rotateMistakeCrop(
    token: string,
    mistakeId: string,
    degreesCw: 90 | 180 | 270,
  ): Promise<{ mistakeId: string; width: number; height: number; cropImageUrl: string }> {
    return adminFetchJson(
      `/api/v1/admin/mistakes/${encodeURIComponent(mistakeId)}/rotate-crop`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ degreesCw }),
      },
    )
  },

  retryTaskReview(
    token: string,
    taskId: string,
    summaryVoiceText = '',
  ): Promise<{ id: string; status: string }> {
    return adminFetchJson(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/submit`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadKind: 'initial', summaryVoiceText }),
      },
    )
  },
}
