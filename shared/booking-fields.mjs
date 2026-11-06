/** Required fields shared by the UI and backend; no network calls. */
export function bookingFieldsError({ owner, phone, people = 1 } = {}) {
  const missing = []
  if (typeof owner !== 'string' || !owner.trim()) missing.push('现场责任人')
  if (typeof phone !== 'string' || !phone.trim()) missing.push('联系电话')
  if (missing.length) return `请填写${missing.join('和')}`
  if (!Number.isSafeInteger(Number(people)) || Number(people) <= 0) return '参加人数必须为正整数'
  return ''
}
