import { parse } from 'acorn'

export function decodeEntities(value) {
  const named = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ' }
  return String(value).replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp|nbsp);/gi, (all, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? all
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1))
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all
  })
}

function memberName(node) {
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'MemberExpression' && !node.computed) {
    return `${memberName(node.object)}.${node.property.name}`
  }
  return ''
}
const literal = (node) => node?.type === 'Literal' && typeof node.value === 'string' ? decodeEntities(node.value) : null

/** Pure, deliberately conservative: no eval, external scripts, event handlers or function bodies.
 * Only standalone top-level literal operations are evidence; conditional/dynamic JS stays unknown.
 */
export function parseBookingResponse({ status = 200, location = '', text = '', url = '' } = {}) {
  const navigations = []
  const dialogs = []
  let directionRequestId = null
  if (status >= 300 && status < 400 && location) navigations.push(decodeEntities(location))
  // Consume HTML comments only outside raw script bodies. Legacy <!-- / -->
  // wrappers inside scripts are JavaScript line comments understood by Acorn.
  // Never recover by regex-scanning broken JS: that can turn strings or function
  // bodies into apparent executable calls. A malformed script stays unknown.
  const chunks = [...text.matchAll(/<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  const uncommented = text.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    (chunk) => /^<script\b/i.test(chunk) ? chunk : '')
  for (const match of chunks) {
    if (match[2] === undefined || /\bsrc\s*=/i.test(match[1])) continue
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1])
    if (type && !/^(?:text|application)\/(?:java|ecma)script$/i.test(type[1] ?? type[2] ?? type[3])) continue
    let program
    try { program = parse(match[2], { ecmaVersion: 'latest' }) } catch { continue }
    // Known auto-direction result: require the read-only route, explicit literal
    // submission status, and both page IDs bound to the redirect's query IDs.
    if (status === 200 && safeResultUrl(url, url) && new URL(url).pathname === '/workflow/request/WorkflowDirection.jsp' &&
        program.body.every((s) => s.type === 'VariableDeclaration' && s.declarations.every((d) =>
          d.id.type === 'Identifier' && d.init?.type === 'Literal'))) {
      const declarations = program.body.flatMap((s) => s.declarations)
      const one = (name, value) => declarations.filter((d) => d.id.name === name).length === 1 &&
        declarations.some((d) => d.id.name === name && d.init.value === value)
      const markup = uncommented.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      const inputs = [...markup.matchAll(/<input\b[^>]*>/gi)].map(([tag]) =>
        Object.fromEntries([...tag.matchAll(/\b(type|id|name|value)\s*=\s*(["'])(.*?)\2/gi)]
          .map((m) => [m[1].toLowerCase(), m[3]])))
      const matchesId = (name, query) => {
        const fields = inputs.filter((i) => i.id === name || i.name === name)
        return fields.length === 1 && fields[0].type === 'hidden' && fields[0].id === name &&
          fields[0].name === name && fields[0].value === new URL(url).searchParams.get(query)
      }
      if (one('isFromAutoDirect', true) && one('alertMsg', '流程提交成功') &&
          matchesId('requestid', 'requestid') && matchesId('wfid', 'workflowid')) directionRequestId = new URL(url).searchParams.get('requestid')
    }
    // Recognize only this known OA wrapper template, not arbitrary callbacks.
    // Copy the validated current query; never evaluate its dynamic permission JS.
    const wrapperFrames = {
      '/workflow/request/ManageRequestNoForm.jsp': ['ManageRequestNoForm.jsp?', 'ManageRequestNoFormIframe.jsp'],
      '/workflow/request/ViewRequest.jsp': ['ViewRequest.jsp?', 'ViewRequestIframe.jsp'],
    }
    const wrapper = safeResultUrl(url, url) && wrapperFrames[new URL(url).pathname]
    if (wrapper) {
      const [queryMarker, framePage] = wrapper
      // Match the AST, not source spelling: single/double quotes and whitespace
      // are equivalent. The exact marker and offset must match this wrapper.
      const copiesQuery = program.body.some((s) => s.type === 'VariableDeclaration' && s.declarations.some((d) => {
        const init = d.init, sum = init?.arguments?.[0], index = sum?.left
        return d.id.type === 'Identifier' && d.id.name === 'bodyiframeurl' &&
          init?.type === 'CallExpression' && memberName(init.callee) === 'location.href.substring' && init.arguments.length === 1 &&
          sum?.type === 'BinaryExpression' && sum.operator === '+' &&
          index?.type === 'CallExpression' && memberName(index.callee) === 'location.href.indexOf' &&
          index.arguments.length === 1 && literal(index.arguments[0]) === queryMarker &&
          sum.right?.type === 'Literal' && sum.right.value === queryMarker.length
      }))
      const setsFrame = program.body.some((s) => s.type === 'FunctionDeclaration' && s.id?.name === 'setbodyiframe' &&
        s.body.body.some((b) => {
          const e = b.type === 'ExpressionStatement' && b.expression
          const left = e?.left
          return e?.type === 'AssignmentExpression' && e.operator === '=' && left?.type === 'MemberExpression' &&
            !left.computed && left.property.name === 'src' && left.object?.type === 'CallExpression' &&
            memberName(left.object.callee) === 'document.getElementById' && left.object.arguments.length === 1 &&
            literal(left.object.arguments[0]) === 'bodyiframe' && e.right?.type === 'BinaryExpression' &&
            e.right.operator === '+' && literal(e.right.left) === `${framePage}?` &&
            e.right.right.type === 'Identifier' && e.right.right.name === 'bodyiframeurl'
        }))
      if (copiesQuery && setsFrame) navigations.push(`${framePage}${new URL(url).search}`)
    }
    for (const statement of program.body) {
      if (statement.type !== 'ExpressionStatement') continue
      const e = statement.expression
      if (e.type === 'AssignmentExpression' && e.operator === '=' &&
          /^(?:(?:window|parent|top|self|document)\.)*(?:location|location\.href)$/.test(memberName(e.left))) {
        const value = literal(e.right)
        if (value !== null) navigations.push(value)
      }
      if (e.type !== 'CallExpression') continue
      const name = memberName(e.callee)
      const value = literal(e.arguments[0])
      if (value === null) continue
      if (name === 'wfforward' && e.arguments.length === 1) navigations.push(value)
      if (/^(?:(?:window|parent|top|self)\.)*Dialog\.alert$/.test(name)) dialogs.push(value)
    }
  }
  const visible = decodeEntities(uncommented
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  // Inspect rendered detail blocks, never matching template strings in scripts.
  // Only recognized non-personal OA reasons are public: arbitrary detail content
  // can contain form values, stack traces or documentation. Unknown details keep
  // the generic failure, rather than exposing the surrounding page.
  const rendered = uncommented.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const details = [...rendered.matchAll(/<(div|p|span)\b((?=[^>]*\bclass\s*=\s*(?:"[^"]*\bmessage-detail\b[^"]*"|'[^']*\bmessage-detail\b[^']*'))[^>]*)>([\s\S]*?)<\/\1\s*>/gi)]
  const detail = details.flatMap(([, , attrs, body]) => {
    const classes = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    if (!(classes?.[1] ?? classes?.[2] ?? '').split(/\s+/).includes('message-detail') ||
        /\bhidden\b|\b(?:style|aria-hidden)\s*=/i.test(attrs) || /<(?:input|textarea|select)\b/i.test(body)) return []
    const value = decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    return /^(?:每个人每天只能成功预约[1-9]次(?:排球|羽毛球|篮球|网球)?场地[，,]您今天已经预约过[，,]目前无法预约[!！。]?|该时间段已被预约[!！。]?|已被预约[!！。]?)$/.test(value) ? [value] : []
  })[0]
  const failure = detail || /(每个人每天只能成功预约[^。！!]*[。！!]?|流程提交失败|工作流初始错误[^。！!]*[。！!]?|该时间段[^。！!]*[。！!]?|已被预约[^。！!]*[。！!]?)/.exec(visible)?.[1]
  const message = failure || dialogs[0] || (directionRequestId ? '流程提交成功，审批状态请到 OA 查看' : '')
  // An arbitrary alert is a message, not proof of booking or rejection.
  const failed = Boolean(failure || dialogs.some((s) => /无法预约|不能|失败|错误|已被预约|未填写|只能成功预约/.test(s)))
  const success = !failed && (directionRequestId || dialogs.some((s) => /^(?:流程提交成功|提交成功|预约成功)[！!。\s]*$/.test(s)) || /^(?:流程提交成功|提交成功|预约成功)[！!。\s]*$/.test(visible))
  // Only a bounded extracted message reaches callers; never expose raw diagnostics/URLs.
  const publicMessage = (message || (success ? visible : ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/\b(cookie|token|authorization|password)\b\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500)
  return { navigations, message: publicMessage, state: failed ? 'failed' : success ? 'ok' : 'unknown',
    ...(success && directionRequestId ? { requestId: directionRequestId } : {}) }
}

// Exact read-only result pages only. Never infer safety from a .jsp suffix or a message parameter.
const RESULT_PATHS = new Set(['/notice/RequestError.jsp', '/workflow/request/ViewRequest.jsp', '/workflow/request/ViewRequestIframe.jsp', '/workflow/request/ManageRequestNoForm.jsp', '/workflow/request/ManageRequestNoFormIframe.jsp'])
const RESULT_PARAMS = new Set(['requestid', 'message', 'f_weaver_belongto_userid', 'f_weaver_belongto_usertype', 'isintervenor', 'viewdoc', 'fromFlowDoc', 'isrequest', 'isovertime', 'isaffirmance', 'reEdit', 'seeflowdoc', 'isworkflowdoc', 'isfromtab', 'isSubmitDirect'])
const VIEW_VALUES = { viewdoc: [''], fromFlowDoc: [''], isrequest: ['0'], isovertime: ['0'], isaffirmance: [''], reEdit: ['1'], seeflowdoc: ['0'], isworkflowdoc: ['0'], isfromtab: ['false'], isSubmitDirect: [''] }
export function safeResultUrl(target, base) {
  try {
    const origin = new URL(base)
    const url = new URL(target, origin)
    if (url.origin !== origin.origin || url.protocol !== 'https:' || url.username || url.password) return null
    // Exact observed read-only direction result shape. The URL alone is not
    // submission evidence; its page must supply explicit status and matching IDs.
    if (url.pathname === '/workflow/request/WorkflowDirection.jsp') {
      const shape = {
        f_weaver_belongto_userid: /^[1-9]\d*$/,
        f_weaver_belongto_usertype: /^(?:null|0)$/,
        requestid: /^[1-9]\d*$/,
        workflowid: /^[1-9]\d*$/,
        isbill: /^1$/,
        formid: /^-[1-9]\d*$/,
      }
      if ([...url.searchParams.keys()].some((key) => !Object.hasOwn(shape, key)) ||
          Object.entries(shape).some(([key, pattern]) => url.searchParams.getAll(key).length !== 1 || !pattern.test(url.searchParams.get(key)))) return null
      url.hash = ''
      return url.href
    }
    if (!RESULT_PATHS.has(url.pathname)) return null
    // Reject operation selectors even on the error page. Request pages use a
    // closed parameter/value allowlist; reEdit=1 is the server's view mode.
    for (const [key, value] of url.searchParams) {
      if (/^(?:action|method|src|save|delete|submit|operation|op)$/i.test(key)) return null
      if (Object.hasOwn(VIEW_VALUES, key) && !VIEW_VALUES[key].includes(value)) return null
      if (url.pathname !== '/notice/RequestError.jsp' && !RESULT_PARAMS.has(key)) return null
      if (url.searchParams.getAll(key).length !== 1) return null
    }
    if (url.pathname !== '/notice/RequestError.jsp' && !/^[1-9]\d*$/.test(url.searchParams.get('requestid') || '')) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

/** POST is owned by the caller. This helper can only GET allowlisted results, at most maxHops. */
export async function followBookingResults(initial, get, { maxHops = 3, onResponse = () => {} } = {}) {
  const responses = [initial]
  const seen = new Set([initial.url])
  let current = initial
  let parsed = parseBookingResponse(current)
  let followError = false
  for (let hop = 0; parsed.state === 'unknown' && hop < Math.min(maxHops, 3); hop++) {
    const next = safeResultUrl(parsed.navigations[0], current.url)
    if (!next || seen.has(next)) break
    seen.add(next)
    try { current = await get(next) } catch { followError = true; break }
    responses.push(current)
    await onResponse(current)
    parsed = parseBookingResponse(current)
  }
  return { ...parsed, responses, finalUrl: current.url, followError }
}

export const submissionPayload = (fields, overrides = {}) => ({ ...fields, ...overrides, src: 'submit' })

export function bookingOutcome(parsed, verified = null) {
  return {
    ok: parsed.state === 'ok', state: parsed.state, verified,
    ...(parsed.state === 'ok' && parsed.requestId ? { requestId: parsed.requestId } : {}),
    message: parsed.message || (parsed.state === 'unknown' ? '提交结果无法确认，请到 OA「我的请求」核实；请勿直接重复提交' : ''),
  }
}
