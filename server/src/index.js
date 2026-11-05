import './env.js'
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { ROOT } from './env.js'
import { refresh, snapshot } from './service.js'
import { startScheduler } from './scheduler.js'

const PORT = Number(process.env.GYMBOOK_PORT || process.env.PORT || 8787)
const INCLUDE_ALL = process.env.INCLUDE_ALL === '1'

const app = express()
app.use(express.json())

/** 调度器：按 cron.txt 定时刷新（默认每 10 分钟） */
const CRON_FILE = process.env.CRON_FILE || path.join(ROOT, 'cron.txt')
const scheduler = startScheduler({
  file: CRON_FILE,
  handler: () => refresh({ includeAll: INCLUDE_ALL, trigger: 'cron' }),
})

const scheduleOf = () => scheduler.describe()

app.get('/api/health', (_req, res) => res.json({ ok: true, status: snapshot().status, schedule: scheduleOf() }))

/** 只读快照，前端不再触发采集 */
app.get('/api/availability', (_req, res) => {
  const snap = snapshot()
  res.status(snap.data ? 200 : 202).json({ ...snap, schedule: scheduleOf() })
})

/** 手动刷新（显式用户操作，不影响 cron 排期） */
app.post('/api/refresh', (req, res) => {
  if (snapshot().status === 'loading') return res.status(409).json({ ...snapshot(), schedule: scheduleOf() })
  const includeAll = req.query.all === '1' || req.body?.includeAll === true || INCLUDE_ALL
  void refresh({ includeAll, trigger: 'manual' })
  res.status(202).json({ ...snapshot(), schedule: scheduleOf() })
})

app.get('/api/schedule', (_req, res) => res.json({ file: CRON_FILE, rules: scheduleOf(), trigger: snapshot().trigger }))

// 生产模式：直接托管 web/dist
const dist = path.join(ROOT, 'web/dist')
if (fs.existsSync(dist)) {
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