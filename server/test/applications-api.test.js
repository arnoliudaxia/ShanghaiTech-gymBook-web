import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installApplicationsRoutes } from '../src/applications-api.js'

async function server(dependencies, run) {
  const app = express()
  app.use(express.json())
  installApplicationsRoutes(app, dependencies)
  const instance = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => instance.once('listening', resolve))
  try { await run(`http://127.0.0.1:${instance.address().port}`) }
  finally { await new Promise((resolve) => instance.close(resolve)) }
}
const task = { id: 'portal-1', requestId: '123', title: '学生和教工场馆借用申请-测试', status: 'pending' }
const post = (url, body = { confirm: true }, headers = {}) => fetch(`${url}/api/applications/portal-1/cancel`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})

test('personal applications API returns the actual provider list, never fabricated local history', async () => {
  await server({ listPendingApplications: async () => [task] }, async (url) => {
    const res = await fetch(`${url}/api/applications`)
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()).applications, [task])
  })
})

test('cancellation requires confirmation and rejects cross-origin requests before any provider call', async () => {
  let calls = 0
  await server({ listPendingApplications: async () => { calls++; return [task] }, cancelApplication: async () => { calls++; } }, async (url) => {
    assert.equal((await post(url, {})).status, 400)
    assert.equal((await post(url, { confirm: true }, { origin: 'https://evil.example' })).status, 400)
    assert.equal(calls, 0)
  })
})

test('stale, non-pending, wrong-title and invalid-request tasks cannot be cancelled', async () => {
  let cancelled = 0
  for (const applications of [[], [{ ...task, status: 'completed' }], [{ ...task, title: '其他申请' }], [{ ...task, requestId: 'x' }]]) {
    await server({ listPendingApplications: async () => applications, cancelApplication: async () => { cancelled++ } }, async (url) => {
      assert.equal((await post(url)).status, 409)
    })
  }
  assert.equal(cancelled, 0)
})

test('cancellation uses trusted server task, ignores caller request identity and does not retry unknown', async () => {
  let calls = 0
  await server({ listPendingApplications: async () => [task], cancelApplication: async (value) => {
    calls++; assert.deepEqual(value, task)
    return { ok: false, state: 'unknown', message: '请核实' }
  } }, async (url) => {
    const res = await post(url, { confirm: true, requestId: '999', url: 'https://evil.example' })
    assert.equal(res.status, 202)
    assert.equal((await res.json()).state, 'unknown')
  })
  assert.equal(calls, 1)
})

test('portal failure is reported as an error, not an empty list', async () => {
  await server({ listPendingApplications: async () => { throw new Error('private details') } }, async (url) => {
    const res = await fetch(`${url}/api/applications`)
    assert.equal(res.status, 502)
    const result = await res.json()
    assert.equal(result.ok, false)
    assert.ok(!JSON.stringify(result).includes('private details'))
  })
})
