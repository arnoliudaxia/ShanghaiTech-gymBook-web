/** No routes. Only the server's trusted pending-task provider may authorize a target. */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.js'
import { ensureSession } from './service.js'
import { markBookingCancellation } from './booking.js'
import { parseBookingResponse, safeResultUrl } from './booking-response.js'
import { OA_BASE, confirmDeletedRequest, readOwnRequest, successfulControls, uniqueValue, attributes, visibleText, requestEvidence } from './oa-request.js'

const locks = new Set()
const journalFile = path.join(ROOT, 'server/data/cancellation-attempts.json')
const diskJournal = {
  get(key) {
    try { return JSON.parse(fs.readFileSync(journalFile, 'utf8'))[key] }
    catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Cancellation journal unavailable') }
  },
  set(key, value) {
    let data = {}
    try { data = JSON.parse(fs.readFileSync(journalFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    data[key] = value
    fs.mkdirSync(path.dirname(journalFile), { recursive: true })
    const tmp = `${journalFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, journalFile)
  },
}

/** Dependencies are server-owned, never request-body fields.
 * listPendingApplications(): trusted own portal rows [{ id, requestId, title, status:'pending' }]
 * getOwnApplicantId(): authenticated OA userid from trusted session/profile, NOT client input.
 * transport optional for offline tests; manual redirects required, no retry middleware.
 * Unknown mutation outcomes are durably blocked from replay; reconcile manually/read-only.
 */
export function createCancellationService({ listPendingApplications, getOwnApplicantId, transport, journal = diskJournal, persist = markBookingCancellation }) {
  if (typeof listPendingApplications !== 'function' || typeof getOwnApplicantId !== 'function') throw new Error('Trusted authorization providers required')
  return {
    async cancel({ taskId, requestId }) {
      if (!/^[1-9]\d*$/.test(String(requestId)) || !taskId) return { state: 'rejected', step: 'authorize' }
      const key = String(requestId)
      if (locks.has(key)) return { state: 'busy', step: 'authorize', requestId: key }
      locks.add(key)
      let step = 'authorize', mutation = false, prior = null
      const outcome = (state) => ({ state, step, requestId: key, quotaReleased: null })
      const save = async (result) => { await journal.set(key, result); await persist(key, result); return result }
      try {
        prior = await journal.get(key)
        if (prior?.state === 'cancelled') return { ...prior, replayBlocked: true }
        const own = String(await getOwnApplicantId())
        const tasks = await listPendingApplications()
        const matches = tasks.filter(t => String(t.id ?? t.taskId) === String(taskId) && String(t.requestId) === key &&
          t.title?.startsWith('学生和教工场馆借用申请-') && t.status === 'pending')
        if (!/^[1-9]\d*$/.test(own) || matches.length !== 1) return outcome('rejected')
        const cookie = transport ? null : await ensureSession()
        const send = transport || (async (url, init = {}) => {
          const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30000), headers: {
            cookie: `shkjdx_session=${cookie}`, ...(init.headers || {}),
          } })
          return { status: res.status, url, location: res.headers.get('location') || '', text: await res.text() }
        })
        const get = url => send(url, { method: 'GET' })
        const confirmedDeleted = (responses) => confirmDeletedRequest(responses, get)
        step = 'live-check'
        const live = await readOwnRequest(key, get, { field31876: own })
        if (live.state !== 'exists') {
          // A stale own pending portal task can already have been deleted. No mutation needed.
          if (await confirmedDeleted(live.responses || [])) {
            step = 'already-deleted'
            return await save(outcome('cancelled'))
          }
          return prior ? { ...prior, replayBlocked: true } : outcome('rejected')
        }
        // Unknown prior mutations can be reconciled by deletion proof above, never replayed.
        if (prior) return { ...prior, replayBlocked: true }
        // Portal RUNNING establishes pending. OA must still expose a native retract action;
        // an approval node title need not contain the literal words 待审批.
        const completed = live.responses.some(r => /流程已归档|流程已结束|流程已办结/.test(visibleText(r.text)) ||
          successfulControls(r.text).getAll('nodetype').some(v => !['0', '1', '2'].includes(v)))
        const nativeAction = live.responses.some(r => [...r.text.matchAll(/<[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi)].some(m => {
          const a = attributes(m[0])
          return /\bdoRetract\s*\(/.test(a.onclick || '') && !('disabled' in a)
        }))
        if (completed || !nativeAction) return outcome('rejected')
        let retract = null
        for (const r of live.responses) {
          for (const m of r.text.matchAll(/(?:["'])([^"']*wfFunctionManageLink\.jsp\?[^"']+)(?:["'])/g)) {
            const u = new URL(m[1].replace(/&amp;/g, '&'), OA_BASE)
            if (u.origin !== OA_BASE || u.pathname !== '/workflow/workflow/wfFunctionManageLink.jsp' || u.hash) continue
            const expected = { flag: 'rb', requestid: key, f_weaver_belongto_userid: own, f_weaver_belongto_usertype: '0' }
            if ([...u.searchParams.keys()].length === 4 && Object.entries(expected).every(([k,v]) => u.searchParams.getAll(k).length === 1 && u.searchParams.get(k) === v)) retract = u.href
          }
        }
        if (!retract) return outcome('rejected')
        step = 'retract'
        // Persist intent BEFORE the one and only state-changing GET.
        await save(outcome('unknown')); mutation = true
        const rb = await get(retract)
        step = 'editable-form'
        let current = rb, form = null
        const seen = new Set()
        for (let n = 0; n < 4; n++) {
          if (current.status < 200 || current.status >= 400 || parseBookingResponse(current).state === 'failed') break
          if (current.status === 200 && requestEvidence(current, key, { field31876: own, workflowid: live.workflowId }) &&
              /doDelete\s*\(/.test(current.text)) {
            const forms = [...current.text.matchAll(/<form\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/form\s*>/gi)]
            const matching = forms.filter(m => {
              const a = attributes(`<form ${m[1]}>`)
              return new URL(a.action || '', current.url).href === `${OA_BASE}/workflow/request/RequestOperation.jsp` && (a.method || '').toLowerCase() === 'post'
            })
            if (matching.length === 1) {
              const p = successfulControls(matching[0][2])
              if (uniqueValue(p, 'requestid') === key && uniqueValue(p, 'workflowid') === live.workflowId &&
                  uniqueValue(p, 'field31876') === own && uniqueValue(p, 'nodetype') === '0') { form = p; break }
            }
          }
          const parsed = parseBookingResponse(current)
          const frames = [...(current.text || '').matchAll(/<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)].map(m => attributes(`<iframe ${m[1]}>`).src).filter(Boolean)
          const next = [...parsed.navigations, ...frames].map(u => safeResultUrl(u, current.url)).find(u => u && new URL(u).searchParams.get('requestid') === key && !seen.has(u) && /\/(?:ViewRequest|ViewRequestIframe|ManageRequestNoForm|ManageRequestNoFormIframe)\.jsp$/.test(new URL(u).pathname))
          if (!next) break
          seen.add(next); current = await get(next)
        }
        if (!form) return await save(outcome('unknown'))
        step = 'delete'
        form.set('src', 'delete') // all duplicate non-src controls retained
        await save(outcome('unknown'))
        await send(`${OA_BASE}/workflow/request/RequestOperation.jsp`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: current.url }, body: form.toString(),
        }) // no retry and no navigation from mutation response
        step = 'verify-deleted'
        const view = await get(`${OA_BASE}/workflow/request/ViewRequest.jsp?requestid=${key}`)
        const deleted = await confirmedDeleted(view)
        return await save(outcome(deleted ? 'cancelled' : 'unknown'))
      } catch {
        if (prior && !mutation) return { ...prior, replayBlocked: true }
        const result = outcome(mutation ? 'unknown' : 'rejected')
        if (mutation) { try { await save(result) } catch { /* intent already blocks replay */ } }
        return result // Never return raw OA errors, cookies, payload or tokens.
      } finally { locks.delete(key) }
    },
    async cancelApplication(trustedTask) {
      return publicOutcome(await this.cancel({ taskId: trustedTask.id, requestId: trustedTask.requestId }))
    },
  }
}

function publicOutcome(result) {
  const state = result.state === 'cancelled' ? 'cancelled' : ['unknown', 'busy'].includes(result.state) ? 'unknown' : 'ineligible'
  return { ok: state === 'cancelled', state, requestId: result.requestId,
    stage: result.step, message: state === 'cancelled' ? 'OA 流程单已确认删除；不代表场地或 OA 限额已释放' :
      state === 'unknown' ? '取消结果不确定，请到 OA 核实；请勿重复操作' : '该申请当前不符合取消条件',
    ...(result.replayBlocked ? { replayBlocked: true } : {}) }
}

let configuredService
export function configureCancellationService(dependencies) {
  configuredService = createCancellationService(dependencies)
  return configuredService
}

export async function cancelApplication(trustedTask, dependencies) {
  const service = dependencies ? createCancellationService(dependencies) : configuredService
  if (!service) return { ok: false, state: 'ineligible', requestId: trustedTask?.requestId,
    stage: 'authorize', message: '取消服务尚未配置可信身份和待办查询' }
  return service.cancelApplication(trustedTask)
}
