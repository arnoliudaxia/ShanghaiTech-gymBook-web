import { bookingDatePolicy, shanghaiNow } from '../../shared/booking-date.mjs'

/** Existing one-second UI timer supplies this same clock to every component. */
export const nowInShanghai = shanghaiNow

export const slotStart = (slot) => slot.slice(0, 5)

/** 今天且开始时间已过 → 已过 */
export const isPast = (date, slot, now) =>
  date < now.date || (date === now.date && slotStart(slot) <= now.hm)

export const weekday = (date) =>
  ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T00:00:00+08:00`).getDay()]

export const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

export const relativeDay = (date, now) => {
  const diff = Math.round(
    (new Date(`${date}T00:00:00+08:00`) - new Date(`${now.date}T00:00:00+08:00`)) / 86400000
  )
  return ['今天', '明天', '后天'][diff] ?? ''
}

/** 某场馆某天真正还能约的时段数（排除已过时段与失败） */
export function freeSlotCount(venue, date, now) {
  if (!bookingDatePolicy(date, now).allowed) return 0
  const row = venue.availability?.[date] ?? {}
  return Object.entries(row).filter(([slot, courts]) => !isPast(date, slot, now) && Array.isArray(courts) && courts.length > 0).length
}

/** 展示用名称：去掉前导“室内” */
export const cleanName = (name) => String(name ?? '').replace(/^室内/, '')
