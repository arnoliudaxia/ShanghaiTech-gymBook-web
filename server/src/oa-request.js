import { decodeEntities, parseBookingResponse, safeResultUrl } from './booking-response.js'

export const OA_BASE = 'https://oa.shanghaitech.edu.cn'
export const BOOKING_WORKFLOW_IDS = new Set(['14862', '43364'])
export const DELETED_MARKER = '对不起，该流程已经被删除！请返回或者进入不同的页面'
const id = (v) => /^[1-9]\d*$/.test(String(v ?? ''))

// Quote-aware HTML tokenization; never execute OA scripts. Preserve duplicate controls.
export function attributes(tag) {
  const out = {}
  for (const m of tag.replace(/^<\/?[\w:-]+/, '').matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}
export function visibleText(html) {
  return decodeEntities(String(html).replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}
export function successfulControls(html) {
  const params = new URLSearchParams()
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const tokens = [...clean.matchAll(/<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi)]
  const disabled = []
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i], tag = m[0], a = attributes(tag)
    if (/^<fieldset\b/i.test(tag)) { disabled.push('disabled' in a); continue }
    if (/^<\/fieldset/i.test(tag)) { disabled.pop(); continue }
    if (!a.name || 'disabled' in a || disabled.includes(true)) continue
    if (/^<input\b/i.test(tag)) {
      const type = (a.type || 'text').toLowerCase()
      if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) continue
      if (['checkbox', 'radio'].includes(type) && !('checked' in a)) continue
      params.append(a.name, a.value ?? (['checkbox', 'radio'].includes(type) ? 'on' : ''))
    } else if (/^<textarea\b/i.test(tag)) {
      const end = clean.indexOf('</textarea', m.index + tag.length)
      if (end < 0) throw new Error('Malformed textarea')
      params.append(a.name, decodeEntities(clean.slice(m.index + tag.length, end)).replace(/^\r?\n/, '').replace(/\r?\n/g, '\r\n'))
      while (tokens[i + 1] && tokens[i + 1].index < end) i++
    } else if (/^<select\b/i.test(tag)) {
      const end = clean.indexOf('</select', m.index + tag.length)
      if (end < 0) throw new Error('Malformed select')
      const options = []; let groupDisabled = false
      for (const o of clean.slice(m.index + tag.length, end).matchAll(/<\/?optgroup\b[^>]*>|<option\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?=<option\b|<\/option|<\/optgroup|$)/gi)) {
        if (/^<\/?optgroup/i.test(o[0])) { groupDisabled = /^<optgroup/i.test(o[0]) && 'disabled' in attributes(o[0]); continue }
        const b = attributes(`<option ${o[1]}>`)
        options.push({ value: b.value ?? visibleText(o[2]), selected: 'selected' in b, disabled: groupDisabled || 'disabled' in b })
      }
      const chosen = 'multiple' in a ? options.filter(o => o.selected) : [options.find(o => o.selected) ?? options[0]]
      for (const o of chosen) if (o && !o.disabled) params.append(a.name, o.value)
      while (tokens[i + 1] && tokens[i + 1].index < end) i++
    }
  }
  return params
}
export function uniqueValue(params, key) {
  const values = params.getAll(key)
  return values.length && values.every(v => v === values[0]) ? values[0] : null
}
export function requestEvidence(response, requestId, expected = {}) {
  const text = response.text || '', visible = visibleText(text)
  if (response.status !== 200 || /Deleted\.jsp|\/login|\/notice\/.*Error|ids\.shanghaitech/i.test(response.url || '') ||
      /已经被删除|工作流初始错误|流程提交失败|无权|没有权限|请.*登录/.test(visible)) return null
  const fields = successfulControls(text)
  const values = Object.fromEntries(['requestid', 'workflowid', 'formid', 'field31876', 'field32340', 'field31901', 'field31902', 'field31883'].map(k => [k, uniqueValue(fields, k)]))
  if (!id(requestId) || values.requestid !== String(requestId) || !BOOKING_WORKFLOW_IDS.has(values.workflowid) || (fields.has('formid') && values.formid !== '-248') || !id(values.field31876) ||
      !values.field32340 || !/^\d{4}-\d{2}-\d{2}$/.test(values.field31901 || '') || !/^(?:[1-9]|1[01])$/.test(values.field31902 || '') || !values.field31883) return null
  if (Object.entries(expected).some(([k, v]) => v != null && values[k] !== String(v))) return null
  return { requestId: String(requestId), applicantId: values.field31876, workflowId: values.workflowid, fields: values, approval: 'unknown' }
}

/** GET only a bounded, same-request readonly chain; scaffold alone is never evidence. */
export async function readOwnRequest(requestId, get, expected = {}) {
  if (!id(requestId)) return { state: 'unknown' }
  let url = `${OA_BASE}/workflow/request/ViewRequest.jsp?requestid=${requestId}`
  const responses = [], seen = new Set()
  for (let n = 0; n < 4 && !seen.has(url); n++) {
    seen.add(url)
    const response = await get(url); responses.push(response)
    const evidence = requestEvidence(response, requestId, expected)
    if (evidence) return { state: 'exists', ...evidence, response, responses }
    if (/已经被删除|流程提交失败|无权|没有权限/.test(visibleText(response.text || ''))) break
    const parsed = parseBookingResponse(response)
    const frames = [...(response.text || '').matchAll(/<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)].map(m => attributes(`<iframe ${m[1]}>`).src).filter(Boolean)
    const candidates = [...parsed.navigations, ...frames].map(target => safeResultUrl(target, response.url || url)).filter(Boolean)
    url = candidates.find(u => new URL(u).searchParams.get('requestid') === String(requestId) && !/WorkflowDirection|RequestError/.test(u))
    if (!url) break
  }
  return { state: 'unknown', responses }
}

/** Same deletion proof for list reconciliation and cancellation. Only the exact read-only
 * Deleted page may be fetched; JS function definitions are not navigation evidence.
 */
export async function confirmDeletedRequest(responses, get) {
  const seen = new Set()
  for (const response of Array.isArray(responses) ? responses : [responses]) {
    if (!response) continue
    if (response.status === 200 && visibleText(response.text).replace(/\s+/g, '').includes(DELETED_MARKER)) return true
    for (const target of parseBookingResponse(response).navigations) {
      let url
      try { url = new URL(target, response.url) } catch { continue }
      if (url.origin !== OA_BASE || url.pathname !== '/notice/Deleted.jsp' || url.search !== '?showtype=wf' || url.username || url.password || url.hash || seen.has(url.href)) continue
      seen.add(url.href)
      const marker = await get(url.href)
      if (marker.status === 200 && visibleText(marker.text).replace(/\s+/g, '').includes(DELETED_MARKER)) return true
    }
  }
  return false
}

export async function verifySubmissionRequest(parsed, get, payload) {
  // A failed initial submission may leave a real draft. Never promote that draft.
  if (parsed.state === 'failed' || parsed.responses?.some(r => parseBookingResponse(r).state === 'failed')) return { ...parsed, state: 'failed' }
  if (!id(payload?.field31876) || !BOOKING_WORKFLOW_IDS.has(String(payload?.workflowid))) return { ...parsed, state: 'unknown', requestId: undefined, message: '' }
  const ids = new Set()
  for (const r of parsed.responses || []) {
    const p = parseBookingResponse(r)
    if (p.requestId) ids.add(p.requestId)
    for (const target of [...p.navigations, r.url]) {
      const safe = safeResultUrl(target, r.url)
      if (safe && /\/(?:ViewRequest|WorkflowDirection)\.jsp$/.test(new URL(safe).pathname)) {
        const rid = new URL(safe).searchParams.get('requestid'); if (id(rid)) ids.add(rid)
      }
    }
  }
  if (ids.size !== 1) return { ...parsed, state: 'unknown', requestId: undefined }
  const requestId = [...ids][0]
  try {
    const expected = Object.fromEntries(['workflowid', 'formid', 'field31876', 'field32340', 'field31901', 'field31902', 'field31883'].map(k => [k, payload[k]]))
    const check = await readOwnRequest(requestId, get, expected)
    if (check.state === 'exists') return { ...parsed, state: 'ok', requestId, approval: 'unknown', message: '申请单已在 OA 中确认存在；审批状态请到 OA 查看' }
  } catch { /* no replay */ }
  return { ...parsed, state: 'unknown', requestId: undefined, message: '' }
}
