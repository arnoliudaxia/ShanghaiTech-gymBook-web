/**
 * 采集服务：登录 → 发现分类 → 并发拉取 3 天 × 11 时段 → 组装快照并缓存
 */
import './env.js'
import { TreeClient, loginOa, SLOTS } from './oa.js'

const USER = process.env.MYUSERNAME
const PASS = process.env.PASSWORD
const CONCURRENCY = Number(process.env.CONCURRENCY || 6)

export const state = {
  status: 'idle', // idle | loading | ready | error
  data: null,
  error: null,
  startedAt: 0,
  finishedAt: 0,
  progress: { done: 0, total: 0 },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pool(items, limit, fn) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** 以 Asia/Shanghai 为准的最近 N 天日期字符串 */
export function recentDates(days = 3) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  const now = Date.now()
  return Array.from({ length: days }, (_, i) => fmt.format(new Date(now + i * 86400000)))
}

export async function refresh({ includeAll = false, days = 3 } = {}) {
  if (state.status === 'loading') return state

  state.status = 'loading'
  state.error = null
  state.startedAt = Date.now()
  state.progress = { done: 0, total: 0 }

  try {
    if (!USER || !PASS) throw new Error('未配置 MYUSERNAME / PASSWORD')

    const cookie = await loginOa(USER, PASS)
    const tree = new TreeClient(cookie)

    const all = await tree.discover()
    if (!all.length) throw new Error('未发现任何场馆分类，接口可能又变了')

    const venues = all.filter((v) => includeAll || v.children > 0)
    const skipped = all.filter((v) => !venues.includes(v)).map((v) => v.name)
    const dates = recentDates(days)

    const cells = new Map()
    const tasks = []
    for (const venue of venues) {
      for (const date of dates) {
        for (let slot = 1; slot <= SLOTS.length; slot++) tasks.push({ venue, date, slot })
      }
    }
    state.progress.total = tasks.length

    await pool(tasks, CONCURRENCY, async ({ venue, date, slot }) => {
      const courts = await tree.cell(venue, date, slot)
      cells.set(`${venue.id}|${date}|${slot}`, courts)
      state.progress.done++
      await sleep(10)
    })

    state.data = {
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai',
      dates,
      slots: SLOTS,
      skipped,
      venues: venues.map((v) => ({
        ...v,
        availability: Object.fromEntries(
          dates.map((date) => [
            date,
            Object.fromEntries(
              SLOTS.map((label, i) => [label, cells.get(`${v.id}|${date}|${i + 1}`) ?? null])
            ),
          ])
        ),
      })),
    }
    state.status = 'ready'
    state.finishedAt = Date.now()
  } catch (err) {
    state.status = 'error'
    state.error = err?.message || String(err)
    state.finishedAt = Date.now()
  }
  return state
}

export function snapshot() {
  return {
    status: state.status,
    error: state.error,
    progress: state.progress,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    data: state.data,
  }
}