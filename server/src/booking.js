/**
 * 预约（场馆借用申请）—— 半自动
 *
 * 流程（逆向自一次被拦截的真实提交，详见 docs/booking-api.md）：
 *   1. GET  AddRequestIframe.jsp  → 拿到当次表单的全部隐藏值 + 防重 token
 *   2. 覆盖业务字段（场馆类型/日期/时段/场地/人数/类别/责任人/电话/第三方）
 *   3. POST RequestOperation.jsp  → 提交
 *
 * 安全性约定：
 *   - 默认 dry-run，只有显式 confirm=true 才真正提交
 *   - 不做自动重试：提交无幂等性，重复 POST 会生成多张申请单
 */
import './env.js'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.js'
import { SLOTS } from './oa.js'
import { ensureSession, oaReadonlyFetch } from './service.js'
import { decodeEntities, submissionPayload, followBookingResults, bookingOutcome } from './booking-response.js'
import { createBookingDiagnostics } from './booking-diagnostics.js'
import { verifySubmissionRequest } from './oa-request.js'
import { bookingDatePolicy } from '../../shared/booking-date.mjs'
import { bookingFieldsError } from '../../shared/booking-fields.mjs'

const OA_BASE = 'https://oa.shanghaitech.edu.cn'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

export const FORM_URL =
  `${OA_BASE}/workflow/request/AddRequestIframe.jsp?workflowid=43364&nodeid=47012&isbill=1&formid=-248&requestid=-1`
export const SUBMIT_URL = `${OA_BASE}/workflow/request/RequestOperation.jsp`

/** 表单里「场馆类型」下拉的取值，与树接口的分类号不同源，别混用 */
export const VENUE_TYPES = { 羽毛球场: '4', 乒乓球: '5', 网球场: '6', 匹克球场: '11', 排球场: '12' }
/** 人员类别 */
export const PERSON_TYPES = { 学生: '0', 教职工: '1', 校外人员: '2' }
/** 有无第三方服务 */
export const THIRD_PARTY = { 有: '0', 无: '1' }

export class BookingError extends Error {}

export function validateBookingFields(fields) {
  const message = bookingFieldsError(fields)
  if (message) throw new BookingError(message)
}

export function validateBookingDate(date, now = new Date()) {
  const policy = bookingDatePolicy(date, now)
  if (!policy.allowed) throw new BookingError(policy.message)
}

/* ------------------------------------------------------------ 本地预约记录
 * 本地记账仅为限额提示，不代表 OA 的实时校验结果。
 * 只有明确成功的响应才记账；历史树复核记录不构成成功证明。
 */
const BOOKINGS_FILE = path.join(ROOT, 'server/data/bookings.json')

const cstToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

export function listBookings() {
  try {
    return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'))
  } catch {
    return []
  }
}

/** 今天该场馆类型是否已经成功约过（OA 的限额口径：场馆类型 × 申请人 × 当天申请） */
export function quotaOf(venueType) {
  const today = cstToday()
  const hit = listBookings().filter((b) => b.venueType === venueType && b.applyDate === today && b.cancellation?.state !== 'cancelled')
  return { used: hit.length > 0, today, bookings: hit }
}

export function recordBooking(entry) {
  const list = listBookings()
  list.push({ ...entry, applyDate: cstToday(), at: new Date().toISOString() })
  fs.mkdirSync(path.dirname(BOOKINGS_FILE), { recursive: true })
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(list, null, 2), 'utf8')
}

/** Preserve history. Only confirmed deletion excludes a record from the local hint. */
export function markBookingCancellation(requestId, outcome) {
  const list = listBookings()
  for (const booking of list) {
    if (String(booking.requestId) === String(requestId)) {
      booking.cancellation = { ...outcome, at: new Date().toISOString() }
    }
  }
  fs.mkdirSync(path.dirname(BOOKINGS_FILE), { recursive: true })
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(list, null, 2), 'utf8')
}

const chineseNow = () =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
    .replace(/\//g, '-')

/** 时段 id（1..11）→ { start: '11:00', end: '12:00' } */
function slotTimes(slot) {
  const label = SLOTS[Number(slot) - 1]
  if (!label) throw new BookingError(`非法时段：${slot}（应为 1..${SLOTS.length}）`)
  const [start, end] = label.split('-')
  return { start, end }
}

/* --------------------------------------------------------------- HTML 解析 */
const decode = decodeEntities

/** 把表单里所有 input 的 name→value 抽出来（含 hidden），保留原始顺序无关 */
export function parseFormInputs(html) {
  const out = {}
  const re = /<input\b([^>]*)>/gi
  let m
  while ((m = re.exec(html))) {
    const attrs = m[1]
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]
    if (!name) continue
    const type = /\btype\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? 'text'
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ''
    if (type === 'checkbox' || type === 'radio') {
      if (/\bchecked\b/i.test(attrs)) out[name] = decode(value)
      else if (!(name in out)) out[name] = ''
    } else {
      out[name] = decode(value)
    }
  }
  return out
}

async function oaFetch(url, cookie, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'user-agent': UA,
      accept: '*/*',
      cookie: `shkjdx_session=${cookie}`,
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  return { res, text }
}

/** 取一份空白表单的原始字段（每次调用都会生成新的防重 token） */
export async function fetchFormFields() {
  const { res, text, cookie } = await oaReadonlyFetch(FORM_URL)
  if (res.status !== 200) throw new BookingError(`取表单失败：HTTP ${res.status}`)
  if (!text.includes('RequestOperation.jsp')) throw new BookingError('取表单失败：返回内容不是预约表单')

  const fields = parseFormInputs(text)
  const tokenKey = Object.keys(fields).find((k) => k.endsWith('_addrequest_submit_token'))
  if (!tokenKey) throw new BookingError('取表单失败：未找到防重 token')
  if (!fields.field31876) throw new BookingError('取表单失败：未取到申请人 userid')

  const names = [...text.matchAll(/<span[^>]*>([^<]{1,20})<\/span>/g)].map((x) => x[1])
  return { fields, tokenKey, cookie, sampleLabels: names.slice(0, 3) }
}

/**
 * 拼装提交 payload
 * @param {object} o
 * @param {string} o.venue      场馆类型，如 '网球场'
 * @param {string} o.date       使用日期 YYYY-MM-DD
 * @param {number} o.slot       时段 1..11
 * @param {string} o.siteId     场地树节点 id，如 '63_25'
 * @param {number} [o.people]   参加人数
 * @param {string} [o.personType] 人员类别
 * @param {string} [o.owner]    现场责任人
 * @param {string} [o.phone]    联系电话
 * @param {string} [o.thirdParty] 有无第三方服务
 */
export function buildPayload(o, now = new Date()) {
  const venueType = VENUE_TYPES[o.venue] ?? (o.venue ? null : null)
  if (!venueType) throw new BookingError(`未知场馆类型：${o.venue}（可选 ${Object.keys(VENUE_TYPES).join('/')}）`)
  validateBookingDate(o.date, now)
  if (!o.siteId) throw new BookingError('缺少场地树节点 id（siteId）')
  validateBookingFields(o)

  const { start, end } = slotTimes(o.slot)
  return {
    field32340: venueType,
    field31901: o.date,
    field31902: String(o.slot),
    field31883: o.siteId,
    field31884: String(o.people ?? 1),
    field31885: PERSON_TYPES[o.personType ?? '学生'] ?? '0',
    field31888: o.owner.trim(),
    field31889: o.phone.trim(),
    field31892: THIRD_PARTY[o.thirdParty ?? '无'] ?? '1',
    field31904: start,
    field31905: end,
  }
}

/**
 * 准备一次预约：返回可直接展示的提交方案（默认不提交）
 * @returns {{ payload: Record<string,string>, submitUrl: string, overrides: object }}
 */
export async function prepareBooking(o) {
  // Reject locally before authentication or fetching a fresh OA form/token.
  const overrides = buildPayload(o)
  const { fields } = await fetchFormFields()
  const payload = submissionPayload(fields, { ...overrides, field31878: chineseNow() })
  return { payload, overrides, submitUrl: SUBMIT_URL, tokenKey: Object.keys(fields).find((k) => k.endsWith('_addrequest_submit_token')) }
}

/**
 * 事后核验：重新查一次场地树，看目标场地是否已从可约列表消失。
 * 仅为补充证据：消失可能是他人预约，仍可约也不能单独证明提交失败。
 * @returns {'gone'|'still-free'|'unknown'}
 */
export async function verifyBooking({ venueId, cat, date, slot, siteName, tries = 3, gap = 2500 }) {
  const { TreeClient } = await import('./oa.js')
  const tree = new TreeClient(await ensureSession())
  let last = 'unknown'
  for (let i = 0; i < tries; i++) {
    const courts = await tree.cell({ id: venueId, cat: String(cat), isParent: true }, date, Number(slot))
    if (courts === null) last = 'unknown'
    else if (!courts.includes(siteName)) return 'gone'
    else last = 'still-free'
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gap))
  }
  return last
}

/** 真正提交一次（无重试！），之后仅允许有界的只读结果页 GET。 */
export async function submitBooking(payload, verify) {
  // Validate the actual wire payload, not caller metadata or a previous prepare.
  const outgoing = submissionPayload(payload)
  validateBookingDate(outgoing.field31901)
  validateBookingFields({ owner: outgoing.field31888, phone: outgoing.field31889, people: outgoing.field31884 })
  const cookie = await ensureSession()
  // Authentication may cross midnight: recheck immediately before the only POST.
  validateBookingDate(outgoing.field31901)
  const diagnostics = createBookingDiagnostics(ROOT)
  const response = (url, { res, text }) => ({
    status: res.status, headers: Object.fromEntries(res.headers),
    location: res.headers.get('location') ?? '', url: res.url || url, text,
  })
  const initial = response(SUBMIT_URL, await oaFetch(SUBMIT_URL, cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: FORM_URL },
    body: new URLSearchParams(outgoing).toString(),
  }))
  diagnostics.save(initial)
  let parsed = await followBookingResults(initial,
    async (url) => response(url, await oaFetch(url, cookie, { method: 'GET' })),
    { onResponse: (r) => diagnostics.save(r) })
  parsed = await verifySubmissionRequest(parsed,
    async (url) => {
      const r = response(url, await oaFetch(url, cookie, { method: 'GET' }))
      diagnostics.save(r)
      return r
    }, outgoing)
  diagnostics.finish(parsed.finalUrl)
  const verified = null // Tree availability is not submission evidence.
  return {
    // These refer to the original POST, never overwritten by a result-page GET.
    status: initial.status,
    location: initial.location,
    finalUrl: parsed.finalUrl,
    ...bookingOutcome(parsed, verified),
  }
}

export { slotTimes }