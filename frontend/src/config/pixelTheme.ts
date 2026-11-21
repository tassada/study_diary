import type { SubjectKey } from '../types/study'

export function getTodayDateStr(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatCnTime(isoStr: string | null | undefined): string {
  if (!isoStr) return '—'
  const dt = new Date(isoStr)
  if (Number.isNaN(dt.getTime())) return isoStr
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dt)
}

export function formatCnDateTime(isoStr: string | null | undefined): string {
  if (!isoStr) return '—'
  const dt = new Date(isoStr)
  if (Number.isNaN(dt.getTime())) return isoStr
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dt)
  const map: Record<string, string> = {}
  for (const p of parts) {
    map[p.type] = p.value
  }
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`
}

export interface SubjectVisualConfig {
  key: SubjectKey
  label: string
  bgHex: string
  pillHex: string
  borderHex: string
  textHex: string
  defaultCategory: string
}

export const SUBJECT_CONFIG: Record<SubjectKey, SubjectVisualConfig> = {
  chinese: {
    key: 'chinese',
    label: '语文魔法书',
    bgHex: '#FFE4EE',
    pillHex: '#FF7AA8',
    borderHex: '#C93B6B',
    textHex: '#7A1C3E',
    defaultCategory: '生字朗读',
  },
  math: {
    key: 'math',
    label: '数学星盘',
    bgHex: '#E3F2FF',
    pillHex: '#63B3FF',
    borderHex: '#2B6CB0',
    textHex: '#1A3E6E',
    defaultCategory: '口算闯关',
  },
  english: {
    key: 'english',
    label: '英语蝴蝶结',
    bgHex: '#DFFCF0',
    pillHex: '#4FD1A5',
    borderHex: '#1F8A65',
    textHex: '#134E3A',
    defaultCategory: '跟读背诵',
  },
  reading: {
    key: 'reading',
    label: '童话绘本屋',
    bgHex: '#F2E6FF',
    pillHex: '#B685FF',
    borderHex: '#6B3FA0',
    textHex: '#3F1D6B',
    defaultCategory: '自主阅读',
  },
  science: {
    key: 'science',
    label: '奇妙自然瓶',
    bgHex: '#FFF3D6',
    pillHex: '#FFB84D',
    borderHex: '#B76E14',
    textHex: '#6B3D06',
    defaultCategory: '观察探索',
  },
  art: {
    key: 'art',
    label: '像素画室',
    bgHex: '#FFEAE3',
    pillHex: '#FF9478',
    borderHex: '#B84A32',
    textHex: '#6E2314',
    defaultCategory: '绘画练琴',
  },
}
