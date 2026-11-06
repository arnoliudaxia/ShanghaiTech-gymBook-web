import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionRecovery, createOaReadonlyFetch, isOaAuthLost, isSafeOaReadonlyUrl } from '../src/oa-readonly.js'
import { AuthLostError } from '../src/oa.js'

const URL = 'https://oa.shanghaitech.edu.cn/workflow/request/ViewRequest.jsp?requestid=123'
const reply = (status = 200, text = 'OK', location) => new Response(text, { status, headers: location ? { location } : {} })
function setup(fetch, login = async () => 'new') {
  let time = 0, logins = 0
  const session = { cookie: 'old', logins: 0 }
  const recovery = createSessionRecovery({ session, login: async () => { logins++; return login() }, now: () => time })
  return { ...recovery, session, advance: ms => { time += ms }, logins: () => logins,
    get: createOaReadonlyFetch({ ...recovery, fetch }) }
}

test('positive auth evidence only, including CAS form without following redirects', () => {
  for (const status of [401, 403]) assert.equal(isOaAuthLost({ status }), true)
  for (const location of ['https://ids.shanghaitech.edu.cn/authserver/login?service=x', '/authserver/login', '/login.jsp']) {
    assert.equal(isOaAuthLost({ status: 302, location, url: URL }), true)
  }
  assert.equal(isOaAuthLost({ status: 200, text: `<form id='casLoginForm'><input type='password'></form>` }), true)
  assert.equal(isOaAuthLost({ status: 200, text: `<form><input type="password"><input name="execution"></form>` }), true)
  for (const text of ['<html><iframe></iframe></html>', 'networkfailure', 'permission denied', '<script>var x="/authserver/login"</script>', '<form><input type="password"></form>']) {
    assert.equal(isOaAuthLost({ status: 200, text }), false)
  }
})

test('renews once, uses renewed cookie, and returns adapter/native fields', async () => {
  const cookies = []
  const s = setup(async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual')
    cookies.push(init.headers.get('cookie'))
    return cookies.length === 1 ? reply(302, '', '/authserver/login') : reply()
  })
  const result = await s.get(URL)
  assert.deepEqual(cookies, ['shkjdx_session=old', 'shkjdx_session=new'])
  assert.equal(s.logins(), 1); assert.equal(result.cookie, 'new'); assert.equal(result.status, 200)
  assert.equal(result.text, 'OK'); assert.ok(result.res)
})

test('concurrent expiry singleflights; late old failures cannot invalidate new cookie', async () => {
  const s = setup(async (url, init) => init.headers.get('cookie').endsWith('old') ? reply(401) : reply())
  await Promise.all(Array.from({ length: 12 }, () => s.get(URL)))
  assert.equal(s.logins(), 1)
  assert.equal(await s.relogin('late failure', 'old'), 'new')
  assert.equal(await s.ensureSession({ force: true, expectedCookie: 'old' }), 'new')
  assert.equal(s.logins(), 1)
})

test('failed login cooldown lasts five minutes, including initial ensureSession', async () => {
  const failure = new Error('offline login failure')
  const s = setup(async () => reply(401), async () => { throw failure })
  const publicFailure = err => err instanceof AuthLostError && err.status === 401 && err.cause === failure
  await assert.rejects(s.get(URL), publicFailure)
  await assert.rejects(s.ensureSession(), err => err === failure)
  await assert.rejects(s.get(URL), publicFailure)
  assert.equal(s.logins(), 1)
  s.advance(299999)
  await assert.rejects(s.relogin('again', 'old'))
  assert.equal(s.logins(), 1)
  s.advance(1)
  await assert.rejects(s.ensureSession())
  assert.equal(s.logins(), 2)
})

for (const status of [401, 403]) test(`successful login followed by ${status} cools down subsequent page refreshes`, async () => {
  let requests = 0
  const s = setup(async () => { requests++; return reply(status) })
  await assert.rejects(s.get(URL), AuthLostError)
  assert.equal(requests, 2); assert.equal(s.logins(), 1)
  await assert.rejects(s.get(URL), AuthLostError)
  assert.equal(requests, 3); assert.equal(s.logins(), 1)
  s.advance(300000)
  await assert.rejects(s.get(URL), AuthLostError)
  assert.equal(requests, 5); assert.equal(s.logins(), 2)
})

test('network failure and generic scaffold do not trigger login', async () => {
  const s = setup(async () => { throw new Error('networkfailure') })
  await assert.rejects(s.get(URL), /networkfailure/)
  assert.equal(s.logins(), 0)
  const scaffold = setup(async () => reply(200, '<html><iframe></iframe></html>'))
  assert.equal((await scaffold.get(URL)).status, 200)
  assert.equal(scaffold.logins(), 0)
})

test('rejects modifying GETs, POSTs, other origins and unsafe query parameters before fetch/auth', async () => {
  let calls = 0
  const get = createOaReadonlyFetch({ ensureSession: async () => { calls++; return 'x' }, relogin: async () => { calls++; return 'y' }, fetch: async () => { calls++; return reply() } })
  for (const url of [
    'https://oa.shanghaitech.edu.cn/workflow/workflow/wfFunctionManageLink.jsp?flag=rb&requestid=123',
    'https://oa.shanghaitech.edu.cn/workflow/request/RequestOperation.jsp',
    URL.replace('oa.shanghaitech.edu.cn', 'evil.example'), URL + '&operation=delete',
  ]) { assert.equal(isSafeOaReadonlyUrl(url), false); await assert.rejects(get(url), /Unsafe/) }
  await assert.rejects(get(URL, { method: 'POST' }), /Unsafe/)
  await assert.rejects(get(URL, { body: 'delete' }), /Unsafe/)
  assert.equal(calls, 0)
  assert.equal(isSafeOaReadonlyUrl('https://oa.shanghaitech.edu.cn/workflow/request/AddRequestIframe.jsp?workflowid=43364&nodeid=47012&isbill=1&formid=-248&requestid=-1'), true)
})

test('newer disk cookie reused without login; stale failures do not cool a newer generation', async () => {
  const session = { cookie: 'old', logins: 0 }
  const s = createSessionRecovery({ session, login: () => assert.fail('no remote login'), readDiskCookie: () => 'disk-new' })
  assert.equal(await s.relogin('expired', 'old'), 'disk-new')
  s.noteAuthFailure('old')
  assert.equal(await s.relogin('late', 'old'), 'disk-new')
})
