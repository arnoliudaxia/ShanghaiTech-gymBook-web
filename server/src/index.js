import './env.js'
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { ROOT } from './env.js'
import { refresh, snapshot } from './service.js'

const PORT = Number(process.env.GYMBOOK_PORT || process.env.PORT || 8787)
const app = express()
app.use(express.json())

app.get('/api/health', (_req, res) => res.json({ ok: true, status: snapshot().status }))

/** 快照：未就绪时返回 202，并自动触发一次后台采集 */
app.get('/api/availability', (req, res) => {
  const includeAll = req.query.all === '1'
  const snap = snapshot()
  if (snap.status === 'idle') void refresh({ includeAll })
  res.status(snap.data ? 200 : 202).json(snap)
})

/** 手动刷新 */
app.post('/api/refresh', (req, res) => {
  const includeAll = req.query.all === '1' || req.body?.includeAll === true
  if (snapshot().status === 'loading') return res.status(409).json(snapshot())
  void refresh({ includeAll })
  res.status(202).json(snapshot())
})

// 生产模式：直接托管 web/dist
const dist = path.join(ROOT, 'web/dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.listen(PORT, () => {
  console.log(`[gymbook] server listening on http://localhost:${PORT}`)
  if (!process.env.MYUSERNAME) console.warn('[gymbook] 警告：未找到 MYUSERNAME，请在项目根目录创建 .env')
  void refresh({}) // 启动即预热
})