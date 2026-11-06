import { AuthLostError } from './oa.js'
import { safeResultUrl } from './booking-response.js'

const OA_BASE = 'https://oa.shanghaitech.edu.cn'
export const LOGIN_FAILURE_COOLDOWN_MS = 5 * 60 * 1000

/** Shared by cron and request handlers. expectedCookie is the cookie that failed,
 * not the currently cached cookie. Late failures must not discard a newer login.
 * Dependencies keep tests entirely offline (including persistence and clock).
 */
export function createSessionRecovery({ session, login, persist = () => {}, readDiskCookie = () => null, now = Date.now, cooldownMs = LOGIN_FAILURE_COOLDOWN_MS }) {
  let inflight = null, failedAt = null, failure = null
  async function ensureSession({ force = false, expectedCookie } = {}) {
    if (inflight) return inflight
    if (force && expectedCookie !== undefined && session.cookie && session.cookie !== expectedCookie) return session.cookie
    if (!force && session.cookie) return session.cookie
    if (failedAt !== null && now() - failedAt < cooldownMs) throw failure
    if (force) session.cookie = null
    inflight = Promise.resolve().then(login).then(cookie => {
      if (!cookie) throw new Error('OA login returned no cookie')
      Object.assign(session, { cookie, savedAt: now(), lastLoginAt: now(), logins: session.logins + 1 })
      failedAt = null; failure = null
      persist()
      return cookie
    }).catch(err => {
      failedAt = now(); failure = err
      throw err
    }).finally(() => { inflight = null })
    return inflight
  }
  async function relogin(reason, expectedCookie = session.cookie) {
    if (inflight) return inflight
    if (session.cookie && session.cookie !== expectedCookie) return session.cookie
    if (failedAt !== null && now() - failedAt < cooldownMs) throw failure
    const disk = readDiskCookie()
    if (disk && disk !== expectedCookie) {
      session.cookie = disk
      return disk
    }
    return ensureSession({ force: true, expectedCookie })
  }
  function noteAuthFailure(cookie) {
    if (cookie !== session.cookie) return
    failedAt = now()
    failure = new AuthLostError('OA renewal did not restore readonly access; retry after cooldown')
  }
  return { ensureSession, relogin, noteAuthFailure }
}

function loginUrl(value, base) {
  try {
    const url = new URL(value, base)
    return url.hostname === 'ids.shanghaitech.edu.cn' || /\/(?:authserver|cas)\/login(?:[;/]|$)|\/(?:login|login\.jsp)(?:[;/]|$)/i.test(url.pathname)
  } catch { return false }
}

/** Positive auth evidence only: generic OA scaffolds, errors and network failures
 * are NOT evidence of expiry. Never follow CAS redirects with an OA cookie.
 */
export function isOaAuthLost({ status, location = '', url = '', text = '' }) {
  if (status === 401 || status === 403) return true
  if (status >= 300 && status < 400 && location && loginUrl(location, url || OA_BASE)) return true
  if (url && loginUrl(url, OA_BASE)) return true
  const html = String(text).replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  return /<form\b/i.test(html) && /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html) &&
    /(?:\bname\s*=\s*["'](?:execution|lt)["']|\bid\s*=\s*["']casLoginForm["']|\baction\s*=\s*["'][^"']*\/(?:authserver|cas)\/login)/i.test(html)
}

/** Narrow URL allowlist, including the exact fresh booking form and deletion
 * marker. In particular wfFunctionManageLink and RequestOperation are excluded.
 */
export function isSafeOaReadonlyUrl(value) {
  try {
    const url = new URL(value)
    if (url.origin !== OA_BASE || url.username || url.password || url.hash) return false
    if (url.pathname === '/workflow/request/AddRequestIframe.jsp') {
      const expected = { workflowid: '43364', nodeid: '47012', isbill: '1', formid: '-248', requestid: '-1' }
      return [...url.searchParams].length === 5 && Object.entries(expected).every(([k, v]) => url.searchParams.getAll(k).length === 1 && url.searchParams.get(k) === v)
    }
    return (url.pathname === '/notice/Deleted.jsp' && url.search === '?showtype=wf') || Boolean(safeResultUrl(url.href, OA_BASE))
  } catch { return false }
}

/** Returns both native {res,text,cookie} and application-adapter fields.
 * At most two GETs and one relogin; no automatic redirect following or POST.
 * relogin(reason, staleCookie) MUST preserve newer sessions and singleflight.
 */
export function createOaReadonlyFetch({ ensureSession, relogin, noteAuthFailure = () => {}, fetch: fetchImpl = globalThis.fetch }) {
  return async function oaReadonlyFetch(url, init = {}) {
    if ((init.method || 'GET').toUpperCase() !== 'GET' || init.body != null || !isSafeOaReadonlyUrl(url)) throw new Error('Unsafe readonly OA request')
    const authenticated = async (action) => {
      try { return await action() }
      catch (error) {
        if (error instanceof AuthLostError) throw error
        throw new AuthLostError('OA automatic authentication failed', { cause: error })
      }
    }
    let cookie = await authenticated(() => ensureSession())
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(init.headers)
      headers.set('cookie', `shkjdx_session=${cookie}`)
      if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0')
      const res = await fetchImpl(url, { ...init, method: 'GET', headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30000) })
      const text = await res.text()
      const response = { res, text, cookie, status: res.status, url: res.url || String(url), location: res.headers.get('location') || '', headers: Object.fromEntries(res.headers) }
      if (!isOaAuthLost(response)) return response
      if (attempt === 1) {
        noteAuthFailure(cookie)
        throw new AuthLostError('OA readonly authentication still expired after renewal')
      }
      cookie = await authenticated(() => relogin('OA 只读请求认证失效', cookie))
    }
  }
}
