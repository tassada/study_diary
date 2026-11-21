import { useEffect, useState, type ReactNode } from 'react'

export const LOCKED_STAGE_WIDTH = 1280
export const LOCKED_STAGE_HEIGHT = 800

interface ViewportMetrics {
  vw: number
  vh: number
}

export function LockedLandscapeStage({ children }: { children: ReactNode }) {
  const [metrics, setMetrics] = useState<ViewportMetrics>(() => ({
    vw: typeof window !== 'undefined' ? window.innerWidth : LOCKED_STAGE_WIDTH,
    vh: typeof window !== 'undefined' ? window.innerHeight : LOCKED_STAGE_HEIGHT,
  }))

  useEffect(() => {
    const updateSize = () => {
      setMetrics({
        vw: window.innerWidth,
        vh: window.innerHeight,
      })
    }

    const tryLockNativeOrientation = () => {
      const orientationApi = window.screen?.orientation as
        | (ScreenOrientation & { lock?: (mode: 'landscape') => Promise<void> })
        | undefined
      if (orientationApi?.lock) {
        orientationApi.lock('landscape').catch(() => undefined)
      }
    }

    tryLockNativeOrientation()
    window.addEventListener('resize', updateSize)
    window.addEventListener('orientationchange', updateSize)
    return () => {
      window.removeEventListener('resize', updateSize)
      window.removeEventListener('orientationchange', updateSize)
    }
  }, [])

  const isPhysicalPortrait = metrics.vw < metrics.vh
  const scale = isPhysicalPortrait
    ? Math.min(metrics.vh / LOCKED_STAGE_WIDTH, metrics.vw / LOCKED_STAGE_HEIGHT)
    : Math.min(metrics.vw / LOCKED_STAGE_WIDTH, metrics.vh / LOCKED_STAGE_HEIGHT)

  const transformExpr = isPhysicalPortrait
    ? `translate(-50%, -50%) rotate(90deg) scale(${scale})`
    : `translate(-50%, -50%) scale(${scale})`

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#E5D4DF]">
      <div
        style={{
          width: `${LOCKED_STAGE_WIDTH}px`,
          height: `${LOCKED_STAGE_HEIGHT}px`,
          position: 'absolute',
          left: '50%',
          top: '50%',
          transformOrigin: 'center center',
          transform: transformExpr,
        }}
        className="eye-gingham-stage border-4 border-[#4A2B44] shadow-[0_12px_36px_rgba(51,34,48,0.22)] overflow-hidden flex flex-col"
      >
        {children}
      </div>
    </div>
  )
}
