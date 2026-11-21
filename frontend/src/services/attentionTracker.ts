import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { AttentionSegmentItem, AttentionStateKey } from '../types/study'
import { studyApi } from './apiClient'

interface NativeAttentionFrameEvent {
  tsMs: number
  present: boolean
  engine?: string
  distanceCm?: number
  blinkPct?: number
  headPitchDeg?: number
  headYawDeg?: number
  gazePitchDeg?: number
  gazeYawDeg?: number
  points?: number[]
}

interface AppleAttentionPluginContract {
  startSession(): Promise<{ started: boolean; engine: string }>
  stopSession(): Promise<{ stopped: boolean }>
  getStatus(): Promise<{ running: boolean; engine: string; trueDepthSupported: boolean }>
  addListener(
    eventName: 'attentionFrame',
    listenerFunc: (frame: NativeAttentionFrameEvent) => void,
  ): Promise<PluginListenerHandle>
}

const AppleAttention = registerPlugin<AppleAttentionPluginContract>('AppleAttention')

const IDB_NAME = 'studydiary_attention_db'
const IDB_VERSION = 1
const IDB_STORE = 'dot_matrix_streams'
const RETENTION_MS = 30 * 24 * 3600 * 1000
const POINT_COUNT = 84
const PRESENT_FRAME_BYTES = 16 + POINT_COUNT * 4
const EMPTY_FRAME_BYTES = 16

const STATE_TO_CODE: Record<AttentionStateKey, number> = {
  away: 0,
  focused: 1,
  distracted: 2,
  drowsy: 3,
  near_posture: 4,
}

const CODE_TO_STATE: Record<number, AttentionStateKey> = {
  0: 'away',
  1: 'focused',
  2: 'distracted',
  3: 'drowsy',
  4: 'near_posture',
}

export interface DecodedAttentionFrame {
  offsetMs: number
  present: boolean
  state: AttentionStateKey
  distanceCm: number
  blinkPct: number
  headPitchDeg: number
  headYawDeg: number
  gazePitchDeg: number
  gazeYawDeg: number
  points: Int16Array | null
}

export interface StoredAttentionStreamRecord {
  taskId: string
  childId: string
  taskDate: string
  taskTitle: string
  byteLength: number
  frameCount: number
  updatedAtMs: number
  buffer: ArrayBuffer
}

function openAttentionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const store = db.createObjectStore(IDB_STORE, { keyPath: 'taskId' })
        store.createIndex('childId', 'childId', { unique: false })
        store.createIndex('updatedAtMs', 'updatedAtMs', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('无法打开本地点阵存储库'))
  })
}

export async function getStoredAttentionStream(
  taskId: string,
): Promise<StoredAttentionStreamRecord | null> {
  if (typeof indexedDB === 'undefined') return null
  const db = await openAttentionDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(taskId)
    req.onsuccess = () => resolve((req.result as StoredAttentionStreamRecord | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function saveStoredAttentionStream(record: StoredAttentionStreamRecord): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openAttentionDb()
  const cutoffMs = Date.now() - RETENTION_MS

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    const store = tx.objectStore(IDB_STORE)
    store.put(record)

    const idx = store.index('updatedAtMs')
    const cursorReq = idx.openCursor(IDBKeyRange.upperBound(cutoffMs))
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getLocalAttentionStorageStats(childId: string): Promise<{
  totalBytes: number
  taskCount: number
  taskBytesMap: Record<string, number>
}> {
  if (typeof indexedDB === 'undefined') {
    return { totalBytes: 0, taskCount: 0, taskBytesMap: {} }
  }
  const db = await openAttentionDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const idx = tx.objectStore(IDB_STORE).index('childId')
    const req = idx.getAll(IDBKeyRange.only(childId))
    req.onsuccess = () => {
      const rows = (req.result as StoredAttentionStreamRecord[]) ?? []
      let totalBytes = 0
      const taskBytesMap: Record<string, number> = {}
      for (const r of rows) {
        totalBytes += r.byteLength
        taskBytesMap[r.taskId] = r.byteLength
      }
      resolve({ totalBytes, taskCount: rows.length, taskBytesMap })
    }
    req.onerror = () => reject(req.error)
  })
}

export async function clearLocalAttentionStreamsForChild(childId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openAttentionDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    const idx = tx.objectStore(IDB_STORE).index('childId')
    const cursorReq = idx.openCursor(IDBKeyRange.only(childId))
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function encodeSingleFrame(
  offsetMs: number,
  state: AttentionStateKey,
  ev: NativeAttentionFrameEvent,
): Uint8Array {
  const isPresent = Boolean(ev.present && ev.points && ev.points.length >= POINT_COUNT * 2)
  const buf = new ArrayBuffer(isPresent ? PRESENT_FRAME_BYTES : EMPTY_FRAME_BYTES)
  const view = new DataView(buf)

  view.setUint32(0, Math.max(0, Math.floor(offsetMs)), true)
  view.setUint8(4, isPresent ? 1 : 0)
  view.setUint8(5, STATE_TO_CODE[state] ?? 1)
  view.setUint8(6, Math.max(0, Math.min(255, Math.round(ev.distanceCm ?? 0))))
  view.setUint8(7, Math.max(0, Math.min(100, Math.round(ev.blinkPct ?? 0))))
  view.setInt16(8, Math.max(-1800, Math.min(1800, Math.round((ev.headPitchDeg ?? 0) * 10))), true)
  view.setInt16(10, Math.max(-1800, Math.min(1800, Math.round((ev.headYawDeg ?? 0) * 10))), true)
  view.setInt16(12, Math.max(-1800, Math.min(1800, Math.round((ev.gazePitchDeg ?? 0) * 10))), true)
  view.setInt16(14, Math.max(-1800, Math.min(1800, Math.round((ev.gazeYawDeg ?? 0) * 10))), true)

  if (isPresent && ev.points) {
    let byteOff = 16
    for (let i = 0; i < POINT_COUNT * 2; i += 1) {
      const v = Math.max(-1000, Math.min(1000, Math.round(ev.points[i] ?? 0)))
      view.setInt16(byteOff, v, true)
      byteOff += 2
    }
  }
  return new Uint8Array(buf)
}

export function decodeAttentionStream(buffer: ArrayBuffer): DecodedAttentionFrame[] {
  const view = new DataView(buffer)
  const frames: DecodedAttentionFrame[] = []
  let pos = 0

  while (pos + EMPTY_FRAME_BYTES <= buffer.byteLength) {
    const offsetMs = view.getUint32(pos, true)
    const present = view.getUint8(pos + 4) === 1
    const stateCode = view.getUint8(pos + 5)
    const distanceCm = view.getUint8(pos + 6)
    const blinkPct = view.getUint8(pos + 7)
    const headPitchDeg = view.getInt16(pos + 8, true) / 10
    const headYawDeg = view.getInt16(pos + 10, true) / 10
    const gazePitchDeg = view.getInt16(pos + 12, true) / 10
    const gazeYawDeg = view.getInt16(pos + 14, true) / 10

    if (!present) {
      frames.push({
        offsetMs,
        present: false,
        state: 'away',
        distanceCm: 0,
        blinkPct: 0,
        headPitchDeg: 0,
        headYawDeg: 0,
        gazePitchDeg: 0,
        gazeYawDeg: 0,
        points: null,
      })
      pos += EMPTY_FRAME_BYTES
      continue
    }

    if (pos + PRESENT_FRAME_BYTES > buffer.byteLength) {
      break
    }

    const pts = new Int16Array(POINT_COUNT * 2)
    let pOff = pos + 16
    for (let i = 0; i < POINT_COUNT * 2; i += 1) {
      pts[i] = view.getInt16(pOff, true)
      pOff += 2
    }

    frames.push({
      offsetMs,
      present: true,
      state: CODE_TO_STATE[stateCode] ?? 'focused',
      distanceCm,
      blinkPct,
      headPitchDeg,
      headYawDeg,
      gazePitchDeg,
      gazeYawDeg,
      points: pts,
    })
    pos += PRESENT_FRAME_BYTES
  }

  return frames
}

export interface SilentAttentionSessionHandle {
  pauseCapture: () => Promise<void>
  resumeCapture: (currentElapsedSec: number) => Promise<void>
  stopAndFlush: (finalElapsedSec: number) => Promise<void>
}

export async function startSilentAttentionTracker(params: {
  taskId: string
  childId: string
  taskDate: string
  taskTitle: string
  initialElapsedSec: number
}): Promise<SilentAttentionSessionHandle> {
  if (!Capacitor.isNativePlatform()) {
    return {
      pauseCapture: async () => undefined,
      resumeCapture: async () => undefined,
      stopAndFlush: async () => undefined,
    }
  }

  const existingRecord = await getStoredAttentionStream(params.taskId).catch(() => null)
  const binaryChunks: Uint8Array[] = existingRecord
    ? [new Uint8Array(existingRecord.buffer)]
    : []
  let totalBytes = existingRecord?.byteLength ?? 0
  let frameCount = existingRecord?.frameCount ?? 0

  let baseOffsetMs = Math.max(0, params.initialElapsedSec * 1000)
  let runStartedPerfMs = performance.now()
  let capturing = false
  let listenerHandle: PluginListenerHandle | null = null

  const recentFrames: NativeAttentionFrameEvent[] = []
  let latestClassifiedState: AttentionStateKey = 'away'
  let closedEyesStreak = 0
  let nearStreak = 0
  let distractedStreak = 0

  let currentSegIdx = Math.floor(params.initialElapsedSec / 60)
  let segStartSec = currentSegIdx * 60
  let segDurSec = 0
  let segPresentSec = 0
  let segFocusedSec = 0
  let segDistractedSec = 0
  let segDrowsySec = 0
  let segNearSec = 0
  let segAwaySec = 0
  let segDistSum = 0
  let segDistCount = 0
  const pendingUploadSegments: AttentionSegmentItem[] = []

  const classifyInstantFrame = (ev: NativeAttentionFrameEvent): AttentionStateKey => {
    if (!ev.present) {
      closedEyesStreak = 0
      nearStreak = 0
      distractedStreak = 0
      return 'away'
    }

    const blink = ev.blinkPct ?? 0
    const dist = ev.distanceCm ?? 42
    const yaw = Math.abs(ev.headYawDeg ?? 0)
    const gazeYaw = Math.abs(ev.gazeYawDeg ?? 0)
    const pitch = ev.headPitchDeg ?? -15

    closedEyesStreak = blink >= 72 ? closedEyesStreak + 1 : 0
    nearStreak = dist > 0 && dist < 28 ? nearStreak + 1 : 0
    distractedStreak = yaw > 28 || gazeYaw > 34 || pitch > 18 ? distractedStreak + 1 : 0

    if (closedEyesStreak >= 8) return 'drowsy'
    if (nearStreak >= 10) return 'near_posture'
    if (distractedStreak >= 6) return 'distracted'
    return 'focused'
  }

  const sealCurrentSegment = () => {
    if (segDurSec <= 0) return
    const counts: Array<[AttentionStateKey, number]> = [
      ['focused', segFocusedSec],
      ['distracted', segDistractedSec],
      ['drowsy', segDrowsySec],
      ['near_posture', segNearSec],
      ['away', segAwaySec],
    ]
    counts.sort((a, b) => b[1] - a[1])
    const dominantState = counts[0][0]

    pendingUploadSegments.push({
      segmentIndex: currentSegIdx,
      startOffsetSec: segStartSec,
      durationSec: segDurSec,
      presentSec: segPresentSec,
      focusedSec: segFocusedSec,
      distractedSec: segDistractedSec,
      drowsySec: segDrowsySec,
      nearPostureSec: segNearSec,
      awaySec: segAwaySec,
      avgDistanceCm: segDistCount > 0 ? Math.round(segDistSum / segDistCount) : 0,
      dominantState,
    })

    currentSegIdx += 1
    segStartSec = currentSegIdx * 60
    segDurSec = 0
    segPresentSec = 0
    segFocusedSec = 0
    segDistractedSec = 0
    segDrowsySec = 0
    segNearSec = 0
    segAwaySec = 0
    segDistSum = 0
    segDistCount = 0
  }

  const persistLocalBinary = async () => {
    if (binaryChunks.length === 0 || totalBytes === 0) return
    const merged = new Uint8Array(totalBytes)
    let off = 0
    for (const chunk of binaryChunks) {
      merged.set(chunk, off)
      off += chunk.byteLength
    }
    binaryChunks.length = 0
    binaryChunks.push(merged)

    await saveStoredAttentionStream({
      taskId: params.taskId,
      childId: params.childId,
      taskDate: params.taskDate,
      taskTitle: params.taskTitle,
      byteLength: totalBytes,
      frameCount,
      updatedAtMs: Date.now(),
      buffer: merged.buffer,
    }).catch(() => undefined)
  }

  const flushSegmentsToServer = async () => {
    if (pendingUploadSegments.length === 0) return
    const batch = pendingUploadSegments.splice(0, pendingUploadSegments.length)
    await studyApi.uploadTaskAttentionSegments(params.taskId, batch).catch(() => {
      pendingUploadSegments.unshift(...batch)
    })
  }

  const secTickTimer = window.setInterval(() => {
    if (!capturing) return
    const windowFrames = recentFrames.splice(0, recentFrames.length)
    let state: AttentionStateKey = 'away'
    let avgDist = 0

    if (windowFrames.length > 0) {
      const presentOnes = windowFrames.filter((f) => f.present)
      if (presentOnes.length * 2 >= windowFrames.length) {
        state = latestClassifiedState === 'away' ? 'focused' : latestClassifiedState
        avgDist = Math.round(
          presentOnes.reduce((acc, x) => acc + (x.distanceCm ?? 42), 0) / presentOnes.length,
        )
      } else {
        state = 'away'
      }
    }

    segDurSec += 1
    if (state !== 'away') {
      segPresentSec += 1
      if (avgDist > 0) {
        segDistSum += avgDist
        segDistCount += 1
      }
    }
    if (state === 'focused') segFocusedSec += 1
    else if (state === 'distracted') segDistractedSec += 1
    else if (state === 'drowsy') segDrowsySec += 1
    else if (state === 'near_posture') segNearSec += 1
    else segAwaySec += 1

    if (segDurSec >= 60) {
      sealCurrentSegment()
      void flushSegmentsToServer()
      void persistLocalBinary()
    }
  }, 1000)

  const beginHardware = async (offsetSec: number) => {
    if (capturing) return
    baseOffsetMs = Math.max(baseOffsetMs, offsetSec * 1000)
    runStartedPerfMs = performance.now()
    if (!listenerHandle) {
      listenerHandle = await AppleAttention.addListener('attentionFrame', (ev) => {
        if (!capturing) return
        recentFrames.push(ev)
        const offsetMs = baseOffsetMs + Math.max(0, performance.now() - runStartedPerfMs)
        const st = classifyInstantFrame(ev)
        latestClassifiedState = st
        const encoded = encodeSingleFrame(offsetMs, st, ev)
        binaryChunks.push(encoded)
        totalBytes += encoded.byteLength
        frameCount += 1
      })
    }
    const res = await AppleAttention.startSession().catch(() => ({
      started: false,
      engine: 'none',
    }))
    capturing = Boolean(res.started)
  }

  await beginHardware(params.initialElapsedSec)

  return {
    pauseCapture: async () => {
      if (!capturing) return
      baseOffsetMs += Math.max(0, performance.now() - runStartedPerfMs)
      capturing = false
      await AppleAttention.stopSession().catch(() => undefined)
      await persistLocalBinary()
      await flushSegmentsToServer()
    },
    resumeCapture: async (currentElapsedSec: number) => {
      await beginHardware(currentElapsedSec)
    },
    stopAndFlush: async () => {
      window.clearInterval(secTickTimer)
      if (capturing) {
        baseOffsetMs += Math.max(0, performance.now() - runStartedPerfMs)
        capturing = false
      }
      if (listenerHandle) {
        await listenerHandle.remove().catch(() => undefined)
        listenerHandle = null
      }
      await AppleAttention.stopSession().catch(() => undefined)
      if (segDurSec >= 2) {
        sealCurrentSegment()
      }
      await persistLocalBinary()
      await flushSegmentsToServer()
    },
  }
}
