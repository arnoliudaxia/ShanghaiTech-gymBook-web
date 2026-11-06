export const fetchSnapshot = () =>
  fetch('/api/availability').then((res) => res.json())

/** 申请管理只读取申请列表，不触发空闲采集。保留 HTTP 状态以区分登录失效。 */
async function applicationRequest(url, options) {
  const res = await fetch(url, options)
  let body
  try {
    body = await res.json()
  } catch (error) {
    // 登录网关可能用 HTML 返回 401/403，不能误显示为“没有申请”。
    if ([401, 403].includes(res.status)) {
      return { ok: false, httpStatus: res.status, message: 'OA 登录已失效。' }
    }
    throw error
  }
  return { ...body, ok: res.ok && body?.ok === true, httpStatus: res.status }
}

export const fetchApplications = () => applicationRequest('/api/applications')

/** 仅在用户明确确认后调用一次；网络异常不能安全重试。 */
export const cancelApplication = (id) => applicationRequest(`/api/applications/${encodeURIComponent(id)}/cancel`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirm: true }),
})

export const fetchBookingQuota = () =>
  fetch('/api/booking/quota').then((res) => res.json())

export const fetchBookingMeta = () =>
  fetch('/api/booking/meta').then((res) => res.json())

/** 真正提交一次；后端返回 ok / failed / unknown，场地树仅作补充观察。 */
export const submitBooking = (body) =>
  fetch('/api/booking/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json())

/** 只准备 payload（后端取表单拿防重 token），不提交 */
export const prepareBooking = (body) =>
  fetch('/api/booking/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json())