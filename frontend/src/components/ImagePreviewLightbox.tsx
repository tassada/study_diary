import { useEffect, useState, type MouseEvent, type WheelEvent } from 'react'

export interface LightboxRotatableTarget {
  kind: 'task_image' | 'mistake_crop'
  id: string
}

export interface LightboxMediaItem {
  key: string
  label: string
  url: string
  subTitle?: string
  sideTitle?: string
  sideBody?: string
  rotatableTarget?: LightboxRotatableTarget
}

interface ImagePreviewLightboxProps {
  items: LightboxMediaItem[]
  initialIndex?: number
  onClose: () => void
  onPersistRotation?: (
    target: LightboxRotatableTarget,
    degreesCw: 90 | 180 | 270,
  ) => Promise<string | void>
}

export function ImagePreviewLightbox({
  items,
  initialIndex = 0,
  onClose,
  onPersistRotation,
}: ImagePreviewLightboxProps) {
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(0, Math.min(items.length - 1, initialIndex)),
  )
  const [rotationByKey, setRotationByKey] = useState<Record<string, number>>({})
  const [urlOverrideByKey, setUrlOverrideByKey] = useState<Record<string, string>>({})
  const [zoom, setZoom] = useState<number>(1)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const [showSidePanel, setShowSidePanel] = useState<boolean>(true)
  const [savingRot, setSavingRot] = useState<boolean>(false)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const current = items[activeIndex] ?? items[0]
  const currentRot = current ? (rotationByKey[current.key] ?? 0) % 360 : 0
  const currentUrl = current ? urlOverrideByKey[current.key] ?? current.url : ''
  const hasSideText = Boolean(current?.sideBody && current.sideBody.trim().length > 0)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowLeft' && items.length > 1) {
        setActiveIndex((prev) => (prev - 1 + items.length) % items.length)
        setZoom(1)
        setPan({ x: 0, y: 0 })
      } else if (e.key === 'ArrowRight' && items.length > 1) {
        setActiveIndex((prev) => (prev + 1) % items.length)
        setZoom(1)
        setPan({ x: 0, y: 0 })
      } else if (e.key === 'r' || e.key === 'R') {
        if (!current) return
        const delta = e.shiftKey ? 270 : 90
        setRotationByKey((prev) => ({
          ...prev,
          [current.key]: ((prev[current.key] ?? 0) + delta) % 360,
        }))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, items.length, onClose])

  if (!current) return null

  const rotateBy = (deltaCw: number) => {
    setSaveNotice(null)
    setRotationByKey((prev) => ({
      ...prev,
      [current.key]: ((prev[current.key] ?? 0) + deltaCw + 360) % 360,
    }))
  }

  const adjustZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.round(Math.max(0.5, Math.min(3.2, prev + delta)) * 100) / 100
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }

  const handleWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    adjustZoom(e.deltaY < 0 ? 0.2 : -0.2)
  }

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (zoom <= 1) return
    e.preventDefault()
    setDragging({
      startX: e.clientX,
      startY: e.clientY,
      origX: pan.x,
      origY: pan.y,
    })
  }

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!dragging) return
    setPan({
      x: dragging.origX + (e.clientX - dragging.startX),
      y: dragging.origY + (e.clientY - dragging.startY),
    })
  }

  const stopDrag = () => setDragging(null)

  const handlePersistRotation = async () => {
    if (!onPersistRotation || !current.rotatableTarget || currentRot === 0) return
    const deg = (currentRot % 360) as 90 | 180 | 270
    setSavingRot(true)
    setSaveNotice(null)
    try {
      const freshUrl = await onPersistRotation(current.rotatableTarget, deg)
      const busted =
        typeof freshUrl === 'string' && freshUrl
          ? freshUrl
          : `${currentUrl.split('?')[0]}?v=${Date.now()}`
      setUrlOverrideByKey((prev) => ({ ...prev, [current.key]: busted }))
      setRotationByKey((prev) => ({ ...prev, [current.key]: 0 }))
      setSaveNotice('✓ 已永久放正原图')
    } catch (err) {
      setSaveNotice(err instanceof Error ? `保存失败：${err.message}` : '保存旋转失败')
    } finally {
      setSavingRot(false)
    }
  }

  const isQuarterTurn = currentRot === 90 || currentRot === 270

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-[2px] flex flex-col p-4 md:p-6 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl border-2 border-slate-800 shadow-2xl w-full h-full flex flex-col overflow-hidden"
      >
        <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {items.map((item, idx) => (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setActiveIndex(idx)
                  setZoom(1)
                  setPan({ x: 0, y: 0 })
                  setSaveNotice(null)
                }}
                className={`px-3 py-1.5 rounded-lg text-xs md:text-sm font-extrabold cursor-pointer transition-colors ${
                  idx === activeIndex
                    ? 'bg-[#EC5F9B] text-white shadow'
                    : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                }`}
              >
                {item.label}
              </button>
            ))}
            {current.subTitle && (
              <span className="text-xs text-slate-300 font-medium truncate max-w-md ml-1">
                {current.subTitle}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => rotateBy(-90)}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs md:text-sm font-bold cursor-pointer"
              title="逆时针旋转 90°"
            >
              ↺ 左转90°
            </button>
            <button
              type="button"
              onClick={() => rotateBy(90)}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs md:text-sm font-bold cursor-pointer"
              title="顺时针旋转 90° (快捷键 R)"
            >
              ↻ 右转90°
            </button>
            <button
              type="button"
              onClick={() => rotateBy(180)}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs md:text-sm font-bold cursor-pointer"
              title="旋转 180°"
            >
              ⇅ 180°
            </button>

            <div className="flex items-center bg-slate-800 rounded-lg px-1 py-0.5 gap-1">
              <button
                type="button"
                onClick={() => adjustZoom(-0.25)}
                className="px-2 py-1 text-xs font-extrabold hover:bg-slate-700 rounded cursor-pointer"
              >
                ➖
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoom(1)
                  setPan({ x: 0, y: 0 })
                }}
                className="px-2 py-1 text-xs font-num font-bold hover:bg-slate-700 rounded cursor-pointer"
                title="点击复位 100%"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => adjustZoom(0.25)}
                className="px-2 py-1 text-xs font-extrabold hover:bg-slate-700 rounded cursor-pointer"
              >
                ➕
              </button>
            </div>

            {onPersistRotation && current.rotatableTarget && currentRot !== 0 && (
              <button
                type="button"
                disabled={savingRot}
                onClick={() => void handlePersistRotation()}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs md:text-sm font-extrabold cursor-pointer"
              >
                {savingRot ? '保存中...' : `💾 保存放正 (${currentRot}°)`}
              </button>
            )}

            {saveNotice && (
              <span className="text-xs font-bold text-emerald-300 px-1.5">{saveNotice}</span>
            )}

            {hasSideText && (
              <button
                type="button"
                onClick={() => setShowSidePanel((v) => !v)}
                className={`px-3 py-1.5 rounded-lg text-xs md:text-sm font-bold cursor-pointer ${
                  showSidePanel ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-200'
                }`}
              >
                {showSidePanel ? '隐藏解析栏' : '显示解析栏'}
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs md:text-sm font-extrabold cursor-pointer"
            >
              ✕ 关闭
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={stopDrag}
            onMouseLeave={stopDrag}
            className={`flex-1 min-w-0 min-h-0 bg-slate-900/95 flex items-center justify-center overflow-hidden relative p-4 ${
              zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''
            }`}
          >
            <img
              src={currentUrl}
              alt={current.label}
              draggable={false}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) rotate(${currentRot}deg) scale(${zoom})`,
                maxWidth: isQuarterTurn ? '76vh' : '100%',
                maxHeight: isQuarterTurn ? '78vw' : '100%',
              }}
              className="object-contain rounded shadow-lg transition-transform duration-150 bg-white select-none"
            />
            <div className="absolute bottom-3 left-4 text-[11px] text-slate-400 bg-slate-950/70 px-2.5 py-1 rounded pointer-events-none">
              滚轮缩放 · 放大后可拖拽平移 · 左/右转90°可随时放正预览
              {currentRot !== 0 ? ` · 当前旋转 ${currentRot}°` : ''}
            </div>
          </div>

          {hasSideText && showSidePanel && (
            <div className="w-80 md:w-96 border-l border-slate-200 bg-white flex flex-col shrink-0 select-text overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 font-extrabold text-sm text-slate-900 bg-slate-50">
                {current.sideTitle || '识别与错题解析'}
              </div>
              <pre className="flex-1 overflow-y-auto p-4 text-sm leading-relaxed whitespace-pre-wrap font-sans text-slate-700">
                {current.sideBody}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
