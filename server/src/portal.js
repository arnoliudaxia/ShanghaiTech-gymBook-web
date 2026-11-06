/** Read-only egate process tracking. Independent portal/CAS cookies; never OA cookies.
 * Only the allowlisted list reads may refresh authentication and replay once.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.js'
import { encryptPassword } from './oa.js'

export const PORTAL_BASE = 'https://egate-new.shanghaitech.edu.cn'
export const TITLE_PREFIX = '学生和教工场馆借用申请-'
const SESSION_FILE = path.join(ROOT, 'server/data/portal-session.json')
export class PortalAuthError extends Error {
  constructor(message = 'Portal authentication required') {
    super(message)
    this.status = 401
    this.publicMessage = '门户自动认证未成功，已暂停重试以保护账号。请约 5 分钟后刷新；若仍失败，请联系管理员检查服务端账号配置，或在统一认证页面处理验证码/账号锁定。'
  }
}

export function cookieHeader(cookies, url, now = Date.now()) {
  const u = new URL(url)
  return cookies.filter(c => (c.hostOnly ? u.hostname === c.domain : u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)) &&
    (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')) &&
    (!c.secure || u.protocol === 'https:') && (!c.expires || c.expires > now))
    .sort((a,b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ')
}

export function mapApplication(row, account) {
  if (!account || String(row.initiatorId) !== String(account) || row.processInstanceStatus !== 'RUNNING' ||
      !row.subject?.startsWith(TITLE_PREFIX) || row.bizDomain !== 'oa') return null
  // Do not invent an OA ID from portal wid or an unverified processInstanceId.
  const urls = [row.processInstanceRecordUrl, row.pcViewUrl, row.processInstanceImgUrl].filter(Boolean)
  const ids = urls.map(value => {
    try {
      const u = new URL(value)
      if (u.origin !== 'https://oa.shanghaitech.edu.cn') return null
      const id = u.searchParams.get('requestid')
      return /^\d+$/.test(id || '') ? id : null
    } catch { return null }
  }).filter(Boolean)
  if (!ids.length || new Set(ids).size !== 1 || String(row.processInstanceId) !== ids[0]) {
    throw new Error('Portal application has missing or inconsistent OA requestid')
  }
  return { id: ids[0], requestId: ids[0], title: row.subject, createdAt: row.createTime,
    status: 'pending', statusLabel: '待审核', url: `https://oa.shanghaitech.edu.cn/workflow/request/ViewRequest.jsp?requestid=${ids[0]}`,
    source: 'egate', sourceStatus: row.processInstanceStatus, sourceStatusLabel: '待审批',
    portalId: row.wid, nodeName: row.nodeName, processors: row.processors,
    oaExistenceVerified: false }
}

// Shared by all default clients (including separately created API requests).
export function createPortalAuth({ authenticate, stateFile, now = Date.now, cooldownMs = 300000 }) {
  let generation = 0, inflight, blockedUntil = 0
  function block(observed = generation) {
    if (observed !== generation) return
    blockedUntil = now() + cooldownMs
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ blockedUntil }), { mode: 0o600 })
  }
  return {
    get generation() { return generation },
    block,
    async refresh(observed = generation) {
      if (inflight) return inflight
      if (observed !== generation) return
      try { blockedUntil = Math.max(blockedUntil, JSON.parse(fs.readFileSync(stateFile, 'utf8')).blockedUntil || 0) }
      catch (error) { if (error.code !== 'ENOENT') throw new PortalAuthError('Unreadable authentication cooldown guard') }
      if (now() < blockedUntil) throw new PortalAuthError('Portal authentication cooling down')
      // Persist BEFORE contacting CAS: restart/crash cannot bypass the attempt guard.
      block()
      inflight = Promise.resolve().then(authenticate).then(() => {
        generation++
        fs.writeFileSync(stateFile, JSON.stringify({ blockedUntil: 0 }), { mode: 0o600 })
        blockedUntil = 0
      }).catch(() => { block(); throw new PortalAuthError('Automatic portal authentication failed') })
        .finally(() => { inflight = null })
      return inflight
    }
  }
}
const defaultAuth = createPortalAuth({ authenticate: () => provisionPortal(), stateFile: SESSION_FILE + '.auth-cooldown' })

function authEvidence(value) {
  return ['401', '403', '-401', 'UNAUTHORIZED', 'NOT_LOGIN', 'NOT_LOGGED_IN', 'SESSION_EXPIRED', 'LOGIN_REQUIRED'].includes(String(value?.errcode).toUpperCase()) ||
    /未登录|未登陆|登录已过期|会话.*(?:过期|失效)|not logged in|session expired|login required|unauthorized/i.test(String(value?.errmsg || value?.message || ''))
}
function listRead(endpoint, body) {
  if (!body) return endpoint === '/getLoginUser' || endpoint === '/getPageView?pageCode=taskList&lang=zh_CN'
  return endpoint === `/execCardMethod/${encodeURIComponent(body.cardWid)}/CUS_CARD_MYTASKLIST` &&
    body.cardId === 'CUS_CARD_MYTASKLIST' && body.method === 'renderData' &&
    body.param?.subject === TITLE_PREFIX && body.param?.processInstanceStatus === 'RUNNING'
}
export function createPortalClient({ fetchImpl = fetch, sessionFile = SESSION_FILE, pageSize = 10,
  auth = sessionFile === SESSION_FILE ? defaultAuth : null } = {}) {
  async function json(endpoint, body, context) {
    if (!listRead(endpoint, body)) throw new Error('Portal retry is restricted to list reads')
    const observed = auth?.generation
    try { return await requestJson(endpoint, body, observed) }
    catch (error) {
      if (!(error instanceof PortalAuthError) || !auth) throw error
      if (context.refreshed) { auth.block(observed); throw error }
      await auth.refresh(observed)
      context.refreshed = true
      const refreshedGeneration = auth.generation
      try { return await requestJson(endpoint, body, refreshedGeneration) }
      catch (retryError) {
        if (retryError instanceof PortalAuthError) auth.block(refreshedGeneration)
        throw retryError
      }
    }
  }
  async function requestJson(endpoint, body, generation) {
    let session
    try { session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) } catch { throw new PortalAuthError('Portal session missing; provision independent CAS session') }
    const url = PORTAL_BASE + endpoint
    const cookie = cookieHeader(session.cookies || [], url)
    if (!cookie) throw new PortalAuthError('Portal session missing or expired')
    const res = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { cookie, 'user-agent': 'Mozilla/5.0', 'x-requested-with': 'XMLHttpRequest', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 &&
        /ids\.shanghaitech\.edu\.cn|\/authserver\/|\/login(?:[/?#]|$)/i.test(res.headers?.get?.('location') || ''))) {
      throw new PortalAuthError('Portal session rejected; reauthentication required')
    }
    if (res.headers?.getSetCookie && (!auth || generation === auth.generation)) {
      updateCookies(session.cookies, res, url)
      fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 })
    }
    let value
    try { value = await res.json() } catch { throw new Error('Portal returned invalid JSON') }
    if (authEvidence(value) || authEvidence(value?.data)) throw new PortalAuthError('Portal reports authentication lost')
    if (!res.ok || String(value.errcode) !== '0') throw new Error('Portal list request failed: ' + String(value.errcode))
    if (endpoint === '/getLoginUser' && !value.data?.userAccount) throw new PortalAuthError('Portal returned anonymous user')
    return value.data
  }
  return { async listPendingApplications() {
    const context = { refreshed: false }
    const user = await json('/getLoginUser', undefined, context)
    if (!user?.userAccount) throw new PortalAuthError('Portal user is not authenticated')
    const bootstrap = await json('/getPageView?pageCode=taskList&lang=zh_CN', undefined, context)
    const layout = JSON.parse(bootstrap?.pageContext?.pageInfoEntity?.cardLayout || 'null')
    const cards = []
    function walk(v) { if (!v || typeof v !== 'object') return; if (v.cardId === 'CUS_CARD_MYTASKLIST' && v.cardWid) cards.push(v); for (const child of Object.values(v)) walk(child) }
    walk(layout)
    if (cards.length !== 1) throw new Error('Portal own-application card not uniquely configured')
    const { cardId, cardWid } = cards[0]
    const result = [], seen = new Set()
    for (let pageNum = 1; pageNum <= 100; pageNum++) {
      const data = await json(`/execCardMethod/${encodeURIComponent(cardWid)}/${cardId}`, {
        cardId, cardWid, method: 'renderData', param: { pageNum, pageSize, subject: TITLE_PREFIX,
          startTime: '', endTime: '', processInstanceStatus: 'RUNNING', _t: Date.now(), lang: 'zh_CN', platformType: 0 } }, context)
      if (!Array.isArray(data?.datas) || !Number.isInteger(data.total) || (data.errcode != null && String(data.errcode) !== '0')) throw new Error('Invalid portal pagination response')
      for (const row of data.datas) {
        const item = mapApplication(row, user.userAccount)
        if (item && !seen.has(item.requestId)) { seen.add(item.requestId); result.push(item) }
      }
      if (pageNum * pageSize >= data.total) return result
      if (!data.datas.length) throw new Error('Portal pagination ended before total')
    }
    throw new Error('Portal pagination exceeded safety limit')
  } }
}
export const listPendingApplications = (...args) => createPortalClient().listPendingApplications(...args)

function updateCookies(jar, res, url) {
  const u = new URL(url)
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair, ...attributes] = line.split(';'), eq = pair.indexOf('=')
    if (eq < 1) continue
    const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1), domain: u.hostname,
      hostOnly: true, path: u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/', secure: false }
    let maxAge
    for (const attribute of attributes) {
      const [key, ...parts] = attribute.trim().split('='), value = parts.join('=')
      switch (key.toLowerCase()) {
        case 'domain': c.domain = value.replace(/^\./, '').toLowerCase(); c.hostOnly = false; break
        case 'path': c.path = value.startsWith('/') ? value : '/'; break
        case 'secure': c.secure = true; break
        case 'expires': c.expires = Date.parse(value); break
        case 'max-age': maxAge = Number(value); break
      }
    }
    if (!(u.hostname === c.domain || u.hostname.endsWith('.' + c.domain))) continue
    // CAS occasionally emits overly broad edu.cn language cookies; never retain these.
    if (!c.domain.endsWith('.shanghaitech.edu.cn') && c.domain !== 'shanghaitech.edu.cn') continue
    if (Number.isFinite(maxAge)) c.expires = Date.now() + maxAge * 1000
    const index = jar.findIndex(x => x.name === c.name && x.domain === c.domain && x.path === c.path)
    if (index >= 0) jar.splice(index, 1)
    if (!c.expires || c.expires > Date.now()) jar.push(c)
  }
}

/** No client calls here: validate directly, avoiding recursive refresh.
 * Existing CAS TGC first, at most one password POST; CLI also respects cooldown.
 */
export async function loginPortal({ reauthenticate = false } = {}) {
  if (!reauthenticate && fs.existsSync(SESSION_FILE)) return
  return defaultAuth.refresh()
}
export async function provisionPortal({ fetchImpl = fetch, sessionFile = SESSION_FILE,
  username = process.env.MYUSERNAME, password = process.env.PASSWORD } = {}) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  let cookies = []
  try { cookies = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).cookies || [] } catch {}
  async function request(url, options = {}) {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !['egate-new.shanghaitech.edu.cn', 'ids.shanghaitech.edu.cn'].includes(u.hostname)) throw new PortalAuthError('Unexpected CAS redirect host')
    const res = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Mozilla/5.0', ...options.headers, cookie: cookieHeader(cookies, url) } })
    updateCookies(cookies, res, url)
    return res
  }
  async function follow(url, response) {
    for (let i = 0; i < 12; i++) {
      const res = response || await request(url); response = null
      if (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location'), url).href; continue }
      return { url, res }
    }
    throw new PortalAuthError('CAS redirect limit exceeded')
  }
  try {
    const href = await (await request(PORTAL_BASE + '/getLoginHref')).json()
    let { url, res } = await follow(href.data)
    const html = await res.text()
    if (new URL(url).hostname === 'ids.shanghaitech.edu.cn') {
      const field = name => {
        const tag = html.match(new RegExp('<input[^>]*(?:id|name)=["\\\']' + name + '["\\\'][^>]*>'))?.[0]
        return tag?.match(/value=["']([^"']*)/)?.[1] || ''
      }
      const salt = field('pwdEncryptSalt'), execution = field('execution')
      if (!salt || !execution || !username || !password) throw new PortalAuthError('CAS form or configured credentials unavailable')
      res = await request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password: encryptPassword(password, salt),
          execution, lt: field('lt'), dllt: 'generalLogin', _eventId: 'submit', rmShown: '1' }).toString() })
      if (res.status < 300 || res.status >= 400) throw new PortalAuthError('CAS login failed; no retry performed')
      await follow(url, res)
    }
    const user = await (await request(PORTAL_BASE + '/getLoginUser')).json()
    if (!user.data?.userAccount) throw new PortalAuthError('Portal login did not establish authenticated session')
    fs.writeFileSync(sessionFile, JSON.stringify({ cookies, savedAt: Date.now() }), { mode: 0o600 })
  } catch (error) {
    if (error instanceof PortalAuthError) throw error
    throw new PortalAuthError('Portal authentication failed')
  }
}
