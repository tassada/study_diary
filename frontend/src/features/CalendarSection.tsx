import { useMemo, useState } from 'react'
import { getTodayDateStr } from '../config/pixelTheme'
import type { CalendarDaySummary } from '../types/study'

interface CalendarSectionProps {
  selectedDate: string
  calendarDays: Record<string, CalendarDaySummary>
  onSelectDate: (dateStr: string) => void
}

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function formatYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function CalendarSection({
  selectedDate,
  calendarDays,
  onSelectDate,
}: CalendarSectionProps) {
  const [expandedMonth, setExpandedMonth] = useState(false)
  const todayDateStr = getTodayDateStr()

  const weekDates = useMemo(() => {
    const curr = parseYmd(selectedDate)
    const jsDay = curr.getDay()
    const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay
    const monday = new Date(curr)
    monday.setDate(curr.getDate() + mondayOffset)
    return Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + idx)
      return {
        ymd: formatYmd(d),
        dayNum: d.getDate(),
        weekday: WEEKDAY_NAMES[idx],
      }
    })
  }, [selectedDate])

  const monthGrid = useMemo(() => {
    const curr = parseYmd(selectedDate)
    const year = curr.getFullYear()
    const month = curr.getMonth()
    const firstDay = new Date(year, month, 1)
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const startOffset = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1

    const cells: Array<{ ymd: string; dayNum: number } | null> = []
    for (let i = 0; i < startOffset; i += 1) cells.push(null)
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push({
        ymd: formatYmd(new Date(year, month, d)),
        dayNum: d,
      })
    }
    return {
      title: `${year}年${month + 1}月`,
      cells,
    }
  }, [selectedDate])

  const shiftDays = (delta: number) => {
    const d = parseYmd(selectedDate)
    d.setDate(d.getDate() + delta)
    onSelectDate(formatYmd(d))
  }

  return (
    <section className="pixel-card px-4 py-3 shrink-0">
      <div className="flex items-center justify-between gap-2 mb-2.5 whitespace-nowrap">
        <div className="flex items-center gap-2.5">
          <span className="text-[19px] font-extrabold text-[#332230]">
            📅 {monthGrid.title}日历
          </span>
          <button
            type="button"
            onClick={() => setExpandedMonth((v) => !v)}
            className="pixel-btn bg-[#FDF2F6] px-3 py-1 text-[15px] font-extrabold text-[#332230]"
          >
            {expandedMonth ? '▲ 收起月历' : '▼ 展开月历'}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => shiftDays(-7)}
            className="pixel-btn bg-[#FFFDF9] px-2.5 py-1 text-[15px] font-extrabold"
          >
            ◀ 上周
          </button>
          <button
            type="button"
            onClick={() => onSelectDate(todayDateStr)}
            className={`pixel-btn px-3 py-1 text-[15px] font-extrabold font-num ${
              selectedDate === todayDateStr ? 'bg-[#FFE484]' : 'bg-[#FFFDF9]'
            }`}
          >
            ★ 今天
          </button>
          <button
            type="button"
            onClick={() => shiftDays(7)}
            className="pixel-btn bg-[#FFFDF9] px-2.5 py-1 text-[15px] font-extrabold"
          >
            下周 ▶
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-2">
        {weekDates.map((item) => {
          const stat = calendarDays[item.ymd]
          const isSelected = item.ymd === selectedDate
          const isToday = item.ymd === todayDateStr
          return (
            <button
              key={item.ymd}
              type="button"
              onClick={() => onSelectDate(item.ymd)}
              className={`pixel-btn py-2 px-1 flex flex-col items-center justify-between h-[82px] whitespace-nowrap ${
                isSelected
                  ? 'bg-[#EC5F9B] text-white'
                  : isToday
                    ? 'bg-[#FFF3BF] text-[#332230]'
                    : 'bg-[#FFFDF9] text-[#332230]'
              }`}
            >
              <div className="text-[14px] font-bold">
                {item.weekday}
                {isToday ? '·今' : ''}
              </div>
              <div className="font-num text-[22px] font-extrabold leading-none">{item.dayNum}</div>
              {stat && stat.evalScore !== null ? (
                <span
                  className={`text-[13px] px-1.5 py-0.5 font-num font-extrabold border rounded ${
                    isSelected
                      ? 'bg-[#FFE484] text-[#332230] border-[#4A2B44]'
                      : 'bg-[#FFE8F2] text-[#B51D5B] border-[#B51D5B]'
                  }`}
                >
                  {stat.evalScore}分★
                </span>
              ) : stat && stat.total > 0 ? (
                <span
                  className={`text-[14px] font-num font-bold ${
                    isSelected ? 'text-white' : 'text-[#5C4056]'
                  }`}
                >
                  {stat.done}/{stat.total}项
                </span>
              ) : (
                <span className="text-[14px] opacity-40">—</span>
              )}
            </button>
          )
        })}
      </div>

      {expandedMonth && (
        <div className="absolute inset-4 z-30 pixel-card-butter p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between pb-3 border-b-3 border-[#4A2B44] whitespace-nowrap">
            <div className="flex items-center gap-3">
              <h3 className="text-[23px] font-extrabold text-[#332230]">
                📅 {monthGrid.title} 整月学习印章全览
              </h3>
              <span className="text-[16px] text-[#5C4056] font-medium">
                点击任意日期查看当天任务时间线或提前规划
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => shiftDays(-30)}
                className="pixel-btn bg-white px-3.5 py-1.5 text-[16px] font-bold"
              >
                ◀ 上个月
              </button>
              <button
                type="button"
                onClick={() => shiftDays(30)}
                className="pixel-btn bg-white px-3.5 py-1.5 text-[16px] font-bold"
              >
                下个月 ▶
              </button>
              <button
                type="button"
                onClick={() => setExpandedMonth(false)}
                className="pixel-btn bg-[#EC5F9B] text-white px-4 py-1.5 text-[17px] font-bold"
              >
                ✕ 收起月历
              </button>
            </div>
          </div>

          <div className="my-auto pt-3">
            <div className="grid grid-cols-7 gap-2 text-center text-[16px] font-bold text-[#5C4056] mb-2">
              {WEEKDAY_NAMES.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-2">
              {monthGrid.cells.map((cell, index) => {
                if (!cell) {
                  return <div key={`empty-${index}`} className="h-[82px] bg-[#FAF3EA]/60 rounded" />
                }
                const stat = calendarDays[cell.ymd]
                const isSelected = cell.ymd === selectedDate
                const isToday = cell.ymd === todayDateStr
                return (
                  <button
                    key={cell.ymd}
                    type="button"
                    onClick={() => {
                      onSelectDate(cell.ymd)
                      setExpandedMonth(false)
                    }}
                    className={`pixel-btn p-2 h-[82px] flex flex-col items-center justify-between whitespace-nowrap ${
                      isSelected
                        ? 'bg-[#EC5F9B] text-white'
                        : isToday
                          ? 'bg-[#FFF3BF] text-[#332230]'
                          : stat && stat.done > 0
                            ? 'bg-[#ECFDF3] text-[#332230]'
                            : 'bg-white text-[#332230]'
                    }`}
                  >
                    <span className="font-num text-[18px] font-extrabold">
                      {cell.dayNum}
                      {isToday ? ' (今)' : ''}
                    </span>
                    {stat && stat.evalScore !== null ? (
                      <span className="text-[14px] font-num font-bold bg-[#FFE484] text-[#332230] px-2 py-0.5 border border-[#4A2B44] rounded">
                        {stat.evalScore}分★
                      </span>
                    ) : stat && stat.total > 0 ? (
                      <span className="text-[14px] font-num font-semibold">
                        {stat.done}/{stat.total}项 · {stat.minutes}分
                      </span>
                    ) : (
                      <span className="text-[14px] opacity-35">待安排</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
