import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Local response-only diagnostics. Never persist request payload, cookies or credentials. */
export function createBookingDiagnostics(root) {
  let directory
  try {
    const parent = path.join(root, 'server/data/booking-diagnostics')
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(parent, 0o700) } catch {}
    directory = path.join(parent, `${Date.now()}-${randomUUID()}`)
    fs.mkdirSync(directory, { mode: 0o700 })
  } catch { return { save() {}, finish() {} } }
  const write = (name, content) => {
    try {
      const file = path.join(directory, name)
      fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' })
      try { fs.chmodSync(file, 0o600) } catch {}
    } catch { /* Diagnostics must not cause a submission retry. */ }
  }
  let index = 0
  return {
    save(response) {
      const prefix = String(index++).padStart(2, '0')
      // Preserve response metadata except credential-bearing headers. Body is retained in full locally.
      const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) =>
        [k, /cookie|authorization|token/i.test(k) ? '[redacted]' : v]))
      write(`${prefix}.json`, JSON.stringify({ status: response.status, url: response.url, headers }, null, 2))
      write(`${prefix}.html`, response.text)
    },
    finish(finalUrl) { write('result.json', JSON.stringify({ finalUrl }, null, 2)) },
  }
}
