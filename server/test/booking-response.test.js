import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { submissionPayload, parseBookingResponse, safeResultUrl, followBookingResults, bookingOutcome, decodeEntities } from '../src/booking-response.js'
import { createBookingDiagnostics } from '../src/booking-diagnostics.js'

const base = 'https://oa.shanghaitech.edu.cn/workflow/request/RequestOperation.jsp'
const errorUrl = 'https://oa.shanghaitech.edu.cn/notice/RequestError.jsp?message=126221'
const script = (js) => `<script>${js}</script>`
const parse = (text) => parseBookingResponse({ text })

test('src submit overrides an empty or untrusted hidden src and overrides', () => {
  assert.deepEqual(submissionPayload({ src: '', token: 'kept' }, { src: 'save', field: 'value' }), { src: 'submit', token: 'kept', field: 'value' })
  assert.equal(submissionPayload({ src: 'delete' }).src, 'submit')
})

test('literal navigation calls and assignments; JS escapes and HTML entities', () => {
  for (const js of [
    `location='/notice/RequestError.jsp?message=1&amp;x=2';`,
    `window.top.location.href = "/notice/RequestError.jsp?message=1&#38;x=2";`,
    `wfforward('/notice/RequestError.jsp?message=1\\x26x=2');`,
  ]) assert.deepEqual(parse(script(js)).navigations, ['/notice/RequestError.jsp?message=1&x=2'])
  assert.deepEqual(parseBookingResponse({ status: 302, location: '/notice/RequestError.jsp?message=1&amp;x=2' }).navigations, ['/notice/RequestError.jsp?message=1&x=2'])
  assert.equal(decodeEntities('&#x5DE5;&#20316;&nbsp;&quot;&apos;&lt;&gt;&amp;'), '工作 "\'<>&')
})

test('shared JS definitions, callbacks, strings, comments and dynamic expressions are not evidence', () => {
  const parsed = parse(script(`
    function wfforward(wfurl) { parent.location.href = wfurl; }
    function ReloadOpenerByDialogClose() { document.location='/login/VerifyRtxLogin.jsp'; }
    function validate() { Dialog.alert('工作流初始错误'); location='/notice/RequestError.jsp'; }
    const notify = () => Dialog.alert('预约成功');
    jQuery(function () { wfforward('/notice/RequestError.jsp'); });
    // wfforward('/notice/RequestError.jsp');
    var text = "工作流初始错误 location='/notice/RequestError.jsp'";
    wfforward(url); Dialog.alert('错误' + detail);
  `) + '<style>.x:after { content:"工作流初始错误" }</style><p>普通页面</p>')
  assert.deepEqual(parsed, { navigations: [], message: '', state: 'unknown' })
  assert.equal(parse(script(`function wfforward(url) {} wfforward('/notice/RequestError.jsp');`)).navigations.length, 1)
  assert.equal(parse(`<!-- ${script("Dialog.alert('预约成功');")} -->`).state, 'unknown')
})

test('rendered workflow error and explicit Dialog.alert are parsed separately', () => {
  const parsed = parse('<script>function remind(){ Dialog.alert("预约成功"); }</script><span>工作流初始错误，</span><span>点击通知</span>')
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.message, /工作流初始错误/)
  const alert = parse(script(`window.top.Dialog.alert('每个人每天只能成功预约1次，您今天已经预约过，目前无法预约&#xff01;');`))
  assert.equal(alert.state, 'failed')
  assert.match(alert.message, /无法预约！/)
  assert.equal(parse(script(`Dialog.alert('预约成功');`)).state, 'ok')
  assert.equal(parse(script(`Dialog.alert('已成功向管理员发送提醒流程');`)).state, 'unknown')
})

test('rendered OA failure detail takes precedence over header (sanitized capture shape)', () => {
  const reason = '每个人每天只能成功预约1次排球场地，您今天已经预约过，目前无法预约!'
  const page = `<script>var template = "<div class='message-detail'>scaffold</div>";</script>
    <div class="message"><h2>流程提交失败</h2>
    <div class="message-detail">\n ${reason} \n</div></div>`
  assert.equal(parse(page).state, 'failed')
  assert.equal(parse(page).message, reason)
  assert.equal(parse(page.replace(reason, reason.replace('1', '&#49;'))).message, reason)
  assert.equal(parse(page.replace('class="message-detail"', "class='extra message-detail'")).message, reason)
})

test('failure detail never exposes templates, documentation, form values or unknown private text', () => {
  const reason = '每个人每天只能成功预约1次排球场地，您今天已经预约过，目前无法预约!'
  for (const extra of [
    `<script>var template = '<div class="message-detail">${reason}</div>';</script>`,
    `<!-- <div class="message-detail">${reason}</div> -->`,
    `<template><div class="message-detail">${reason}</div></template>`,
    `<div class="message-detail" hidden>${reason}</div>`,
    `<div class="message-detail" style="display:none">${reason}</div>`,
    '<div class="message-detail">Documentation: cookie=synthetic-secret; phone=00000000000</div>',
    `<div class="message-detail">${reason} 联系人：测试用户</div>`,
    `<div class="message-detail"><input value="synthetic-private">${reason}</div>`,
    '<div class="message-detail">原因不明</div>',
    '<div class="message-detail"></div>',
  ]) {
    assert.equal(parse('<h2>流程提交失败</h2>' + extra).message, '流程提交失败')
    assert.equal(parse('<h2>流程提交失败</h2>' + extra).state, 'failed')
  }
})

test('empty pages and every tree observation remain unknown; explicit results take precedence', () => {
  for (const verified of ['gone', 'still-free', 'unknown', null]) {
    const result = bookingOutcome(parse('<html></html>'), verified)
    assert.equal(result.state, 'unknown')
    assert.equal(result.ok, false)
    assert.equal(result.verified, verified)
    assert.equal(bookingOutcome(parse('<p>工作流初始错误</p>'), verified).state, 'failed')
  }
  assert.equal(bookingOutcome(parse(script(`Dialog.alert('提交成功');`)), 'still-free').ok, true)
})

test('only exact same-origin HTTPS read-only result pages are eligible', () => {
  assert.equal(safeResultUrl('../../notice/RequestError.jsp?message=1', base), errorUrl.replace('126221', '1'))
  for (const target of [
    base, 'RequestOperation.jsp?message=1', '/workflow/request/RequestOperation.jsp/',
    '/workflow/request/%52equestOperation.jsp', '/workflow/request/ManageRequestNoForm.jsp',
    'https://evil.example/notice/RequestError.jsp', '//evil.example/notice/RequestError.jsp',
    'http://oa.shanghaitech.edu.cn/notice/RequestError.jsp',
    'https://user:pass@oa.shanghaitech.edu.cn/notice/RequestError.jsp',
    '/arbitrary?message=1', '/workflow/request/ViewRequest.jsp?requestid=0',
    '/notice/../RequestOperation.jsp', 'javascript:alert(1)',
  ]) assert.equal(safeResultUrl(target, base), null, target)
})

test('sanitized actual POST forward can follow only a read-only result', async () => {
  const text = fs.readFileSync(new URL('./fixtures/booking-forward-legacy.html', import.meta.url), 'utf8')
  const parsed = parse(text)
  assert.equal(parsed.state, 'unknown')
  assert.deepEqual(parsed.navigations, ['/workflow/request/ViewRequest.jsp?f_weaver_belongto_userid=123&f_weaver_belongto_usertype=null&requestid=456&message=126221&isintervenor='])
  const calls = []
  const result = await followBookingResults({ status: 200, url: base, text }, async (url) => {
    calls.push(url)
    return { status: 200, url, text: '<p>工作流初始错误</p>' }
  })
  assert.equal(calls.length, 1)
  assert.equal(result.state, 'failed')
})

test('actual direction forward follows explicit auto-submit result with matching request and workflow IDs', async () => {
  const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  const initial = { status: 200, url: base, text: fixture('booking-direction-forward.html') }
  const target = new URL(parse(initial.text).navigations[0], base).href
  const text = fixture('booking-direction-result.html')
  assert.equal(parse(initial.text).state, 'unknown')
  assert.equal(safeResultUrl(target, base), target)
  const calls = []
  const result = await followBookingResults(initial, async (url) => {
    calls.push(url)
    return { status: 200, url, text }
  })
  assert.deepEqual(calls, [target])
  assert.equal(result.state, 'ok')
  assert.equal(result.message, '流程提交成功，审批状态请到 OA 查看')
  assert.equal(result.requestId, '456')
  assert.equal(bookingOutcome(result).requestId, '456')
  for (const verified of ['gone', 'still-free', 'unknown', null]) {
    assert.equal(bookingOutcome(result, verified).ok, true)
  }
  for (const url of [base, target.replace('WorkflowDirection', 'ViewRequest'), target.replace('requestid=456', 'requestid=457'), target.replace('workflowid=789', 'workflowid=790')]) {
    assert.equal(parseBookingResponse({ url, text }).state, 'unknown', url)
  }
  for (const altered of [
    text.replace('var isFromAutoDirect = true', 'var isFromAutoDirect = false'),
    text.replace("var alertMsg = '流程提交成功'", "var alertMsg = ''"),
    text.replace('value="456"', 'value="457"'),
    text.replace('value="789"', 'value="790"'),
    text.replace('var isFromAutoDirect = true;', 'function scaffold() { var isFromAutoDirect = true; }'),
    `<!-- ${text.replace(/<!--[\s\S]*?-->/g, '')} -->`,
    text + '<p>流程提交失败</p>',
  ]) assert.notEqual(parseBookingResponse({ url: target, text: altered }).state, 'ok')
  for (const suffix of ['&src=submit', '&action=delete', '&workflowid=790', '&unknown=1']) {
    assert.equal(safeResultUrl(target + suffix, base), null)
  }
  for (const altered of [
    target.replace('&workflowid=789', ''), target.replace('isbill=1', 'isbill=0'),
    target.replace('formid=-248', 'formid=248'), target.replace('requestid=456', 'requestid=0'),
    target.replace('https://oa.shanghaitech.edu.cn', 'https://evil.example'),
  ]) assert.equal(safeResultUrl(altered, base), null)
})

test('legacy HTML script wrappers work, malformed JS never gets regex recovery', () => {
  assert.deepEqual(parse(script(`<!--\nwfforward('/notice/RequestError.jsp');\n//-->`)).navigations, ['/notice/RequestError.jsp'])
  assert.deepEqual(parse(script(`<!--\nwfforward('/notice/RequestError.jsp');\n-->`)).navigations, ['/notice/RequestError.jsp'])
  for (const js of [
    `function broken( { wfforward('/notice/RequestError.jsp');`,
    `const broken = "unterminated;\nwfforward('/notice/RequestError.jsp');`,
    `/* wfforward('/notice/RequestError.jsp');`,
    `return; wfforward('/notice/RequestError.jsp');`,
    `if (false) wfforward('/notice/RequestError.jsp');`,
  ]) assert.deepEqual(parse(script(js)).navigations, [], js)
  assert.deepEqual(parse(`<!-- ${script("wfforward('/notice/RequestError.jsp');")} -->`).navigations, [])
  assert.deepEqual(parse(`<script type="text/plain">wfforward('/notice/RequestError.jsp');</script>`).navigations, [])
  assert.deepEqual(parse(`<script src="external.js">wfforward('/notice/RequestError.jsp');</script>`).navigations, [])
  assert.equal(parse(script('function broken( {') + script("wfforward('/notice/RequestError.jsp');")).navigations.length, 1)
})

test('request result routes require one positive ID and reject operation parameters', () => {
  for (const route of ['ViewRequest', 'ManageRequestNoForm']) {
    const target = `/workflow/request/${route}.jsp?requestid=123`
    assert.equal(safeResultUrl(target, base), new URL(target, base).href)
    for (const query of ['', '?requestid=0', '?requestid=-1', '?requestid=1.5', '?requestid=abc', '?requestid=1&requestid=2']) {
      assert.equal(safeResultUrl(`/workflow/request/${route}.jsp${query}`, base), null)
    }
    for (const suffix of ['&reEdit=0', '&reEdit=2', '&action=save', '&method=delete', '&src=submit', '&ACTION=view', '&unknown=1', '&%73rc=save']) {
      assert.equal(safeResultUrl(target + suffix, base), null)
    }
  }
  assert.equal(safeResultUrl(errorUrl + '&action=delete', base), null)
})

test('actual read-only view -> manage -> iframe chain fails within three GETs', async () => {
  const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  const initial = { url: base, status: 200, text: fixture('booking-forward-legacy.html') }
  const view = new URL(parse(initial.text).navigations[0], base).href
  const query = '?viewdoc=&fromFlowDoc=&f_weaver_belongto_userid=123&f_weaver_belongto_usertype=0&requestid=456&isrequest=0&isovertime=0&isaffirmance=&reEdit=1&seeflowdoc=0&isworkflowdoc=0&isfromtab=false&isSubmitDirect=&message=126221'
  const manage = new URL(`ManageRequestNoForm.jsp${query}`, base).href
  const frame = new URL(`ManageRequestNoFormIframe.jsp${query}`, base).href
  const calls = []
  const result = await followBookingResults(initial, async (url) => {
    calls.push(url)
    if (url === view) return { url, status: 302, location: manage, text: '' }
    if (url === manage) return { url, status: 200, text: fixture('booking-result-wrapper.html') }
    assert.equal(url, frame)
    return { url, status: 200, text: fixture('booking-result-frame.html') }
  })
  assert.deepEqual(calls, [view, manage, frame])
  assert.equal(result.state, 'failed')
  assert.equal(result.message, '流程提交失败')
  assert.equal(result.responses.length, 4)
  const wrapper = fixture('booking-result-wrapper.html')
  for (const text of [`<!-- ${wrapper} -->`, wrapper.replace('ManageRequestNoFormIframe.jsp?', 'RequestOperation.jsp?')]) {
    assert.deepEqual(parseBookingResponse({ url: manage, text }).navigations, [])
  }
  assert.deepEqual(parseBookingResponse({ url: view, text: wrapper }).navigations, [])
  for (const suffix of ['&src=save', '&method=delete', '&submit=1', '&reEdit=0']) {
    assert.equal(safeResultUrl(frame + suffix, base), null)
  }
})

test('bounded navigation is GET-only, keeps initial response, detects loops and stops on explicit errors', async () => {
  const initial = { status: 302, location: errorUrl, url: base, headers: { location: errorUrl }, text: 'original POST response' }
  const calls = []
  const result = await followBookingResults(initial, async (url) => {
    calls.push(url)
    return { status: 200, url, text: '<p>工作流初始错误</p>' }
  })
  assert.deepEqual(calls, [errorUrl])
  assert.equal(result.state, 'failed')
  assert.equal(result.responses[0], initial)
  assert.equal(result.finalUrl, errorUrl)
  let n = 0
  const bounded = await followBookingResults(initial, async (url) => ({ status: 302, url, location: `${errorUrl}&hop=${++n}`, text: '' }), { maxHops: 99 })
  assert.equal(n, 3)
  assert.equal(bounded.state, 'unknown')
  n = 0
  await followBookingResults(initial, async (url) => { n++; return { status: 302, url, location: errorUrl, text: '' } })
  assert.equal(n, 1)
  for (const location of [base, 'https://evil.example/notice/RequestError.jsp']) {
    await followBookingResults({ ...initial, location }, async () => assert.fail('must not fetch'))
  }
  const failedGet = await followBookingResults(initial, async () => { throw Error('offline') })
  assert.equal(failedGet.state, 'unknown')
  assert.equal(failedGet.responses[0], initial)
})

test('diagnostics retain complete responses and initial metadata, not request credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-test-'))
  try {
    const writer = createBookingDiagnostics(root)
    const text = 'x'.repeat(50000)
    writer.save({ status: 302, url: base, headers: { location: errorUrl, 'set-cookie': 'secret' }, text })
    writer.finish(errorUrl)
    const parent = path.join(root, 'server/data/booking-diagnostics')
    const dir = path.join(parent, fs.readdirSync(parent)[0])
    assert.equal(fs.readFileSync(path.join(dir, '00.html'), 'utf8'), text)
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, '00.json'), 'utf8'))
    assert.equal(metadata.status, 302)
    assert.equal(metadata.headers.location, errorUrl)
    assert.equal(metadata.headers['set-cookie'], '[redacted]')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).finalUrl, errorUrl)
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '00.html')).mode & 0o777, 0o600)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
