export interface BoxAnnotation {
  kind: 'box'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface StrokeAnnotation {
  kind: 'stroke'
  id: string
  tool: 'brush' | 'eraser'
  width: number
  points: Array<{ x: number; y: number }>
}

export type DictionaryAnnotation = BoxAnnotation | StrokeAnnotation

export interface ExtractedDictionaryRegion {
  box1000: [number, number, number, number]
  pxBox: [number, number, number, number]
  source: 'box' | 'stroke'
}

export function normalizeBoxCoords(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  maxW: number,
  maxH: number,
): [number, number, number, number] {
  const x1 = Math.max(0, Math.min(maxW, Math.min(ax, bx)))
  const y1 = Math.max(0, Math.min(maxH, Math.min(ay, by)))
  const x2 = Math.max(0, Math.min(maxW, Math.max(ax, bx)))
  const y2 = Math.max(0, Math.min(maxH, Math.max(ay, by)))
  return [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)]
}

export function rotateCanvas90Cw(source: HTMLCanvasElement): HTMLCanvasElement {
  const rotated = document.createElement('canvas')
  rotated.width = source.height
  rotated.height = source.width
  const ctx = rotated.getContext('2d')
  if (ctx) {
    ctx.translate(rotated.width, 0)
    ctx.rotate(Math.PI / 2)
    ctx.drawImage(source, 0, 0)
  }
  return rotated
}

export function renderStrokeMaskLayer(
  width: number,
  height: number,
  actions: DictionaryAnnotation[],
): HTMLCanvasElement {
  const layer = document.createElement('canvas')
  layer.width = Math.max(1, width)
  layer.height = Math.max(1, height)
  const ctx = layer.getContext('2d')
  if (!ctx) return layer

  for (const act of actions) {
    if (act.kind !== 'stroke' || act.points.length === 0) continue
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = act.width
    if (act.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.fillStyle = 'rgba(0,0,0,1)'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = '#FFE600'
      ctx.fillStyle = '#FFE600'
    }

    const first = act.points[0]
    if (act.points.length === 1) {
      ctx.beginPath()
      ctx.arc(first.x, first.y, act.width / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < act.points.length; i += 1) {
        ctx.lineTo(act.points[i].x, act.points[i].y)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
  return layer
}

function extractConnectedStrokeRegions(
  paintLayer: HTMLCanvasElement,
  fullW: number,
  fullH: number,
): ExtractedDictionaryRegion[] {
  if (fullW <= 0 || fullH <= 0) return []
  const gw = Math.min(360, fullW)
  const gh = Math.max(1, Math.round((gw * fullH) / fullW))
  const sample = document.createElement('canvas')
  sample.width = gw
  sample.height = gh
  const sctx = sample.getContext('2d')
  if (!sctx) return []
  sctx.drawImage(paintLayer, 0, 0, gw, gh)
  const rgba = sctx.getImageData(0, 0, gw, gh).data

  const active = new Uint8Array(gw * gh)
  let anyInk = false
  for (let i = 0; i < gw * gh; i += 1) {
    if (rgba[i * 4 + 3] > 28) {
      active[i] = 1
      anyInk = true
    }
  }
  if (!anyInk) return []

  const dilated = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      if (!active[y * gw + x]) continue
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= gh) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          if (nx >= 0 && nx < gw) {
            dilated[ny * gw + nx] = 1
          }
        }
      }
    }
  }

  const visited = new Uint8Array(gw * gh)
  const queueX = new Int32Array(gw * gh)
  const queueY = new Int32Array(gw * gh)
  const found: ExtractedDictionaryRegion[] = []

  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const startIdx = y * gw + x
      if (!dilated[startIdx] || visited[startIdx]) continue
      visited[startIdx] = 1
      let head = 0
      let tail = 0
      queueX[tail] = x
      queueY[tail] = y
      tail += 1

      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let area = 0

      while (head < tail) {
        const cx = queueX[head]
        const cy = queueY[head]
        head += 1
        area += 1
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy

        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = cy + dy
          if (ny < 0 || ny >= gh) continue
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx
            if (nx < 0 || nx >= gw) continue
            const nIdx = ny * gw + nx
            if (dilated[nIdx] && !visited[nIdx]) {
              visited[nIdx] = 1
              queueX[tail] = nx
              queueY[tail] = ny
              tail += 1
            }
          }
        }
      }

      if (area >= 5) {
        const b1000: [number, number, number, number] = [
          Math.max(0, Math.min(1000, Math.floor((minX * 1000) / gw))),
          Math.max(0, Math.min(1000, Math.floor((minY * 1000) / gh))),
          Math.max(0, Math.min(1000, Math.ceil(((maxX + 1) * 1000) / gw))),
          Math.max(0, Math.min(1000, Math.ceil(((maxY + 1) * 1000) / gh))),
        ]
        const pxBox: [number, number, number, number] = [
          Math.round((b1000[0] * fullW) / 1000),
          Math.round((b1000[1] * fullH) / 1000),
          Math.round((b1000[2] * fullW) / 1000),
          Math.round((b1000[3] * fullH) / 1000),
        ]
        if (b1000[2] > b1000[0] && b1000[3] > b1000[1]) {
          found.push({ box1000: b1000, pxBox, source: 'stroke' })
        }
      }
    }
  }

  return found
}

export function extractAllDictionaryRegions(
  width: number,
  height: number,
  actions: DictionaryAnnotation[],
  prebuiltPaintLayer?: HTMLCanvasElement,
): ExtractedDictionaryRegion[] {
  if (width <= 0 || height <= 0) return []
  const regions: ExtractedDictionaryRegion[] = []

  for (const act of actions) {
    if (act.kind !== 'box') continue
    const [x1, y1, x2, y2] = normalizeBoxCoords(act.x1, act.y1, act.x2, act.y2, width, height)
    if (x2 - x1 < 8 || y2 - y1 < 8) continue
    const box1000: [number, number, number, number] = [
      Math.max(0, Math.min(1000, Math.round((x1 * 1000) / width))),
      Math.max(0, Math.min(1000, Math.round((y1 * 1000) / height))),
      Math.max(0, Math.min(1000, Math.round((x2 * 1000) / width))),
      Math.max(0, Math.min(1000, Math.round((y2 * 1000) / height))),
    ]
    if (box1000[2] > box1000[0] && box1000[3] > box1000[1]) {
      regions.push({
        box1000,
        pxBox: [x1, y1, x2, y2],
        source: 'box',
      })
    }
  }

  const paintLayer = prebuiltPaintLayer ?? renderStrokeMaskLayer(width, height, actions)
  const strokeRegions = extractConnectedStrokeRegions(paintLayer, width, height)
  regions.push(...strokeRegions)

  regions.sort((a, b) => {
    const rowA = Math.floor(a.box1000[1] / 45)
    const rowB = Math.floor(b.box1000[1] / 45)
    if (rowA !== rowB) return rowA - rowB
    return a.box1000[0] - b.box1000[0]
  })

  return regions.slice(0, 8)
}

function drawRegionBadge(
  ctx: CanvasRenderingContext2D,
  label: string,
  anchorX: number,
  anchorY: number,
  canvasW: number,
) {
  const longest = Math.max(800, canvasW)
  const fontPx = Math.max(14, Math.round((18 * longest) / 1300))
  const padX = Math.round(fontPx * 0.42)
  const badgeH = Math.round(fontPx * 1.38)
  ctx.save()
  ctx.font = `900 ${fontPx}px sans-serif`
  const textW = Math.ceil(ctx.measureText(label).width)
  const badgeW = textW + padX * 2
  const bx = Math.max(2, Math.min(canvasW - badgeW - 2, anchorX))
  const by = anchorY >= badgeH + 4 ? anchorY - badgeH - 2 : anchorY + 2
  ctx.fillStyle = '#E11D48'
  ctx.fillRect(bx, by, badgeW, badgeH)
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = Math.max(1.5, fontPx * 0.1)
  ctx.strokeRect(bx, by, badgeW, badgeH)
  ctx.fillStyle = '#FFFFFF'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, bx + padX, by + badgeH / 2 + 1)
  ctx.restore()
}

export function compositePixelBakedDictionaryCanvas(
  targetCanvas: HTMLCanvasElement,
  baseCanvas: HTMLCanvasElement,
  actions: DictionaryAnnotation[],
  draftBox: [number, number, number, number] | null,
): ExtractedDictionaryRegion[] {
  const w = baseCanvas.width
  const h = baseCanvas.height
  if (w <= 0 || h <= 0) return []
  if (targetCanvas.width !== w || targetCanvas.height !== h) {
    targetCanvas.width = w
    targetCanvas.height = h
  }
  const ctx = targetCanvas.getContext('2d')
  if (!ctx) return []

  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(baseCanvas, 0, 0, w, h)

  const paintLayer = renderStrokeMaskLayer(w, h, actions)
  ctx.save()
  ctx.globalAlpha = 0.46
  ctx.globalCompositeOperation = 'source-over'
  ctx.drawImage(paintLayer, 0, 0, w, h)
  ctx.restore()

  const borderPx = Math.max(3, Math.round((4.5 * Math.max(800, w, h)) / 1300))
  const regions = extractAllDictionaryRegions(w, h, actions, paintLayer)

  for (let i = 0; i < regions.length; i += 1) {
    const reg = regions[i]
    const [x1, y1, x2, y2] = reg.pxBox
    if (reg.source === 'box') {
      ctx.save()
      ctx.fillStyle = 'rgba(255, 230, 0, 0.14)'
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
      ctx.strokeStyle = '#E11D48'
      ctx.lineWidth = borderPx
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
      ctx.restore()
    }
    drawRegionBadge(ctx, `#${i + 1}`, x1, y1, w)
  }

  if (draftBox) {
    const [dx1, dy1, dx2, dy2] = draftBox
    if (dx2 - dx1 >= 3 && dy2 - dy1 >= 3) {
      ctx.save()
      ctx.fillStyle = 'rgba(255, 230, 0, 0.18)'
      ctx.fillRect(dx1, dy1, dx2 - dx1, dy2 - dy1)
      ctx.strokeStyle = '#E11D48'
      ctx.lineWidth = borderPx
      ctx.setLineDash([borderPx * 2, borderPx * 1.4])
      ctx.strokeRect(dx1, dy1, dx2 - dx1, dy2 - dy1)
      ctx.restore()
    }
  }

  return regions
}

export function findHitBoxId(
  actions: DictionaryAnnotation[],
  pt: { x: number; y: number },
  tolerancePx: number,
): string | null {
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const act = actions[i]
    if (act.kind !== 'box') continue
    const minX = Math.min(act.x1, act.x2) - tolerancePx
    const maxX = Math.max(act.x1, act.x2) + tolerancePx
    const minY = Math.min(act.y1, act.y2) - tolerancePx
    const maxY = Math.max(act.y1, act.y2) + tolerancePx
    if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) {
      return act.id
    }
  }
  return null
}

export function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('无法导出标记图像'))
        }
      },
      'image/jpeg',
      quality,
    )
  })
}
