/**
 * 极简 cron 解析器（无第三方依赖）
 * 支持：*  |  *\/n  |  a  |  a-b  |  a-b/n  |  逗号列表
 * 周字段：0 和 7 均为周日；日与周同时受限时按 crontab 惯例取“或”
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },
]

function parseField(spec, { min, max, name }) {
  const set = new Set()
  for (const part of String(spec).split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`${name} 字段步长非法: ${part}`)

    let from
    let to
    if (range === '*') {
      from = min
      to = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number)
      from = a
      to = b
    } else {
      from = Number(range)
      to = stepRaw === undefined ? from : max
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`${name} 字段非法: ${part}`)

    // 周字段允许 7 表示周日
    const normalizedFrom = name === 'dow' && from === 7 ? 0 : from
    const normalizedTo = name === 'dow' && to === 7 ? 6 : to
    const hi = name === 'dow' && from === 7 && to === 7 ? 0 : normalizedTo

    for (let v = normalizedFrom; v <= hi; v += step) {
      if (v < min || v > max) throw new Error(`${name} 字段超出范围 ${min}-${max}: ${part}`)
      set.add(v)
    }
  }
  if (!set.size) throw new Error(`${name} 字段为空: ${spec}`)
  return set
}

export function parseCron(expression) {
  const parts = String(expression).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron 表达式需 5 个字段，收到 ${parts.length} 个: ${expression}`)
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]))
  return {
    expression: parts.join(' '),
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

/**
 * 判断某个时间点是否命中规则。
 * 注意：这里按“分钟”粒度判断，秒与毫秒忽略。
 */
export function matches(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false
  if (!cron.hour.has(date.getHours())) return false
  if (!cron.month.has(date.getMonth() + 1)) return false

  const domHit = cron.dom.has(date.getDate())
  const dowHit = cron.dow.has(date.getDay())
  if (cron.domRestricted && cron.dowRestricted) return domHit || dowHit
  return domHit && dowHit
}

/** 下一次触发时间（严格晚于 from，按分钟对齐） */
export function nextRun(cron, from = new Date()) {
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (matches(cron, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

export const describe = (cron) => cron.expression