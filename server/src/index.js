import './env.js'
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { ROOT } from './env.js'
import { refresh, sessionInfo, snapshot } from './service.js'
import { startScheduler } from './scheduler.js'

const PORT = Number(process.env.GYMBOOK_PORT || process.env.PORT || 8787)
const INCLUDE_ALL = process.env.INCLUDE_ALL === '1'

const app = express()
app.use(express.json())

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