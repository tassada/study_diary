import { useCallback, useEffect, useRef, useState } from 'react'
import { sendClientErrorLog } from '../services/clientErrorReporter'
import { encodePcm16MonoWav } from '../services/pixelAudio'

export interface RecordedVoicePayload {
  wavBlob: Blob
  audioUrl: string
  durationMs: number
  liveTranscript: string
}

interface BrowserSpeechRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

export function usePixelVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [durationSec, setDurationSec] = useState(0)
  const [waveBars, setWaveBars] = useState<number[]>([20, 35, 50, 35, 25, 45, 30, 20])
  const [liveTranscript, setLiveTranscript] = useState('')
  const [recorderError, setRecorderError] = useState<string | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const startMsRef = useRef<number>(0)
  const timerIdRef = useRef<number | null>(null)
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const transcriptRef = useRef<string>('')

  const cleanup = useCallback(() => {
    if (timerIdRef.current !== null) {
      window.clearInterval(timerIdRef.current)
      timerIdRef.current = null
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        recognitionRef.current = null
      }
      recognitionRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close()
      audioCtxRef.current = null
    }
  }, [])

  useEffect(() => cleanup, [cleanup])

  const startRecording = useCallback(async () => {
    setRecorderError(null)
    setLiveTranscript('')
    transcriptRef.current = ''
    chunksRef.current = []

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = '当前为非加密连接，请使用 HTTPS 安全地址或原生 App 访问并授权麦克风权限后使用语音功能'
      setRecorderError(msg)
      sendClientErrorLog({ category: 'mic_unavailable', message: msg })
      return false
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      audioCtxRef.current = ctx

      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        chunksRef.current.push(new Float32Array(input))

        let sum = 0
        for (let i = 0; i < input.length; i += 64) {
          sum += Math.abs(input[i])
        }
        const avg = Math.min(1, (sum / (input.length / 64)) * 6)
        setWaveBars(
          Array.from({ length: 8 }, (_, idx) =>
            Math.max(16, Math.min(96, Math.round(avg * 80 + ((idx * 17) % 28)))),
          ),
        )
      }

      source.connect(processor)
      processor.connect(ctx.destination)

      const SpeechRecCtor =
        (window as unknown as { SpeechRecognition?: new () => BrowserSpeechRecognition; webkitSpeechRecognition?: new () => BrowserSpeechRecognition })
          .SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: new () => BrowserSpeechRecognition }).webkitSpeechRecognition

      if (SpeechRecCtor) {
        const rec = new SpeechRecCtor()
        rec.lang = 'zh-CN'
        rec.continuous = true
        rec.interimResults = true
        rec.onresult = (ev) => {
          let built = ''
          for (let i = 0; i < ev.results.length; i += 1) {
            built += ev.results[i][0].transcript
          }
          transcriptRef.current = built
          setLiveTranscript(built)
        }
        rec.onerror = () => undefined
        try {
          rec.start()
          recognitionRef.current = rec
        } catch {
          recognitionRef.current = null
        }
      }

      startMsRef.current = Date.now()
      setDurationSec(0)
      setIsRecording(true)
      timerIdRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startMsRef.current) / 1000)
        setDurationSec(elapsed)
      }, 250)
      return true
    } catch (err) {
      const msg = '未获得麦克风权限或设备正在占用中，请在浏览器设置中允许麦克风访问后重试'
      setRecorderError(msg)
      sendClientErrorLog({
        category: 'mic_permission_error',
        message: err instanceof Error ? `${msg}: ${err.message}` : msg,
      })
      cleanup()
      return false
    }
  }, [cleanup])

  const stopRecording = useCallback((): RecordedVoicePayload | null => {
    if (!isRecording) return null
    const sampleRate = audioCtxRef.current?.sampleRate ?? 44100
    const durationMs = Math.max(800, Date.now() - startMsRef.current)
    const totalLen = chunksRef.current.reduce((acc, arr) => acc + arr.length, 0)
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const chunk of chunksRef.current) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    cleanup()
    setIsRecording(false)

    const wavBlob = encodePcm16MonoWav(merged, sampleRate)
    const audioUrl = URL.createObjectURL(wavBlob)
    return {
      wavBlob,
      audioUrl,
      durationMs,
      liveTranscript: transcriptRef.current.trim(),
    }
  }, [cleanup, isRecording])

  return {
    isRecording,
    durationSec,
    waveBars,
    liveTranscript,
    recorderError,
    startRecording,
    stopRecording,
  }
}
