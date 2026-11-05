/** Asia/Shanghai 的“现在”，与后端日期口径一致 */
export function nowInShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hm: `${get('hour')}:${get('minute')}` }
}

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
  const row = venue.availability?.[date] ?? {}
  return Object.entries(row).filter(([slot, courts]) => !isPast(date, slot, now) && Array.isArray(courts) && courts.length > 0).length
}

/** 展示用名称：去掉前导“室内” */
export const cleanName = (name) => String(name ?? '').replace(/^室内/, '')
