import { useRef, useState } from 'react'
import { GirlAvatarSprite, PixelStarBadge } from '../components/PixelSprites'
import type { ChildProfile } from '../types/study'

interface TopRibbonBarProps {
  activeGirl: ChildProfile
  soundEnabled: boolean
  onBackToChildGate: () => void
  onOpenDictionary: () => void
  onToggleSound: () => void
  onOpenParentBoard: () => void
}

export function TopRibbonBar({
  activeGirl,
  soundEnabled,
  onBackToChildGate,
  onOpenDictionary,
  onToggleSound,
  onOpenParentBoard,
}: TopRibbonBarProps) {
  const [holdProgress, setHoldProgress] = useState(0)
  const holdTimerRef = useRef<number | null>(null)

  const startParentHold = () => {
    if (holdTimerRef.current !== null) return
    const started = Date.now()
    holdTimerRef.current = window.setInterval(() => {
      const pct = Math.min(100, Math.round(((Date.now() - started) / 1100) * 100))
      setHoldProgress(pct)
      if (pct >= 100) {
        if (holdTimerRef.current !== null) {
          window.clearInterval(holdTimerRef.current)
          holdTimerRef.current = null
        }
        setHoldProgress(0)
        onOpenParentBoard()
      }
    }, 40)
  }

  const cancelParentHold = () => {
    if (holdTimerRef.current !== null) {
      window.clearInterval(holdTimerRef.current)
      holdTimerRef.current = null
    }
    setHoldProgress(0)
  }

  const toggleFullscreenLandscape = () => {
    if (!document.fullscreenElement) {
      document.documentElement
        .requestFullscreen?.()
        .then(() => {
          const ori = window.screen?.orientation as
            | (ScreenOrientation & { lock?: (mode: 'landscape') => Promise<void> })
            | undefined
          ori?.lock?.('landscape').catch(() => undefined)
        })
        .catch(() => undefined)
    } else {
      document.exitFullscreen?.().catch(() => undefined)
    }
  }

  return (
    <header className="pixel-card-pink h-[76px] px-4 flex items-center justify-between gap-3 shrink-0 whitespace-nowrap">
      <div className="flex items-center gap-3 shrink-0">
        <div className="bg-[#EC5F9B] border-3 border-[#4A2B44] px-3.5 py-2 text-white shadow-[2px_2px_0_#4A2B44] rounded shrink-0">
          <span className="text-[19px] font-extrabold tracking-wide">★ 星莓伴学</span>
        </div>

        <div className="flex items-center gap-2.5 bg-[#FFE484] border-3 border-[#4A2B44] rounded px-3 py-1 h-[54px]">
          <div className="border-2 border-[#4A2B44] bg-white shrink-0">
            <GirlAvatarSprite avatar={activeGirl.avatarKey} size={36} />
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-1.5 text-[18px] font-extrabold text-[#332230]">
              <span>{activeGirl.displayName}</span>
              <span className="text-[13px] bg-[#EC5F9B] text-white px-1.5 py-0.5 rounded font-bold leading-none">
                {activeGirl.gradeLabel}
              </span>
            </div>
            <div className="text-[13px] font-bold text-[#5C4056] flex items-center gap-2 mt-0.5 font-num">
              <span>🎂 {activeGirl.birthDate}</span>
              <span className="text-[#B56B00] flex items-center gap-0.5">
                <PixelStarBadge size={12} />
                {activeGirl.starCoins} 币
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onBackToChildGate}
          className="pixel-btn bg-[#FFFDF9] px-3.5 h-[46px] inline-flex items-center text-[15px] font-extrabold text-[#332230]"
        >
          ⇄ 切换儿童
        </button>
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={onOpenDictionary}
          className="pixel-btn bg-[#FFE484] px-4 h-[46px] inline-flex items-center gap-1.5 text-[16px] font-extrabold text-[#332230]"
        >
          <span>📖 查字典</span>
        </button>

        {typeof window !== 'undefined' && window.location.protocol !== 'capacitor:' && (
          <button
            type="button"
            onClick={toggleFullscreenLandscape}
            className="pixel-btn bg-[#FFFDF9] px-3.5 h-[46px] inline-flex items-center text-[15px] font-extrabold text-[#332230]"
          >
            ⛶ 全屏
          </button>
        )}

        <button
          type="button"
          onClick={onToggleSound}
          className="pixel-btn bg-[#FFFDF9] px-3.5 h-[46px] inline-flex items-center text-[15px] font-extrabold text-[#332230]"
        >
          {soundEnabled ? '🔔 音效' : '🔕 静音'}
        </button>

        <button
          type="button"
          onMouseDown={startParentHold}
          onMouseUp={cancelParentHold}
          onMouseLeave={cancelParentHold}
          onTouchStart={startParentHold}
          onTouchEnd={cancelParentHold}
          onDoubleClick={onOpenParentBoard}
          className="pixel-btn relative overflow-hidden bg-[#F3ECFC] px-3.5 h-[46px] inline-flex items-center text-[15px] font-extrabold text-[#332230]"
        >
          {holdProgress > 0 && (
            <span
              className="absolute inset-y-0 left-0 bg-[#B685FF]/45 pointer-events-none"
              style={{ width: `${holdProgress}%` }}
            />
          )}
          <span className="relative z-10">🔒 家长屋(长按)</span>
        </button>
      </div>
    </header>
  )
}
