/**
 * 一次性刷新（供系统 cron / Windows 任务计划调用）
 *   node server/src/refresh.js            # 忽略“整体预约”型场馆
 *   node server/src/refresh.js --all      # 连田径场/足球场/篮球场一起采
 * 采集结果会写入 server/data/snapshot.json，常驻服务启动时直接复用。
 */
import './env.js'
import { refresh } from './service.js'

const includeAll = process.argv.includes('--all')
const startedAt = Date.now()

const snap = await refresh({ includeAll })
if (snap.status === 'ready') {
  const v = snap.data.venues.length
  const rows = snap.data.venues.reduce(
    (n, venue) => n + Object.values(venue.availability).reduce((s, row) => s + Object.values(row).filter((c) => Array.isArray(c) && c.length).length, 0),
    0
  )
  console.log(`[refresh] 完成：${v} 个场馆 / ${rows} 条可约记录，用时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
  process.exit(0)
} else {
  console.error(`[refresh] 失败：${snap.error}`)
  process.exit(1)
}