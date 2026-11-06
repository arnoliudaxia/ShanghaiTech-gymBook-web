import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationQuery } from '../src/applications-query.js'
import { DELETED_MARKER, OA_BASE, confirmDeletedRequest } from '../src/oa-request.js'
const task = { id: '123', requestId: '123', status: 'pending', title: '学生和教工场馆借用申请-测试' }

test('stale portal pending rows are excluded only after OA deletion marker verification', async () => {
  const urls = [], reconciled = []
  const query = createApplicationQuery({ onDeleted: async item => reconciled.push(item.id), listPendingApplications: async () => [task], getOwnApplicantId: async () => '42', get: async (url) => {
    urls.push(url)
    if (url.includes('ViewRequest.jsp')) return { status: 302, url, location: `${OA_BASE}/notice/Deleted.jsp?showtype=wf`, text: '' }
    return { status: 200, url, text: `<p>${DELETED_MARKER}</p>` }
  } })
  const result = await query()
  assert.equal(result.sourceCount, 1)
  assert.equal(result.deletedCount, 1)
  assert.deepEqual(result.applications, [])
  assert.equal(urls.length, 2)
  assert.deepEqual(reconciled, ['123'])
})

test('missing deletion proof or network failure retains a visibly unverified non-actionable row', async () => {
  for (const get of [async (url) => ({ status: 200, url, text: '<html>empty scaffold</html>' }), async () => { throw new Error('offline') }]) {
    const result = await createApplicationQuery({ listPendingApplications: async () => [task], getOwnApplicantId: async () => '42', get })()
    assert.equal(result.deletedCount, 0)
    assert.equal(result.applications[0].canCancel, false)
    assert.equal(result.unverifiedCount, 1)
  }
})

test('shared deletion proof handles actual script navigation and every readonly response in a chain', async () => {
  const url = `${OA_BASE}/workflow/request/ViewRequest.jsp?requestid=123`
  const response = { status: 200, url, text: "<script>wfforward('/notice/Deleted.jsp?showtype=wf')</script>" }
  let reads = 0
  const get = async (target) => { reads++; assert.equal(target, `${OA_BASE}/notice/Deleted.jsp?showtype=wf`); return { status: 200, url: target, text: DELETED_MARKER } }
  assert.equal(await confirmDeletedRequest([{ status: 200, url, text: 'wrapper' }, response], get), true)
  const result = await createApplicationQuery({ listPendingApplications: async () => [task], getOwnApplicantId: async () => '42', get: async (target) => target.includes('/notice/') ? get(target) : response })()
  assert.equal(result.deletedCount, 1)
  assert.equal(reads, 2)
  const before = reads
  assert.equal(await confirmDeletedRequest([{ ...response, text: "<script>function unused(){wfforward('/notice/Deleted.jsp?showtype=wf')}</script>" }], get), false)
  assert.equal(reads, before)
})

test('existing matching own OA request is actionable and empty portal list performs no OA reads', async () => {
  const fields = { requestid: '123', workflowid: '43364', field31876: '42', field32340: '5', field31901: '2026-11-08', field31902: '9', field31883: '63_23' }
  const text = Object.entries(fields).map(([name, value]) => `<input name="${name}" value="${value}">`).join('')
  const result = await createApplicationQuery({ listPendingApplications: async () => [task], getOwnApplicantId: async () => '42', get: async (url) => ({ status: 200, url, text }) })()
  assert.equal(result.applications[0].canCancel, true)
  const empty = await createApplicationQuery({ listPendingApplications: async () => [], getOwnApplicantId: async () => { throw Error('must not call') }, get: async () => { throw Error('must not call') } })()
  assert.equal(empty.sourceCount, 0)
})
