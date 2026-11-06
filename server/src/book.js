/**
 * 预约命令行（半自动实验 / 手动兜底）
 *
 *   node server/src/book.js --venue 网球场 --date 2026-11-09 --slot 1 --site 63_25
 *        → 仅准备并报告字段数量（dry-run，不提交、不打印 payload）
 *   node server/src/book.js ... --confirm
 *        → 真正提交（无重试，重复执行会生成多张申请单）
 *
 * 可选：--people 2 --person 学生 --owner LIU --phone 138xxxx --third 无
 */
import './env.js'
import { prepareBooking, submitBooking, VENUE_TYPES } from './booking.js'

const argv = process.argv.slice(2)
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const opts = {
  venue: arg('venue'),
  date: arg('date'),
  slot: Number(arg('slot', 1)),
  siteId: arg('site'),
  people: Number(arg('people', 1)),
  personType: arg('person', '学生'),
  owner: arg('owner', ''),
  phone: arg('phone', ''),
  thirdParty: arg('third', '无'),
}

if (!opts.venue || !opts.date || !opts.siteId) {
  console.error(`用法: node server/src/book.js --venue <${Object.keys(VENUE_TYPES).join('|')}> --date YYYY-MM-DD --slot 1..11 --site 63_xx [--confirm]`)
  process.exit(2)
}

const plan = await prepareBooking(opts)
console.log(`[book] 已准备 ${Object.keys(plan.payload).length} 个字段（不打印提交字段或防重 token）`)

if (!flag('confirm')) {
  console.log('[book] dry-run：未提交。加 --confirm 才会真正发 POST')
  process.exit(0)
}

const result = await submitBooking(plan.payload)
console.log(`[book] 提交返回 HTTP ${result.status} state=${result.state}`)
if (result.state === 'unknown') console.log('[book] 请到 OA「我的请求」核实，请勿直接重复提交')
console.log('[book] 响应诊断仅保存在本地 server/data/booking-diagnostics（若写入成功）')
process.exit(result.state === 'unknown' ? 2 : result.ok ? 0 : 1)