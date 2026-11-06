import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPortalAuth, createPortalClient, provisionPortal, PortalAuthError } from '../src/portal.js'

const reply = (data, errcode = 0) => ({ status: 200, ok: true, headers: {}, json: async () => ({ errcode, data }) })
const card = { pageContext: { pageInfoEntity: { cardLayout: JSON.stringify([{ cardId: 'CUS_CARD_MYTASKLIST', cardWid: 'own' }]) } } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sessionFile = path.join(dir, 'session.json'), stateFile = sessionFile + '.auth-cooldown'
  let clock = 1000000, logins = 0
  function save(value = 'fresh', expires) {
    fs.writeFileSync(sessionFile, JSON.stringify({ cookies: [{ name: 'portal', value, domain: 'egate-new.shanghaitech.edu.cn', hostOnly: true, path: '/', expires }] }))
  }
  const authenticate = async () => { logins++; save() }
  const makeAuth = (fn = authenticate) => createPortalAuth({ authenticate: fn, stateFile, now: () => clock })
  const auth = makeAuth()
  function normal(url) {
    if (url.endsWith('/getLoginUser')) return reply({ userAccount: 'self' })
    if (url.includes('/getPageView')) return reply(card)
    assert.ok(url.endsWith('/execCardMethod/own/CUS_CARD_MYTASKLIST'))
    return reply({ total: 0, datas: [] })
  }
  const client = (fetchImpl = normal, manager = auth) => createPortalClient({ sessionFile, auth: manager, fetchImpl })
  return { dir, sessionFile, stateFile, save, auth, makeAuth, normal, client, get logins() { return logins }, advance: () => { clock += 300001 } }
}

test('missing/expired sessions refresh once; successful sessions reused across clients', async t => {
  for (const expired of [false, true]) {
    const f = fixture(t)
    if (expired) f.save('old', 1)
    await Promise.all(Array.from({ length: 40 }, () => f.client().listPendingApplications()))
    assert.equal(f.logins, 1)
    await f.client().listPendingApplications()
    assert.equal(f.logins, 1)
  }
})

test('delayed stale auth responses share completed refresh generation at every list endpoint', async t => {
  for (const target of ['/getLoginUser', '/getPageView', '/execCardMethod']) {
    const f = fixture(t); f.save('old')
    const gate = deferred(), entered = deferred()
    let delayed = true, rejected = false
    const transport = async (url, opts) => {
      const isTarget = url.includes(target)
      if (isTarget && opts.headers.cookie.includes('old')) {
        if (delayed) { delayed = false; entered.resolve(); await gate.promise }
        rejected = true
        return target === '/getLoginUser' ? reply({}) : reply(null, 'SESSION_EXPIRED')
      }
      return f.normal(url)
    }
    const slow = f.client(transport).listPendingApplications()
    await entered.promise
    await f.client(transport).listPendingApplications()
    assert.equal(f.logins, 1)
    gate.resolve()
    await slow
    assert.ok(rejected)
    assert.equal(f.logins, 1)
  }
})

test('failed auth is single flight, persistent cooldown, then permits a later attempt', async t => {
  const f = fixture(t); let attempts = 0
  const fail = async () => { attempts++; throw Error('wrong password') }
  const auth = f.makeAuth(fail)
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => f.client(undefined, auth).listPendingApplications()))
  assert.ok(results.every(x => x.status === 'rejected' && x.reason instanceof PortalAuthError))
  assert.equal(attempts, 1)
  await assert.rejects(f.client(undefined, f.makeAuth(fail)).listPendingApplications(), PortalAuthError)
  assert.equal(attempts, 1)
  f.advance()
  await assert.rejects(f.client(undefined, f.makeAuth(fail)).listPendingApplications(), PortalAuthError)
  assert.equal(attempts, 2)
})

test('successful login followed by persistent rejection retries ONCE and cools down across restart', async t => {
  for (const response of [() => ({ status: 403 }), () => reply({})]) {
    const f = fixture(t); f.save('old'); let calls = 0
    const fetchImpl = async () => { calls++; return response() }
    await assert.rejects(f.client(fetchImpl).listPendingApplications(), PortalAuthError)
    assert.equal(calls, 2); assert.equal(f.logins, 1)
    await assert.rejects(f.client(fetchImpl, f.makeAuth()).listPendingApplications(), PortalAuthError)
    assert.equal(f.logins, 1)
  }
})

test('generic backend, network, invalid JSON and empty page configuration never trigger auth', async t => {
  for (const failure of [async () => reply({}, 500), async () => { throw Error('network') },
    async () => ({ status: 502, ok: false, json: async () => { throw Error('html') } }),
    async url => url.includes('/getPageView') ? reply({}) : reply({ userAccount: 'self' })]) {
    const f = fixture(t); f.save()
    await assert.rejects(f.client(failure).listPendingApplications())
    assert.equal(f.logins, 0)
  }
})

test('one entire list query cannot authenticate twice at different endpoints', async t => {
  const f = fixture(t)
  let calls = 0
  await assert.rejects(f.client(async url => {
    calls++
    if (url.endsWith('/getLoginUser')) return reply({ userAccount: 'self' })
    return { status: 403 }
  }).listPendingApplications(), PortalAuthError)
  assert.equal(f.logins, 1)
  assert.equal(calls, 2) // missing session refresh, user succeeds, page rejects without another login
  await assert.rejects(f.auth.refresh(), PortalAuthError)
  assert.equal(f.logins, 1)
})

test('explicit auth errcodes refresh, but generic redirect and malformed page do not', async t => {
  for (const code of ['401', 'NOT_LOGIN', 'SESSION_EXPIRED']) {
    const f = fixture(t); f.save('old')
    await f.client(async (url, opts) => opts.headers.cookie.includes('old') ? reply(null, code) : f.normal(url)).listPendingApplications()
    assert.equal(f.logins, 1)
  }
  const f = fixture(t); f.save()
  await assert.rejects(f.client(async () => ({ status: 302, headers: { get: () => '/maintenance' }, json: async () => { throw Error('not json') } })).listPendingApplications())
  assert.equal(f.logins, 0)
})

test('restart during authentication retains pre-attempt cooldown guard', async t => {
  const f = fixture(t), gate = deferred()
  const auth = f.makeAuth(() => gate.promise)
  const first = auth.refresh()
  await assert.rejects(f.makeAuth().refresh(), PortalAuthError)
  assert.equal(f.logins, 0)
  gate.resolve(); await first
})

test('CAS saved cookies first; direct validation does not recurse or submit password', async t => {
  const f = fixture(t); f.save()
  const calls = []
  await provisionPortal({ sessionFile: f.sessionFile, fetchImpl: async (url, opts) => {
    calls.push({ url, opts })
    assert.notEqual(opts.method, 'POST')
    if (url.endsWith('/getLoginHref')) return reply('https://ids.shanghaitech.edu.cn/authserver/login')
    if (url.includes('ids.shanghaitech')) return { status: 302, headers: { get: () => 'https://egate-new.shanghaitech.edu.cn/home' } }
    if (url.endsWith('/home')) return { status: 200, headers: {}, text: async () => 'portal' }
    return reply({ userAccount: 'self' })
  } })
  assert.equal(calls.length, 4)
})

test('CAS password failure attempts at most one POST without recursion', async t => {
  const f = fixture(t); let posts = 0
  await assert.rejects(provisionPortal({ sessionFile: f.sessionFile, username: 'fake', password: 'fake', fetchImpl: async (url, opts) => {
    if (url.endsWith('/getLoginHref')) return reply('https://ids.shanghaitech.edu.cn/authserver/login')
    if (opts.method === 'POST') { posts++; return { status: 200, headers: {} } }
    return { status: 200, headers: {}, text: async () => '<input name="pwdEncryptSalt" value="1234567890123456"><input name="execution" value="fake">' }
  } }), PortalAuthError)
  assert.equal(posts, 1)
})
