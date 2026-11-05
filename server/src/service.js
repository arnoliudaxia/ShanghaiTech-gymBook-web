/**
 * 采集服务：登录 → 发现分类 → 并发拉取 3 天 × 11 时段 → 组装快照并缓存
 *
 * 触发来源只有两种：
 *   - cron 规则文件（server/src/scheduler.js 按 cron.txt 定时调用）
 *   - 手动调用（POST /api/refresh 或 CLI server/src/refresh.js）
 * 前端不再触发采集，只读取快照。
 */
import './env.js'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.js'
import { AuthLostError, TreeClient, loginOa, SLOTS } from './oa.js'

const USER = process.env.MYUSERNAME
const PASS = process.env.PASSWORD
const CONCURRENCY = Number(process.env.CONCURRENCY || 6)
const CACHE_FILE = path.join(ROOT, 'server/data/snapshot.json')
const SESSION_FILE = path.join(ROOT, 'server/data/session.json')

export const state = {
  status: 'idle', // idle | loading | ready | error
  data: null,
  error: null,
  trigger: null, // cron | manual
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

/* ----------------------------------------------------------- 认证会话 */
/**
 * 会话只登录一次，持久化到 server/data/session.json 后反复复用，
 * 仅在服务端判定失效（AuthLostError）时才重新认证。
 * 避免每 10 分钟打一次 CAS 触发风控。
 */
const session = { cookie: null, savedAt: 0, lastLoginAt: 0, logins: 0, uses: 0 }
let loginInflight = null

function persistSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...session, cookie: session.cookie }, null, 0), 'utf8')
  } catch (err) {
    console.warn(`[auth] 会话写入失败：${err.message}`)
  }
}

function restoreSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    if (!saved?.cookie) return
    session.cookie = saved.cookie
    session.savedAt = saved.savedAt || 0
    session.lastLoginAt = saved.lastLoginAt || 0
    session.logins = saved.logins || 0
    session.uses = saved.uses || 0
    console.log(`[auth] 已载入上次会话（保存于 ${fmtTime(session.savedAt)}，已复用 ${session.uses} 轮）`)
  } catch (err) {
    console.warn(`[auth] 会话读取失败：${err.message}`)
  }
}

const fmtTime = (ts) =>
  ts ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }).format(new Date(ts)) : '—'

/** 取可用会话：有缓存直接复用，没有才登录（并发调用只登录一次） */
async function ensureSession({ force = false } = {}) {
  if (force) session.cookie = null
  if (session.cookie) return session.cookie

  if (!loginInflight) {
    loginInflight = (async () => {
      const cookie = await loginOa(USER, PASS)
      Object.assign(session, { cookie, savedAt: Date.now(), lastLoginAt: Date.now(), logins: session.logins + 1 })
      persistSession()
      console.log(`[auth] CAS 登录成功（累计 ${session.logins} 次），会话已保存，后续直接复用`)
      return cookie
    })().finally(() => {
      loginInflight = null
    })
  }
  return loginInflight
}

function readDiskCookie() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))?.cookie ?? null
  } catch {
    return null
  }
}

async function relogin(reason) {
  console.warn(`[auth] ${reason}，重新认证`)
  // 多进程（服务 + CLI）共用会话文件时，别抢着登录：磁盘上可能有别的进程刚换的新会话
  const disk = readDiskCookie()
  if (disk && disk !== session.cookie) {
    console.log('[auth] 磁盘上存在更新的会话，先复用它')
    session.cookie = disk
    return disk
  }
  return ensureSession({ force: true })
}

export function sessionInfo() {
  return {
    hasCookie: Boolean(session.cookie),
    savedAt: session.savedAt || null,
    lastLoginAt: session.lastLoginAt || null,
    logins: session.logins,
    uses: session.uses,
    ageSeconds: session.savedAt ? Math.round((Date.now() - session.savedAt) / 1000) : null,
  }
}

/* ----------------------------------------------------------- 快照落盘 */
function persist(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8')
  } catch (err) {
    console.warn(`[cache] 快照写入失败：${err.message}`)
  }
}

function restore() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (!data?.venues?.length) return
    state.data = data
    state.status = 'ready'
    state.finishedAt = Date.parse(data.generatedAt) || Date.now()
    console.log(`[cache] 已载入上次快照：${data.venues.length} 个场馆 / ${data.dates.length} 天（${data.generatedAt}）`)
  } catch (err) {
    console.warn(`[cache] 快照读取失败：${err.message}`)
  }
}

restore()
restoreSession()

/* ----------------------------------------------------------- 采集 */
export async function refresh({ includeAll = false, days = 3, trigger = 'manual' } = {}) {
  if (state.status === 'loading') return state

  state.status = 'loading'
  state.error = null
  state.trigger = trigger
  state.startedAt = Date.now()
  state.progress = { done: 0, total: 0 }

  try {
    if (!USER || !PASS) throw new Error('未配置 MYUSERNAME / PASSWORD')

    let tree = new TreeClient(await ensureSession())

    let all
    try {
      all = await tree.discover()
    } catch (err) {
      if (!(err instanceof AuthLostError)) throw err
      tree = new TreeClient(await relogin('发现场馆分类时认证失效'))
      all = await tree.discover()
    }
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

    const keyOf = (t) => `${t.venue.id}|${t.date}|${t.slot}`
    const authLost = []   // 登录态失效的格子
    const unreachable = [] // 网络/超时的格子

    const collect = async (list, { countProgress }) => {
      await pool(list, CONCURRENCY, async (task) => {
        try {
          const courts = await tree.cell(task.venue, task.date, task.slot)
          if (courts === null) unreachable.push(task)
          else cells.set(keyOf(task), courts)
        } catch (err) {
          if (err instanceof AuthLostError) authLost.push(task)
          else throw err
        }
        if (countProgress) state.progress.done++
        await sleep(10)
      })
    }

    await collect(tasks, { countProgress: true })

    // 认证失效：重新登录一次，只重试受影响的格子（不重跑整轮，省 OA 请求）
    if (authLost.length) {
      console.warn(`[refresh] 采集中登录态失效，${authLost.length} 个格子受影响，重新认证后重试`)
      tree = new TreeClient(await relogin('采集途中认证失效'))
      await collect(authLost.splice(0), { countProgress: false })
      if (authLost.length) throw new Error(`登录态反复失效，${authLost.length} 个格子未能取到`)
    }

    const missing = tasks.length - cells.size
    const missRatio = missing / tasks.length
    if (missRatio > 0.2) {
      // 数据太残缺，宁可不更新，也不要用错的“全约满”覆盖上次快照
      throw new Error(`采集失败过多（${missing}/${tasks.length}），已保留上次快照`)
    }
    if (missing > 0) console.warn(`[refresh] 有 ${missing} 个格子未取到，标记为 null（前端显示 ×）`)

    const data = {
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai',
      dates,
      slots: SLOTS,
      skipped,
      missing,
      venues: venues.map((v) => ({
        ...v,
        availability: Object.fromEntries(
          dates.map((date) => [
            date,
            Object.fromEntries(SLOTS.map((label, i) => [label, cells.get(`${v.id}|${date}|${i + 1}`) ?? null])),
          ])
        ),
      })),
    }

    state.data = data
    state.status = 'ready'
    state.finishedAt = Date.now()
    session.uses += 1
    persistSession()
    persist(data)
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
    trigger: state.trigger,
    progress: state.progress,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    data: state.data,
  }
}