import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cookieHeader, mapApplication, createPortalClient, PortalAuthError, TITLE_PREFIX } from '../src/portal.js'
test('authentication failure exposes actionable 401', () => {
  const error = new PortalAuthError('internal diagnostic')
  assert.equal(error.status, 401)
  assert.match(error.publicMessage, /门户自动认证未成功.*5 分钟/)
})
const row = { initiatorId: 'test-user', subject: TITLE_PREFIX + 'REDACTED', processInstanceStatus: 'RUNNING', bizDomain: 'oa', processInstanceId: '123', processInstanceRecordUrl: 'https://oa.shanghaitech.edu.cn/workflow/request/ViewRequest.jsp?requestid=123', createTime: '2026-01-01 12:00:00' }
test('explicit OA mapping, own applicant, exact prefix and RUNNING only', () => {
  assert.equal(mapApplication(row, 'test-user').requestId, '123')
  for (const change of [{ initiatorId: 'other' }, { processInstanceStatus: 'COMPLETE' }, { subject: 'other' }]) assert.equal(mapApplication({ ...row, ...change }, 'test-user'), null)
  assert.throws(() => mapApplication({ ...row, processInstanceId: '999' }, 'test-user'), /inconsistent/)
  assert.throws(() => mapApplication({ ...row, processInstanceRecordUrl: 'https://evil.test/?requestid=123' }, 'test-user'), /requestid/)
})
test('cookie scopes do not leak CAS or OA cookies to portal; path boundary and expiry', () => {
  const cookies = [{name:'portal',value:'ok',domain:'egate-new.shanghaitech.edu.cn',hostOnly:true,path:'/',secure:true}, {name:'oa',value:'no',domain:'oa.shanghaitech.edu.cn',hostOnly:true,path:'/'}, {name:'CASTGC',value:'no',domain:'ids.shanghaitech.edu.cn',hostOnly:true,path:'/'}, {name:'scoped',value:'no',domain:'egate-new.shanghaitech.edu.cn',hostOnly:true,path:'/get'}, {name:'expired',value:'no',domain:'egate-new.shanghaitech.edu.cn',hostOnly:true,path:'/',expires:1}]
  assert.equal(cookieHeader(cookies, 'https://egate-new.shanghaitech.edu.cn/getLoginUser'), 'portal=ok')
})
test('real transport shape, dynamic card and pagination, no mutation dispatcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-')), file = path.join(dir,'session.json')
  fs.writeFileSync(file,JSON.stringify({cookies:[{name:'portal',value:'test',domain:'egate-new.shanghaitech.edu.cn',hostOnly:true,path:'/'}]}))
  const calls=[]
  const fetchImpl=async (url,opts) => {
    calls.push({url,opts})
    let data
    if(url.endsWith('/getLoginUser')) data={userAccount:'test-user'}
    else if(url.includes('/getPageView')) data={pageContext:{pageInfoEntity:{cardLayout:JSON.stringify([{cards:[{cardId:'CUS_CARD_MYTASKLIST',cardWid:'dynamic'}]}])}}}
    else {
      const body=JSON.parse(opts.body)
      assert.equal(body.method,'renderData'); assert.equal(body.param.processInstanceStatus,'RUNNING')
      assert.equal(opts.method,'POST'); assert.ok(url.endsWith('/execCardMethod/dynamic/CUS_CARD_MYTASKLIST'))
      data={total:2, datas:body.param.pageNum===1?[row]:[{...row, processInstanceId:'124',processInstanceRecordUrl:row.processInstanceRecordUrl.replace('123','124')}]}
    }
    return {status:200,ok:true,json:async()=>({errcode:'0',data})}
  }
  try {
    assert.equal((await createPortalClient({sessionFile:file,fetchImpl,pageSize:1}).listPendingApplications()).length,2)
    assert.equal(calls.length,4)
    await assert.rejects(createPortalClient({sessionFile:file,fetchImpl:async()=>({status:302,headers:{get:()=> 'https://ids.shanghaitech.edu.cn/authserver/login'}})}).listPendingApplications(),PortalAuthError)
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})
