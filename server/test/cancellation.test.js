import test from 'node:test'
import assert from 'node:assert/strict'
import { createCancellationService } from '../src/cancellation.js'
import { successfulControls, readOwnRequest, requestEvidence, verifySubmissionRequest, OA_BASE, DELETED_MARKER } from '../src/oa-request.js'

const rid = '12345', own = '999'
const fields = { requestid: rid, workflowid: '43364', field31876: own, field32340: '6', field31901: '2026-11-09', field31902: '3', field31883: '63_25', nodetype: '0' }
const inputs = (o = fields) => Object.entries(o).map(([k,v]) => `<input name='${k}' value='${v}'>`).join('')
const viewUrl = `${OA_BASE}/workflow/request/ViewRequest.jsp?requestid=${rid}`
const editUrl = `${OA_BASE}/workflow/request/ManageRequestNoFormIframe.jsp?requestid=${rid}&reEdit=1`
const retractUrl = `${OA_BASE}/workflow/workflow/wfFunctionManageLink.jsp?f_weaver_belongto_userid=${own}&f_weaver_belongto_usertype=0&flag=rb&requestid=${rid}`
const live = `${inputs()}<span>提交校园服务中心审核</span><button _disabled='true' class='e8_btn_top_first_disabled' onclick='doRetract(this)'>强制收回</button><script>function doRetract(){location.href='${retractUrl}'}</script>`
const edit = `<form method=post action='/workflow/request/RequestOperation.jsp'>${inputs()}<input name=src><input name=dup value=a><input name=dup value=b><textarea name=remark>hello &amp; bye</textarea></form><script>function doDelete(){}</script>`
const response = (url, text, status = 200, location = '') => ({url,text,status,location})
function harness({ failAt, scaffold = false, wrong = false, marker = true, alreadyDeleted = false, workflow = '43364', editWorkflow = workflow, viewFrameAfterRetract = false } = {}) {
  const calls = [], journal = new Map(), persisted = []
  const service = createCancellationService({
    listPendingApplications: async () => [{ id: 'task-1', requestId: rid, title: '学生和教工场馆借用申请-测试', status: 'pending' }],
    getOwnApplicantId: async () => own, journal, persist: async (...v) => persisted.push(v),
    transport: async (url, init) => {
      calls.push({url, ...init})
      if (calls.length === failAt) throw new Error('secret transport failure')
      if (alreadyDeleted) return url.includes('/notice/Deleted.jsp') ? response(url, DELETED_MARKER.replace('！', '！ <br> ')) : response(url, '', 302, '/notice/Deleted.jsp?showtype=wf')
      if (url === retractUrl) return response(url, '', 302, viewFrameAfterRetract ? viewUrl : editUrl)
      if (viewFrameAfterRetract && !calls.some(c => c.method === 'POST') && calls.some(c => c.url === retractUrl)) {
        const frame = `${OA_BASE}/workflow/request/ViewRequestIframe.jsp?requestid=${rid}`
        if (url === viewUrl) return response(url, `<iframe src='${frame}'></iframe>`)
        if (url === frame) return response(url, edit)
      }
      if (url === editUrl) return response(url, edit.replace("name='workflowid' value='43364'", `name='workflowid' value='${editWorkflow}'`))
      if (init.method === 'POST') return response(url, '删除成功')
      if (calls.some(c => c.method === 'POST')) {
        if (url.includes('/notice/Deleted.jsp')) return response(url, marker ? DELETED_MARKER : 'scaffold')
        return response(url, '', 302, '/notice/Deleted.jsp?showtype=wf')
      }
      const livePage = live.replace("name='workflowid' value='43364'", `name='workflowid' value='${workflow}'`)
      return response(url, scaffold ? '<html>OA</html>' : wrong ? livePage.replace(`value='${own}'`, "value='998'") : livePage)
    },
  })
  return {service,calls,journal,persisted}
}

test('successful controls preserve duplicates, quotes, textareas and selected options', () => {
  const p = successfulControls(`<input name='a' value='1 > 0'><input name=a value=two><input name=x disabled value=no><input type=checkbox name=c><input type=checkbox checked name=c><textarea name=t>line1\n&lt;ok&gt;</textarea><select name=s><option value=a>A</option><option selected value='b'>B</option></select><fieldset disabled><input name=no value=no></fieldset>`)
  assert.deepEqual(p.getAll('a'), ['1 > 0','two'])
  assert.equal(p.get('c'), 'on'); assert.equal(p.get('t'), 'line1\r\n<ok>'); assert.equal(p.get('s'),'b'); assert.equal(p.has('no'),false)
})
test('scaffolds cannot establish existence; readonly iframe can', async () => {
  assert.equal((await readOwnRequest(rid, async u => response(u, '<html>OA</html>'))).state,'unknown')
  const iframeUrl = `${OA_BASE}/workflow/request/ViewRequestIframe.jsp?requestid=${rid}`
  const result = await readOwnRequest(rid, async u => response(u, u === viewUrl ? `<iframe src='${iframeUrl}'></iframe>` : inputs()), {field31876:own})
  assert.equal(result.state,'exists')
})
test('submission existence verifies identity; explicit failure never promoted even for existing draft', async () => {
  const initial = response(`${OA_BASE}/workflow/request/RequestOperation.jsp`, `<script>wfforward('${viewUrl}')</script>`)
  let count = 0
  const get = async u => {count++; return response(u,inputs())}
  const parsed = { state:'unknown', responses:[initial] }
  assert.equal((await verifySubmissionRequest(parsed,get,fields)).state,'ok')
  assert.equal((await verifySubmissionRequest(parsed,get,{...fields,field31876:'123'})).state,'unknown')
  const before = count
  assert.equal((await verifySubmissionRequest({...parsed,state:'failed'},get,fields)).state,'failed')
  assert.equal(count,before)
})
test('known legacy workflow exists but unrelated workflow and wrong form are rejected', () => {
  const legacy = {...fields,workflowid:'14862',formid:'-248'}
  const check = values => requestEvidence(response(viewUrl,inputs(values)),rid,{field31876:own})
  assert.equal(check(legacy).workflowId,'14862')
  assert.equal(check({...legacy,workflowid:'99999'}),null)
  assert.equal(check({...legacy,formid:'-249'}),null)
})
test('current submission cannot be promoted by an existing legacy workflow request', async () => {
  const initial = response(`${OA_BASE}/workflow/request/RequestOperation.jsp`, `<script>wfforward('${viewUrl}')</script>`)
  const result = await verifySubmissionRequest({state:'unknown',responses:[initial]},async url => response(url,inputs({...fields,workflowid:'14862',formid:'-248'})),{...fields,workflowid:'43364',formid:'-248'})
  assert.equal(result.state,'unknown')
})
test('legacy cancellation preserves exact live workflow in fresh editable form', async () => {
  const h = harness({workflow:'14862'})
  assert.equal((await h.service.cancelApplication({id:'task-1',requestId:rid})).state,'cancelled')
  assert.equal(new URLSearchParams(h.calls.find(c=>c.method==='POST').body).get('workflowid'),'14862')
  const mismatch = harness({workflow:'14862',editWorkflow:'43364'})
  assert.equal((await mismatch.service.cancelApplication({id:'task-1',requestId:rid})).state,'unknown')
  assert.equal(mismatch.calls.filter(c=>c.method==='POST').length,0)
})
test('native retract once, fresh edit controls, delete once, fresh visible deletion proof', async () => {
  const h = harness()
  const result = await h.service.cancelApplication({id:'task-1',requestId:rid})
  assert.equal(result.state,'cancelled')
  assert.equal(h.calls.filter(c=>c.url===retractUrl).length,1)
  const posts = h.calls.filter(c=>c.method==='POST'); assert.equal(posts.length,1)
  const p = new URLSearchParams(posts[0].body)
  assert.equal(p.get('src'),'delete'); assert.deepEqual(p.getAll('dup'),['a','b']); assert.equal(p.get('remark'),'hello & bye')
  const count = h.calls.length
  assert.equal((await h.service.cancelApplication({id:'task-1',requestId:rid})).replayBlocked,true)
  assert.equal(h.calls.length,count)
})
test('post-retract ViewRequest wrapper can reach the readonly ViewRequestIframe edit form', async () => {
  const h = harness({ viewFrameAfterRetract: true })
  const result = await h.service.cancelApplication({ id: 'task-1', requestId: rid })
  assert.equal(result.state, 'cancelled')
  assert.equal(h.calls.filter(c => c.url === retractUrl).length, 1)
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1)
  assert.ok(h.calls.some(c => c.url.includes('ViewRequestIframe.jsp')))
})
test('transport failure at mutation is unknown and never replayed', async () => {
  const h = harness({failAt:2})
  assert.equal((await h.service.cancelApplication({id:'task-1',requestId:rid})).state,'unknown')
  assert.equal(h.calls.length,2)
  await h.service.cancelApplication({id:'task-1',requestId:rid})
  assert.equal(h.calls.filter(c=>c.url===retractUrl).length,1)
  assert.equal(h.calls.filter(c=>c.method==='POST').length,0)
})
test('already deleted own pending portal task reconciles ledger without mutation', async () => {
  const h = harness({alreadyDeleted:true})
  const result = await h.service.cancelApplication({id:'task-1',requestId:rid})
  assert.equal(result.state,'cancelled'); assert.equal(result.stage,'already-deleted')
  assert.equal(h.calls.length,2)
  assert.ok(h.calls.every(c => c.method === 'GET' && !c.url.includes('wfFunctionManageLink')))
  assert.equal(h.persisted[0][1].state,'cancelled')
  const previousUnknown = harness({alreadyDeleted:true})
  previousUnknown.journal.set(rid, {state:'unknown',step:'delete',requestId:rid})
  assert.equal((await previousUnknown.service.cancelApplication({id:'task-1',requestId:rid})).state,'cancelled')
  assert.equal(previousUnknown.calls.length,2)
})
test('delete transport loss is step-aware unknown, not replayed', async () => {
  const h = harness({failAt:4})
  const result = await h.service.cancelApplication({id:'task-1',requestId:rid})
  assert.equal(result.state,'unknown'); assert.equal(result.stage,'delete')
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1)
  await h.service.cancelApplication({id:'task-1',requestId:rid})
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1)
  assert.equal(h.calls.filter(c=>c.url===retractUrl).length,1)
})
test('missing marker after Deleted redirect remains unknown', async () => {
  const h = harness({marker:false})
  assert.equal((await h.service.cancelApplication({id:'task-1',requestId:rid})).state,'unknown')
})
test('untrusted task, scaffold, or wrong applicant never mutates', async () => {
  for (const options of [{scaffold:true},{wrong:true}]) {
    const h = harness(options)
    assert.equal((await h.service.cancelApplication({id:'task-1',requestId:rid})).state,'ineligible')
    assert.equal(h.calls.length,1)
  }
  const h = harness()
  assert.equal((await h.service.cancelApplication({id:'not-own',requestId:rid})).state,'ineligible')
  assert.equal(h.calls.length,0)
})
test('per-request mutex prevents concurrent mutation', async () => {
  const h = harness()
  const a = h.service.cancelApplication({id:'task-1',requestId:rid})
  const b = await h.service.cancelApplication({id:'task-1',requestId:rid})
  assert.equal(b.state,'unknown'); await a
  assert.equal(h.calls.filter(c=>c.url===retractUrl).length,1)
})
