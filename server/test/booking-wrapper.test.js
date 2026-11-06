import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseBookingResponse, safeResultUrl } from '../src/booking-response.js'
import { readOwnRequest, OA_BASE } from '../src/oa-request.js'

const capturedView = fs.readFileSync(new URL('./fixtures/booking-view-wrapper.html', import.meta.url), 'utf8')
// Variants for structural negative tests; capturedView preserves the actual source shape.
function wrapper(page = 'ViewRequest', marker = `${page}.jsp?`, offset = marker.length, frame = `${page}Iframe.jsp`) {
  return `<iframe id="bodyiframe" src=""></iframe><script>
var bodyiframeurl = location.href.substring(location.href.indexOf('${marker}') + ${offset});
bodyiframeurl=bodyiframeurl+"&forward="+forward+"&submit="+submit+"&f_weaver_belongto_userid="+userid+"&f_weaver_belongto_usertype="+usertype;
function setbodyiframe(){
 document.getElementById('bodyiframe').src='${frame}?'+bodyiframeurl;
 initNewRequestFrame1();
}
if(window.addEventListener){window.addEventListener('load',setbodyiframe,false);}
else if(window.attachEvent){window.attachEvent('onload',setbodyiframe);}
else{window.onload=setbodyiframe;}
</script>`
}
const response = (page, text) => ({ status:200, url:`${OA_BASE}/workflow/request/${page}.jsp?requestid=12345`, text })

test('captured completed View blank iframe resolves from exact native wrapper AST', () => {
  const parsed = parseBookingResponse(response('ViewRequest',capturedView))
  assert.deepEqual(parsed.navigations,['ViewRequestIframe.jsp?requestid=12345'])
  assert.equal(parsed.state,'unknown')
})
test('known blank View and Manage wrapper AST resolves only corresponding readonly iframe', () => {
  for (const page of ['ViewRequest','ManageRequestNoForm']) {
    const r = response(page,wrapper(page))
    const parsed = parseBookingResponse(r)
    assert.deepEqual(parsed.navigations,[`${page}Iframe.jsp?requestid=12345`])
    assert.equal(parsed.state,'unknown') // wrapper is not existence evidence
    assert.equal(safeResultUrl(parsed.navigations[0],r.url),`${OA_BASE}/workflow/request/${page}Iframe.jsp?requestid=12345`)
  }
})
test('wrong marker, offset, frame, function-only lookalikes and unsafe query stay unfollowable', () => {
  for (const text of [wrapper('ViewRequest','ViewRequest.jsp?',15), wrapper('ViewRequest','Other.jsp?',10),
    wrapper('ViewRequest','ViewRequest.jsp?',16,'RequestOperation.jsp'),
    wrapper('ViewRequest').replace('var bodyiframeurl =','function unrelated(){var bodyiframeurl =').replace('</script>','}</script>')]) {
    assert.deepEqual(parseBookingResponse(response('ViewRequest',text)).navigations,[])
  }
  const r = response('ViewRequest',wrapper()); r.url += '&src=delete'
  assert.deepEqual(parseBookingResponse(r).navigations,[])
  assert.equal(safeResultUrl('ViewRequestIframe.jsp?requestid=12345&submit=1',response('ViewRequest','').url),null)
})
test('readOwnRequest traverses blank dynamic View iframe without evaluating permission JS', async () => {
  const calls = []
  const fields = {requestid:'12345',workflowid:'43364',field31876:'999',field32340:'6',field31901:'2026-11-09',field31902:'3',field31883:'63_25'}
  const html = Object.entries(fields).map(([name,value])=>`<input name="${name}" value="${value}">`).join('')
  const result = await readOwnRequest('12345',async url => {
    calls.push(url)
    return {status:200,url,text:url.includes('ViewRequestIframe.jsp') ? html : capturedView}
  },{field31876:'999'})
  assert.equal(result.state,'exists'); assert.equal(result.applicantId,'999')
  assert.deepEqual(calls,[`${OA_BASE}/workflow/request/ViewRequest.jsp?requestid=12345`,`${OA_BASE}/workflow/request/ViewRequestIframe.jsp?requestid=12345`])
})
