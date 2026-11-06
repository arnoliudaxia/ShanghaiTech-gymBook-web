import './env.js'
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { ROOT } from './env.js'
import { refresh, sessionInfo, snapshot, oaReadonlyFetch } from './service.js'
import { prepareBooking, submitBooking, quotaOf, recordBooking, listBookings, markBookingCancellation, VENUE_TYPES, PERSON_TYPES, THIRD_PARTY, BookingError, validateBookingDate, validateBookingFields } from './booking.js'
import { AuthLostError } from './oa.js'
import { startScheduler } from './scheduler.js'
import { listPendingApplications } from './portal.js'
import { createCancellationService } from './cancellation.js'
import { fetchFormFields } from './booking.js'
import { installApplicationsRoutes } from './applications-api.js'
import { createApplicationQuery } from './applications-query.js'

const PORT = Number(process.env.GYMBOOK_PORT || process.env.PORT || 8787)
const INCLUDE_ALL = process.env.INCLUDE_ALL === '1'

const app = express()
app.use(express.json())

const getOwnApplicantId = async () => (await fetchFormFields()).fields.field31876
const cancellations = createCancellationService({ listPendingApplications, getOwnApplicantId })
const listApplicationsForDisplay = createApplicationQuery({
  listPendingApplications,
  getOwnApplicantId,
  onDeleted: (task) => markBookingCancellation(task.requestId, {
    state: 'cancelled', requestId: task.requestId, step: 'list-reconciliation', quotaReleased: null,
  }),
  get: oaReadonlyFetch,
})
installApplicationsRoutes(app, {
  listPendingApplications,
  listApplicationsForDisplay,
  cancelApplication: (task) => cancellations.cancelApplication(task),
})

/** 调度器：按项目根目录的 cron.txt 定时刷新（默认每 10 分钟） */
const scheduler = startScheduler({
  handler: () => refresh({ includeAll: INCLUDE_ALL, trigger: 'cron' }),
})

const scheduleOf = () => scheduler.describe()

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, status: snapshot().status, schedule: scheduleOf(), session: sessionInfo() })
)

/** 只读快照，前端不再触发采集 */
app.get('/api/availability', (_req, res) => {
  const snap = snapshot()
  res.status(snap.data ? 200 : 202).json({ ...snap, schedule: scheduleOf() })
})

app.get('/api/schedule', (_req, res) => res.json({ file: 'cron.txt', rules: scheduleOf(), trigger: snapshot().trigger }))

/* ---------------------------------------------------------------- 预约（半自动）
 * POST /api/booking/prepare  只准备 payload，不提交
 * POST /api/booking/submit   显式确认后才提交（无重试，避免重复申请单）
 * 服务端单次提交后读取 OA 申请详情验证；不重试提交，不凭场地占用判定成功。
 */
app.get('/api/booking/meta', (_req, res) =>
  res.json({
    venueTypes: VENUE_TYPES,
    personTypes: PERSON_TYPES,
    thirdParty: THIRD_PARTY,
    // 表单里的「现场责任人 / 联系电话」没有服务端默认值，从 .env 读，前端可改
    defaults: { owner: process.env.BOOK_OWNER || '', phone: process.env.BOOK_PHONE || '', people: 1, personType: '学生', thirdParty: '无' },
  })
)

/** 各场馆类型今天的限额状态 + 本地记录 */
app.get('/api/booking/quota', (_req, res) => {
  // 键用「场馆类型名」（前端按名字查），值里再用编码调 quotaOf
  const quota = Object.fromEntries(Object.entries(VENUE_TYPES).map(([name, code]) => [name, quotaOf(code)]))
  res.json({ ok: true, quota, bookings: listBookings().slice(-10) })
})

app.post('/api/booking/prepare', async (req, res) => {
  try {
    const plan = await prepareBooking(req.body ?? {})
    const snapshotData = snapshot().data
    // 提交前用最新快照做一次冲突预检（服务端仍会再校验，这里只是提前告知）
    const venue = snapshotData?.venues?.find((v) => v.name === req.body?.venue)
    const courts = venue?.availability?.[req.body?.date]?.[slotLabel(req.body?.slot)] ?? null
    res.json({
      ok: true,
      quota: quotaOf(plan.overrides.field32340),
      submitUrl: plan.submitUrl,
      payload: plan.payload,
      preview: {
        venue: req.body.venue,
        date: req.body.date,
        slot: req.body.slot,
        siteId: req.body.siteId,
        fields: Object.fromEntries(Object.entries(plan.overrides)),
      },
      conflict: courts ? { available: courts, ok: courts.length > 0 } : { available: null, ok: null },
    })
  } catch (err) {
    const code = err instanceof BookingError ? 400 : err instanceof AuthLostError ? 401 : 500
    res.status(code).json({ ok: false, error: err.message })
  }
})

app.post('/api/booking/submit', async (req, res) => {
  try {
    const body = req.body ?? {}
    validateBookingDate(body.date)
    validateBookingFields(body)
    // 保留既有本地限额保护；不是 OA 错误诊断，也不证明 OA 必然拒绝。
    const known = quotaOf(VENUE_TYPES[body.venue] ?? '')
    if (known.used && !body.force) {
      const b = known.bookings[0]
      return res.status(409).json({
        ok: false,
        state: 'quota-used',
        message: `今天已经约过${body.venue}（${b?.date ?? ''} ${b?.slotLabel ?? ''} ${b?.siteName ?? ''}），每个场馆类型每天只能成功预约 1 次`,
        quota: known,
      })
    }
    const plan = await prepareBooking(body)
    // 优先解析 OA 明确结果；场地树仅作 unknown 时的补充观察。
    const result = await submitBooking(plan.payload, {
      venueId: body.venueId,
      cat: plan.overrides.field32340,
      date: plan.overrides.field31901,
      slot: plan.overrides.field31902,
      siteName: body.siteName,
    })
    // 不记录提交字段、OA 文案或 URL（它们可能包含个人信息/凭证）。
    console.log(`[book] state=${result.state} verified=${result.verified ?? '-'}`)
    if (result.state === 'ok' && result.ok) {
      recordBooking({
        requestId: result.requestId,
        venueType: plan.overrides.field32340,
        venue: body.venue,
        date: plan.overrides.field31901,
        slot: plan.overrides.field31902,
        slotLabel: body.slotLabel,
        siteName: body.siteName,
        siteId: plan.overrides.field31883,
      })
    }
    // Diagnostic bodies, response headers and URLs stay local, never sent to the UI.
    res.status(result.state === 'unknown' ? 202 : result.ok ? 200 : 502).json({
      ok: result.ok, state: result.state, status: result.status,
      verified: result.verified, message: result.message,
      requestId: /^\d+$/.test(result.requestId ?? '') ? result.requestId : undefined,
    })
  } catch (err) {
    const code = err instanceof BookingError ? 400 : err instanceof AuthLostError ? 401 : 500
    res.status(code).json({ ok: false, state: err instanceof BookingError ? 'rejected' : 'unknown',
      message: err instanceof BookingError ? err.message : '无法确认提交结果，请到 OA「我的请求」核实，请勿直接重复提交' })
  }
})

/** 时段序号（1..11）→ '11:00-12:00' 这类标签 */
function slotLabel(slot) {
  const i = Number(slot) - 1
  if (!Number.isFinite(i) || i < 0) return ''
  const h = 11 + i
  return `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`
}

// 生产模式：直接托管 web/dist
const dist = path.join(ROOT, 'web/dist')
if (fs.existsSync(dist)) {
  // 构建过期检测：源码比 dist 新时提醒，避免以为改了代码却没生效
  const assetsMtime = Math.max(
    fs.statSync(path.join(dist, 'index.html')).mtimeMs,
    ...fs.readdirSync(path.join(dist, 'assets')).map((f) => fs.statSync(path.join(dist, 'assets', f)).mtimeMs)
  )
  const newestSrc = fs
    .readdirSync(path.join(ROOT, 'web/src'), { recursive: true })
    .map((f) => path.join(ROOT, 'web/src', f))
    .filter((f) => fs.statSync(f).isFile())
    .reduce((max, f) => Math.max(max, fs.statSync(f).mtimeMs), 0)
  if (newestSrc > assetsMtime) {
    console.warn('[web] ⚠️ web/dist 比 web/src 旧，当前 :' + PORT + ' 托管的是旧构建。')
    console.warn('[web]    开发用 http://localhost:5173（vite dev）；生产请先 npm run build')
  }

  app.use(express.static(dist))
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.listen(PORT, () => {
  console.log(`[gymbook] server listening on http://localhost:${PORT}`)
  if (!process.env.MYUSERNAME) console.warn('[gymbook] 警告：未找到 MYUSERNAME，请在项目根目录创建 .env')
  // 有缓存就不必启动即采；没有缓存时立刻采一次，避免首屏空着等 10 分钟
  if (!snapshot().data) {
    console.log('[gymbook] 无本地缓存，启动即采集一次')
    void refresh({ includeAll: INCLUDE_ALL, trigger: 'boot' })
  }
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    scheduler.stop()
    process.exit(0)
  })
}