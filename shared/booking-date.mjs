/** OA yy(): noon < now (strict); dates are Shanghai calendar days, not elapsed 24h. */
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  hourCycle: 'h23',
})

export function shanghaiNow(now = new Date()) {
  const parts = formatter.formatToParts(now)
  const get = (key) => parts.find((p) => p.type === key).value
  const hm = `${get('hour')}:${get('minute')}`
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hm,
    time: `${hm}:${get('second')}.${get('fractionalSecond')}` }
}

function calendarDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  return parsed.getTime() / 86400000
}

/** Pure; an explicit Date or shanghaiNow() clock can be supplied by tests/UI. */
export function bookingDatePolicy(date, now = new Date()) {
  const clock = now instanceof Date ? shanghaiNow(now) : now
  const day = calendarDay(date)
  if (day === null) return { allowed: false, reason: 'invalid', message: `非法日期：${date}（须为有效的 YYYY-MM-DD）` }
  const diff = day - calendarDay(clock.date)
  if (diff < 0) return { allowed: false, reason: 'past', message: '使用日期已过，不能预约过去的日期' }
  const afterNoon = (clock.time ?? `${clock.hm}:00.000`) > '12:00:00.000'
  if (diff < (afterNoon ? 3 : 2)) return { allowed: true, reason: 'open', message: '' }
  const opensDate = new Date((day - 2) * 86400000).toISOString().slice(0, 10)
  return { allowed: false, reason: 'not-open', opensDate,
    message: `尚未开放预约：${date} 将于 ${opensDate} 上海时间中午 12:00 之后开放（12:00 整尚未开放）；场地树空闲不代表可预约` }
}
