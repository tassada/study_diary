import { useState } from 'react'
import { GirlAvatarSprite, PixelStarBadge, StellaTeacherSprite } from '../components/PixelSprites'
import { speakStellaSentences } from '../services/pixelAudio'
import type { AsyncJobInfo, ChildProfile, DailyEvaluation, StudyTask } from '../types/study'

interface StellaCompanionSidePanelProps {
  girl: ChildProfile
  selectedDate: string
  dayTasks: StudyTask[]
  dayEvaluation: DailyEvaluation | null
  dailyEvalJob: AsyncJobInfo | null
  onGenerateDailyEval: () => void
  onOpenDailyEvalModal: () => void
  onOpenVoiceCreator: () => void
}

export function StellaCompanionSidePanel({
  girl,
  selectedDate,
  dayTasks,
  dayEvaluation,
  dailyEvalJob,
  onGenerateDailyEval,
  onOpenDailyEvalModal,
  onOpenVoiceCreator,
}: StellaCompanionSidePanelProps) {
  const [isTalking, setIsTalking] = useState(false)

  const completedTasks = dayTasks.filter((t) => t.status === 'completed')
  const totalMinutes = Math.round(
    completedTasks.reduce((acc, t) => acc + t.actualDurationSec, 0) / 60,
  )
  const avgTaskScore =
    completedTasks.length > 0
      ? Math.round(
          completedTasks.reduce((acc, t) => acc + (t.earnedScore ?? 0), 0) /
            completedTasks.length,
        )
      : 0
  const goalPct = Math.min(
    100,
    Math.round((totalMinutes / Math.max(1, girl.dailyGoalMinutes)) * 100),
  )

  const isEvalRunning =
    dailyEvalJob !== null &&
    dailyEvalJob.status !== 'succeeded' &&
    dailyEvalJob.status !== 'failed'

  const liveBubbleText = isEvalRunning
    ? `⏳ ${dailyEvalJob?.progressText}`
    : dayEvaluation !== null
      ? dayEvaluation.hasNewProgress
        ? `哇！${girl.displayName}刚才又有新的作业完成或错题订正加分啦！快点下方按钮让我更新今日 100 分总评吧！`
        : `${girl.displayName}在 ${selectedDate} 赢得了 ${dayEvaluation.totalScore} 分（${dayEvaluation.badgeTitle}）！点下方大按钮听我完整语音讲评吧！`
      : completedTasks.length === 0
        ? `嗨，${girl.displayName}！我是你的专属伴学老师 Stella。今天想先挑战哪一项，用麦克风告诉我吧！`
        : completedTasks.length < dayTasks.length
          ? `太棒啦！${girl.displayName}已完成 ${completedTasks.length}/${dayTasks.length} 项任务（单科均分 ${avgTaskScore} 分），全部完成后就能领今日总评勋章啦！`
          : `今天计划的 ${dayTasks.length} 项任务全部完成啦！快点下方黄色按钮，让我结合你的长期记忆本生成今日总评吧！`

  const handlePlayBubble = () => {
    setIsTalking(true)
    speakStellaSentences(
      [liveBubbleText],
      1.0,
      () => undefined,
      () => setIsTalking(false),
    )
  }

  return (
    <aside className="h-full flex flex-col justify-between gap-3.5">
      <div className="pixel-card-pink p-4 shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <div className="border-3 border-[#4A2B44] bg-[#FFFDF9] p-1 rounded">
            <GirlAvatarSprite avatar={girl.avatarKey} size={50} />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="text-[20px] font-extrabold text-[#332230]">
                {girl.displayName}的能量水晶
              </span>
              <span className="text-[14px] bg-[#FFFDF9] border-2 border-[#4A2B44] px-2.5 py-0.5 font-num font-bold rounded">
                {selectedDate}
              </span>
            </div>
            <div className="text-[14px] font-semibold text-[#664660] mt-0.5">
              {girl.titleBadge}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 text-center mb-3">
          <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-2.5">
            <div className="text-[14px] font-bold text-[#5C4056]">今日完成</div>
            <div className="font-num text-[22px] font-extrabold text-[#C92A6A] mt-0.5">
              {completedTasks.length}/{dayTasks.length}
            </div>
          </div>
          <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-2.5">
            <div className="text-[14px] font-bold text-[#5C4056]">有效时长</div>
            <div className="font-num text-[22px] font-extrabold text-[#2563EB] mt-0.5">
              {totalMinutes}分钟
            </div>
          </div>
          <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-2.5">
            <div className="text-[14px] font-bold text-[#5C4056]">任务均分</div>
            <div className="font-num text-[22px] font-extrabold text-[#B56B00] mt-0.5">
              {completedTasks.length > 0 ? `${avgTaskScore}分` : '—'}
            </div>
          </div>
        </div>

        <div>
          <div className="flex justify-between text-[14px] font-bold text-[#332230] mb-1.5">
            <span>今日专注目标（{girl.dailyGoalMinutes}分钟）</span>
            <span className="font-num">{goalPct}%</span>
          </div>
          <div className="h-5 bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-0.5">
            <div
              className="h-full bg-[#EC5F9B] rounded-xs transition-all duration-300"
              style={{ width: `${goalPct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="pixel-card-lavender p-4 flex-1 min-h-0 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className="bg-[#FFFDF9] border-3 border-[#4A2B44] p-1.5 rounded">
                <StellaTeacherSprite talking={isTalking || isEvalRunning} size={50} />
              </div>
              <div>
                <div className="font-extrabold text-[19px] text-[#332230]">
                  🌟 海星伴学老师
                </div>
                <div className="text-[13px] font-semibold text-[#5E3F8A] mt-0.5">
                  温柔陪伴 · 错题精讲与成长总结
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handlePlayBubble}
              className="pixel-btn bg-[#FFE484] px-3 py-1.5 text-[14px] font-extrabold text-[#332230] shrink-0"
            >
              🔊 读给我听
            </button>
          </div>

          <div className="mt-3 bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-3.5 text-[16px] font-medium leading-relaxed text-[#332230]">
            “{liveBubbleText}”
          </div>
        </div>

        <div className="space-y-2.5 pt-3">
          {dayEvaluation ? (
            <div className="bg-[#FFF8DF] border-3 border-[#4A2B44] rounded p-3">
              {dayEvaluation.hasNewProgress && (
                <div className="mb-2 bg-[#ECFDF3] border-2 border-[#1E7A55] rounded px-2.5 py-1 text-[13px] font-extrabold text-[#104530]">
                  ✨ 检测到新订正或新完成任务，可一键更新今日总评！
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] bg-[#EC5F9B] text-white px-2 py-0.5 border border-[#4A2B44] font-num font-extrabold rounded">
                    {dayEvaluation.badgeRank}
                  </span>
                  <span className="font-extrabold text-[17px] text-[#332230]">
                    {dayEvaluation.badgeTitle}
                  </span>
                </div>
                <span className="font-num text-[24px] font-extrabold text-[#C92A6A]">
                  {dayEvaluation.totalScore}分
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onOpenDailyEvalModal}
                  className="pixel-btn flex-1 bg-[#EC5F9B] text-white py-2 px-3 text-[16px] font-extrabold h-[48px]"
                >
                  🏆 查看成绩单 & 讲评
                </button>
                <button
                  type="button"
                  disabled={isEvalRunning}
                  onClick={onGenerateDailyEval}
                  className={`pixel-btn py-2 px-3 text-[15px] font-extrabold h-[48px] ${
                    dayEvaluation.hasNewProgress
                      ? 'bg-[#52CE9B] text-[#104530]'
                      : 'bg-[#FFFDF9] text-[#332230]'
                  }`}
                >
                  {isEvalRunning ? '⏳ 评定中' : '🔄 更新总评'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={completedTasks.length === 0 || isEvalRunning}
              onClick={onGenerateDailyEval}
              className="pixel-btn w-full bg-[#FFE484] text-[#332230] py-3 px-4 text-[17px] font-extrabold h-[56px] flex items-center justify-center gap-2"
            >
              <PixelStarBadge size={19} />
              <span>
                {isEvalRunning
                  ? '⏳ 正在生成今日总评...'
                  : completedTasks.length === 0
                    ? '完成任务后解锁今日总评'
                    : '🌟 生成今日总评 & 语音讲评'}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenVoiceCreator}
            className="pixel-btn w-full bg-[#FFFDF9] text-[#332230] py-2 px-4 text-[16px] font-bold h-[48px]"
          >
            🎙️ 语音再加一个学习任务
          </button>
        </div>
      </div>
    </aside>
  )
}
