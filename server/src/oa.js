/**
 * OA 接口客户端 —— 与 Python 版 (ShanghaiTech-gymBook/main_ext.py) 逻辑等价
 *
 * 认证：CAS 统一认证
 *   1. GET  AddRequest.jsp?workflowid=14862  → 302 到 ids.shanghaitech.edu.cn/authserver/login?service=...
 *   2. 登录页 HTML 里取 pwdEncryptSalt / execution / lt
 *   3. 密码 = base64( AES-128-CBC( key=salt, iv="Nu1L"*4, "Nu1L"*16 + password ) )  ← 前 64 字节是服务端丢弃的填充
 *   4. POST 表单 → 302 链 → 拿到 cookie shkjdx_session
 *
 * 业务：泛微 OA 树形浏览接口
 *   POST CustomTreeBrowserAjax.jsp?id=63
 *        dataconditionParam=_sfn_31901_sfv_<日期>_sfn_31902_sfv_<时段1..11>_sfn_32340_sfv_<分类号>
 *        body: pid=<节点>&name=
 *   节点层级：63_1(根) → 63_<分类>(如 63_6 室内羽毛球) → 63_<场地>(如 63_13 场地1号)
 *   语义：
 *     - 分类 isParent=true  展开分类节点 → 返回该时段仍可约的具体场地（空数组 = 满场）
 *     - 分类 isParent=false 无子场地，看它在根层结果里是否出现（出现 = 可约）
 *     - 条件值非法（如时段 99）会被服务端静默忽略，因此可用它一次性列出全部分类
 */
import crypto from 'node:crypto'

const OA_BASE = 'https://oa.shanghaitech.edu.cn'
const LOGIN_ENTRY = `${OA_BASE}/workflow/request/AddRequest.jsp?workflowid=14862`
const TREE_AJAX = `${OA_BASE}/formmode/tree/treebrowser/CustomTreeBrowserAjax.jsp`
const ROOT_NODE = '63_1'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

/** 时段：字段 31902 的 1..11 → 11:00-12:00 ... 21:00-22:00 */
export const SLOTS = Array.from({ length: 11 }, (_, i) => {
  const h = 11 + i
  return `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`
})

export class LoginError extends Error {}
/** 采集途中 shkjdx_session 失效（被踢下线 / 过期 / 需要重新认证） */
export class AuthLostError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ cookie */
function storeCookies(jar, res) {
  const list = res.headers.getSetCookie?.() ?? []
  for (const line of list) {
    const pair = line.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
  }
}

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

async function request(url, { jar, method = 'GET', body, headers = {}, timeout = 20000 } = {}) {
  const h = { 'user-agent': UA, accept: '*/*', ...headers }
  const c = cookieHeader(jar)
  if (c) h.cookie = c
  const res = await fetch(url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) })
  storeCookies(jar, res)
  return res
}

/* ------------------------------------------------------------------ 加解密 */
export function encryptPassword(password, salt) {
  const key = Buffer.from(salt, 'utf8')           // 16 字符 → AES-128
  const iv = Buffer.from('Nu1LNu1LNu1LNu1L')      // 固定 IV
  const prefix = Buffer.from('Nu1L'.repeat(16))   // 64 字节无意义填充
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(password, 'utf8')])), cipher.final()]).toString('base64')
}

function pickHiddenField(html, name) {
  const anchor = name === 'pwdEncryptSalt' ? `id="${name}"` : `name="${name}"`
  const start = html.indexOf(anchor)
  if (start === -1) return ''
  const raw = html.slice(start, html.indexOf('/>', start))
  const vs = raw.indexOf('value="')
  if (vs === -1) return ''
  const from = vs + 7
  return raw.slice(from, raw.indexOf('"', from))
}

const isRedirect = (s) => s >= 300 && s < 400

/* ------------------------------------------------------------------ 登录 */
export async function loginOa(username, password) {
  if (!username || !password) throw new LoginError('缺少 OA 账号或密码')
  const jar = new Map()

  let res = await request(LOGIN_ENTRY, { jar })
  if (!isRedirect(res.status)) throw new LoginError(`OA 入口未重定向，状态码 ${res.status}`)

  let url = new URL(res.headers.get('location'), LOGIN_ENTRY).href
  for (let i = 0; i < 10; i++) {
    res = await request(url, { jar })
    if (res.status === 200) break
    if (!isRedirect(res.status)) throw new LoginError(`重定向链中断，状态码 ${res.status}`)
    url = new URL(res.headers.get('location'), url).href
  }

  const html = await res.text()
  const salt = pickHiddenField(html, 'pwdEncryptSalt')
  const execution = pickHiddenField(html, 'execution')
  const lt = pickHiddenField(html, 'lt')
  if (!salt || !execution) throw new LoginError('CAS 页面缺少 pwdEncryptSalt / execution')

  const form = new URLSearchParams({
    username,
    password: encryptPassword(password, salt),
    lt,
    dllt: 'generalLogin',
    execution,
    _eventId: 'submit',
    rmShown: '1',
  })

  let post = await request(url, {
    jar,
    method: 'POST',
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  let postUrl = url
  for (let i = 0; i < 10; i++) {
    if (!isRedirect(post.status)) break
    postUrl = new URL(post.headers.get('location') || '', postUrl).href
    post = await request(postUrl, { jar })
  }

  const text = await post.text()
  if (/authError|用户名或密码|incorrectPassword/.test(text)) throw new LoginError('用户名或密码错误')
  if (text.includes('pwdEncryptSalt') && /captcha|验证码/i.test(text)) {
    throw new LoginError('CAS 要求输入验证码（通常是失败次数过多触发），请在浏览器手动登录一次后再试')
  }

  const session = jar.get('shkjdx_session')
  if (!session) throw new LoginError('登录结束但没拿到 shkjdx_session')
  return session
}

/* ------------------------------------------------------------------ 树接口 */

/**
 * 判断响应是否代表“登录态丢失”：
 *   - 3xx 重定向到 CAS/OA 登录页
 *   - 200 但响应体不是 JSON 数组（登录页 HTML、错误页、空响应）
 * 注意：该接口正常响应的 content-type 也是 text/html（返回的是 JSON 字符串），
 * 所以**不能**按 content-type 判断，只能看响应体是否以 '[' 开头。
 * 否则会把“约满”和“掉线”混为一谈，写出脏数据。
 */
function looksAuthLost(res, text) {
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || ''
    return /authserver|login|ids\.shanghaitech/i.test(loc)
  }
  return !text.startsWith('[')
}
export class TreeClient {
  constructor(sessionCookie, { retries = 3, timeout = 8000 } = {}) {
    this.cookie = `shkjdx_session=${sessionCookie}`
    this.retries = retries
    this.timeout = timeout
  }

  /** 展开某节点；返回 JSON 数组，彻底失败返回 null */
  async expand(pid, cat, slot, date) {
    const url =
      `${TREE_AJAX}?id=63&dataconditionParam=_sfn_31901_sfv_${date}` +
      `_sfn_31902_sfv_${slot}_sfn_32340_sfv_${cat}`
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'user-agent': UA,
            cookie: this.cookie,
            'content-type': 'application/x-www-form-urlencoded',
            'x-requested-with': 'XMLHttpRequest',
          },
          body: new URLSearchParams({ pid, name: '' }).toString(),
          signal: AbortSignal.timeout(this.timeout),
        })
        const text = (await res.text()).trim()
        if (looksAuthLost(res, text)) throw new AuthLostError('shkjdx_session 已失效或过期')
        return text.startsWith('[') ? JSON.parse(text) : []
      } catch (err) {
        if (err instanceof AuthLostError) throw err // 失效不做重试，交给上层重登
        if (attempt === this.retries - 1) return null
        await sleep(300 * (attempt + 1))
      }
    }
    return null
  }

  /** 枚举根节点下的全部场馆分类（slot 传非法值 99 以旁路时段条件） */
  async discover(catMax = 16) {
    const found = []
    const seen = new Set()
    for (let cat = 1; cat < catMax; cat++) {
      const nodes = (await this.expand(ROOT_NODE, cat, 99, '2000-01-01')) ?? []
      for (const n of nodes) {
        if (seen.has(n.id)) continue
        seen.add(n.id)
        found.push({
          id: n.id,
          name: n.name,
          cat,
          isParent: String(n.isParent).toLowerCase() === 'true',
          children: Number(n.childNum) || 0,
        })
      }
      await sleep(20)
    }
    return found
  }

  /** 查询单个场馆某天某时段的可约场地数组；null = 请求失败 */
  async cell(venue, date, slot) {
    if (venue.isParent) {
      const nodes = await this.expand(venue.id, venue.cat, slot, date)
      return nodes === null ? null : nodes.map((n) => n.name)
    }
    const nodes = await this.expand(ROOT_NODE, venue.cat, slot, date)
    if (nodes === null) return null
    return nodes.some((n) => n.id === venue.id) ? [venue.name] : []
  }
}