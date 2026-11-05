async function json(res) {
  const body = await res.json().catch(() => ({}))
  return body
}

export const fetchSnapshot = () => fetch('/api/availability').then(json)

export const requestRefresh = () =>
  fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(json)