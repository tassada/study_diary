class PixelAudioService {
  private ctx: AudioContext | null = null

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (AudioCtx) {
        this.ctx = new AudioCtx()
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }
    return this.ctx
  }

  playChime(kind: 'tap' | 'sparkle' | 'fanfare' | 'gentle_alarm', enabled: boolean): void {
    if (!enabled) return
    const ctx = this.ensureContext()
    if (!ctx) return

    const notes: Record<typeof kind, number[]> = {
      tap: [659.25, 880],
      sparkle: [587.33, 783.99, 1046.5],
      fanfare: [523.25, 659.25, 783.99, 1046.5, 1318.5],
      gentle_alarm: [783.99, 659.25, 783.99, 987.77],
    }

    const seq = notes[kind]
    const now = ctx.currentTime
    seq.forEach((freq, idx) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, now + idx * 0.085)
      gain.gain.setValueAtTime(0.08, now + idx * 0.085)
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.085 + 0.16)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + idx * 0.085)
      osc.stop(now + idx * 0.085 + 0.17)
    })
  }
}

export const pixelAudio = new PixelAudioService()

export function encodePcm16MonoWav(samples: Float32Array, sampleRate: number): Blob {
  const targetRate = 16000
  const ratio = sampleRate / targetRate
  const newLength = Math.max(1, Math.round(samples.length / ratio))
  const buffer = new ArrayBuffer(44 + newLength * 2)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + newLength * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, newLength * 2, true)

  for (let i = 0; i < newLength; i += 1) {
    const srcIndex = Math.min(samples.length - 1, Math.floor(i * ratio))
    const clamped = Math.max(-1, Math.min(1, samples[srcIndex] ?? 0))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export function speakStellaSentences(
  sentences: string[],
  rate: number,
  onSentenceIndex: (index: number) => void,
  onComplete: () => void,
): () => void {
  if (typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined') {
    let idx = 0
    onSentenceIndex(0)
    const timer = globalThis.setInterval(() => {
      idx += 1
      if (idx >= sentences.length) {
        globalThis.clearInterval(timer)
        onSentenceIndex(-1)
        onComplete()
      } else {
        onSentenceIndex(idx)
      }
    }, 2400)
    return () => globalThis.clearInterval(timer)
  }

  window.speechSynthesis.cancel()
  let cancelled = false
  let current = 0

  const speakNext = () => {
    if (cancelled || current >= sentences.length) {
      if (!cancelled) {
        onSentenceIndex(-1)
        onComplete()
      }
      return
    }

    onSentenceIndex(current)
    const utter = new SpeechSynthesisUtterance(sentences[current])
    utter.lang = 'zh-CN'
    utter.rate = rate
    utter.pitch = 1.15
    utter.onend = () => {
      current += 1
      speakNext()
    }
    utter.onerror = () => {
      current += 1
      speakNext()
    }
    window.speechSynthesis.speak(utter)
  }

  speakNext()

  return () => {
    cancelled = true
    window.speechSynthesis.cancel()
    onSentenceIndex(-1)
  }
}
