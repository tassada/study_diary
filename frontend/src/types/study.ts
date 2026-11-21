export type GirlAvatarKey = 'duoduo' | 'tangtang' | 'guoguo'

export type SubjectKey = 'chinese' | 'math' | 'english' | 'science' | 'reading' | 'art'

export type TimerMode = 'countdown' | 'stopwatch'

export type TaskStatus = 'pending' | 'in_progress' | 'paused' | 'completed' | 'voided'

export type UploadKind = 'initial' | 'supplement' | 'correction'

export interface ScoringRubric {
  focus: number
  completeness: number
  accuracy: number
}

export interface ChildProfile {
  id: string
  displayName: string
  birthDate: string
  gender: string
  age: number
  gradeLabel: string
  titleBadge: string
  avatarKey: GirlAvatarKey
  themePink: string
  dailyGoalMinutes: number
  starCoins: number
}

export interface OcrBoundingBox {
  id: string
  refLabel: string
  box: [number, number, number, number]
  statusTag: string
}

export interface TaskImageItem {
  id: string
  uploadKind: UploadKind
  fileName: string
  imageUrl: string
  width: number
  height: number
  fileSize: number
  ocrStatus: 'pending' | 'done' | 'failed'
  ocrRawText: string
  ocrPlainText: string
  boxes: OcrBoundingBox[]
  createdAt: string
}

export interface MistakeCard {
  id: string
  imageId: string | null
  questionTitle: string
  wrongSnippet: string
  errorCause: string
  correctSteps: string[]
  practiceQuestion: string
  practiceAnswer: string
  cropImageUrl: string | null
  diagramImageUrl: string | null
  ttsAudioUrl: string | null
  masteryStatus: 'open' | 'mastered'
}

export interface StudyTask {
  id: string
  childId: string
  taskDate: string
  title: string
  rawVoiceText: string
  voiceAudioUrl: string | null
  plannedStartTime: string
  timerMode: TimerMode
  timerLocked: boolean
  plannedDurationSec: number
  actualDurationSec: number
  pauseCount: number
  subject: SubjectKey
  categoryTags: string[]
  difficulty: 1 | 2 | 3
  maxScore: number
  rewardStars: number
  scoringRubric: ScoringRubric
  scoreHint: string
  initialScore: number | null
  earnedScore: number | null
  revisionCount: number
  aiQuickPraise: string | null
  praiseAudioUrl: string | null
  summaryVoiceText: string
  summaryAudioUrl: string | null
  status: TaskStatus
  activeStartedAt: string | null
  autoPausedReason: string | null
  latestJobId: string | null
  latestJobStatus?: string | null
  latestJobError?: string | null
  images: TaskImageItem[]
  mistakes: MistakeCard[]
  updatedAt: string
}

export interface VoiceTaskDraft {
  draftId: string
  title: string
  plannedStartTime: string
  timerMode: TimerMode
  plannedDurationMinutes: number
  subject: SubjectKey
  categoryTags: string[]
  difficulty: 1 | 2 | 3
  rewardStars: number
  scoringRubric: ScoringRubric
  scoreHint: string
}

export interface AsyncJobInfo {
  id: string
  childId: string
  taskId: string | null
  evalDate: string | null
  jobType: string
  status: 'queued' | 'ocr_running' | 'dsh_running' | 'tts_running' | 'succeeded' | 'failed'
  progressText: string
  errorDetail: string | null
  createdAt: string
  finishedAt: string | null
}

export interface CalendarDaySummary {
  total: number
  done: number
  minutes: number
  evalScore: number | null
  badgeRank: string | null
}

export interface DailyEvaluation {
  childId: string
  evalDate: string
  totalScore: number
  dimensionScores: {
    completion: number
    focus: number
    quality: number
    habit: number
  }
  badgeRank: string
  badgeTitle: string
  childCommentarySentences: string[]
  ttsAudioUrl: string | null
  parentSummary: string
  weakPoints: string[]
  tomorrowTips: string[]
  hasNewProgress: boolean
  updatedAt: string
}

export interface AuditLogItem {
  ts: string
  level: 'INFO' | 'WARNING' | 'ERROR'
  event: string
  message: string
  requestId: string
  clientIp: string
  device: string
  childId?: string
  taskId?: string
  durationMs?: number
  elapsedMs?: number
  errorDetail?: string
  traceback?: string
}

export interface AuditLogResponse {
  summary: {
    totalEvents: number
    errorCount: number
    warnCount: number
    todayEvents: number
    logDir?: string
  }
  items: AuditLogItem[]
}

export interface DictionaryCharStroke {
  char: string
  radical: string
  totalStrokes: number
  strokeOrder: string
}

export interface DictionarySense {
  index: number
  pos: string
  zhMeaning: string
  enMeaning: string
  example: string
}

export interface DictionaryEntry {
  entryId: string
  regionIndex: number
  cropImageUrl: string | null
  unrecognized: boolean
  unrecognizedReason: string | null
  paintedRawText: string
  guessedCorrection: boolean
  guessExplanation: string | null
  sourceLanguage: 'zh' | 'en'
  headword: string
  chineseWord: string
  pinyin: string
  chineseAudioUrl: string | null
  englishWord: string
  ipa: string
  englishAudioUrl: string | null
  charStrokes: DictionaryCharStroke[]
  senses: DictionarySense[]
  synonyms: string[]
  antonyms: string[]
}

export interface DictionaryLookup {
  id: string
  childId: string
  instruction: string
  rawImageUrl: string
  previewImageUrl: string
  entries: DictionaryEntry[]
  createdAt: string
}

export type AttentionStateKey =
  | 'focused'
  | 'distracted'
  | 'drowsy'
  | 'near_posture'
  | 'away'

export interface AttentionSegmentItem {
  segmentIndex: number
  startOffsetSec: number
  durationSec: number
  presentSec: number
  focusedSec: number
  distractedSec: number
  drowsySec: number
  nearPostureSec: number
  awaySec: number
  avgDistanceCm: number
  dominantState: AttentionStateKey
}

export interface TaskAttentionSummary {
  taskId: string
  title: string
  subject: SubjectKey
  plannedStartTime: string
  updatedAt: string
  status: string
  trackedSec: number
  presentSec: number
  focusedSec: number
  distractedSec: number
  drowsySec: number
  nearPostureSec: number
  awaySec: number
  avgDistanceCm: number
  focusRatePct: number
  presentRatePct: number
  segments: AttentionSegmentItem[]
}

export interface DailyAttentionReport {
  childId: string
  date: string
  totalTrackedSec: number
  presentSec: number
  focusedSec: number
  distractedSec: number
  drowsySec: number
  nearPostureSec: number
  awaySec: number
  avgDistanceCm: number
  presentRatePct: number
  focusRatePct: number
  tasks: TaskAttentionSummary[]
}
