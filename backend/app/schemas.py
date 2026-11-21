from pydantic import BaseModel, Field


class ScoringRubricSchema(BaseModel):
    focus: int = 30
    completeness: int = 30
    accuracy: int = 40


class ChildProfileOut(BaseModel):
    id: str
    displayName: str
    birthDate: str
    gender: str
    age: int
    gradeLabel: str
    titleBadge: str
    avatarKey: str
    themePink: str
    dailyGoalMinutes: int
    starCoins: int


class OcrBoxOut(BaseModel):
    id: str
    refLabel: str
    box: list[int]
    statusTag: str


class TaskImageOut(BaseModel):
    id: str
    uploadKind: str
    fileName: str
    imageUrl: str
    width: int
    height: int
    fileSize: int
    ocrStatus: str
    ocrRawText: str
    ocrPlainText: str
    boxes: list[OcrBoxOut]
    ocrProcessedAt: str | None = None
    createdAt: str


class MistakeCardOut(BaseModel):
    id: str
    imageId: str | None
    questionTitle: str
    wrongSnippet: str
    errorCause: str
    correctSteps: list[str]
    practiceQuestion: str
    practiceAnswer: str
    cropImageUrl: str | None
    diagramImageUrl: str | None
    ttsAudioUrl: str | None
    masteryStatus: str


class TaskOut(BaseModel):
    id: str
    childId: str
    taskDate: str
    title: str
    rawVoiceText: str
    voiceAudioUrl: str | None
    plannedStartTime: str
    timerMode: str
    timerLocked: bool
    plannedDurationSec: int
    actualDurationSec: int
    pauseCount: int
    subject: str
    categoryTags: list[str]
    difficulty: int
    maxScore: int = 100
    rewardStars: int
    scoringRubric: ScoringRubricSchema
    scoreHint: str
    initialScore: int | None
    earnedScore: int | None
    revisionCount: int
    aiQuickPraise: str | None
    praiseAudioUrl: str | None
    summaryVoiceText: str
    summaryAudioUrl: str | None
    status: str
    activeStartedAt: str | None
    autoPausedReason: str | None
    latestJobId: str | None
    latestJobStatus: str | None = None
    latestJobError: str | None = None
    images: list[TaskImageOut] = Field(default_factory=list)
    mistakes: list[MistakeCardOut] = Field(default_factory=list)
    updatedAt: str


class VoiceTaskDraftSchema(BaseModel):
    draftId: str
    title: str
    plannedStartTime: str = ""
    timerMode: str
    plannedDurationMinutes: int
    subject: str
    categoryTags: list[str]
    difficulty: int
    rewardStars: int
    scoringRubric: ScoringRubricSchema
    scoreHint: str


class VoiceParseRequest(BaseModel):
    transcript: str
    targetDate: str
    existingDrafts: list[VoiceTaskDraftSchema] | None = None
    isRefinement: bool = False


class VoiceParseResponse(BaseModel):
    transcript: str
    spokenReply: str
    ttsAudioUrl: str | None
    drafts: list[VoiceTaskDraftSchema]


class BatchCreateTasksRequest(BaseModel):
    targetDate: str
    rawTranscript: str
    voiceMinioKey: str | None = None
    drafts: list[VoiceTaskDraftSchema]


class UpdateTaskModeRequest(BaseModel):
    timerMode: str


class SubmitHomeworkTriggerRequest(BaseModel):
    uploadKind: str = "initial"
    summaryVoiceText: str = ""
    summaryAudioKey: str | None = None


class AsyncJobOut(BaseModel):
    id: str
    childId: str
    taskId: str | None
    evalDate: str | None
    jobType: str
    status: str
    progressText: str
    errorDetail: str | None
    createdAt: str
    finishedAt: str | None


class DailyEvaluationOut(BaseModel):
    childId: str
    evalDate: str
    totalScore: int
    dimensionScores: dict[str, int]
    badgeRank: str
    badgeTitle: str
    childCommentarySentences: list[str]
    ttsAudioUrl: str | None
    parentSummary: str
    weakPoints: list[str]
    tomorrowTips: list[str]
    hasNewProgress: bool
    updatedAt: str


class DictionaryCharStrokeOut(BaseModel):
    char: str
    radical: str
    totalStrokes: int
    strokeOrder: str


class DictionarySenseOut(BaseModel):
    index: int
    pos: str = ""
    zhMeaning: str
    enMeaning: str = ""
    example: str = ""


class DictionaryEntryOut(BaseModel):
    entryId: str
    regionIndex: int
    cropImageUrl: str | None = None
    unrecognized: bool = False
    unrecognizedReason: str | None = None
    paintedRawText: str = ""
    guessedCorrection: bool = False
    guessExplanation: str | None = None
    sourceLanguage: str = "zh"
    headword: str = ""
    chineseWord: str = ""
    pinyin: str = ""
    chineseAudioUrl: str | None = None
    englishWord: str = ""
    ipa: str = ""
    englishAudioUrl: str | None = None
    charStrokes: list[DictionaryCharStrokeOut] = Field(default_factory=list)
    senses: list[DictionarySenseOut] = Field(default_factory=list)
    synonyms: list[str] = Field(default_factory=list)
    antonyms: list[str] = Field(default_factory=list)


class DictionaryLookupOut(BaseModel):
    id: str
    childId: str
    instruction: str
    rawImageUrl: str
    previewImageUrl: str
    entries: list[DictionaryEntryOut] = Field(default_factory=list)
    createdAt: str
