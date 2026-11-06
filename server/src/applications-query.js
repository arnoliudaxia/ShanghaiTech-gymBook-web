import { readOwnRequest, confirmDeletedRequest } from './oa-request.js'

/** A portal RUNNING record can outlive its OA request. This query never mutates OA. */
export function createApplicationQuery({ listPendingApplications, getOwnApplicantId, get, onDeleted = async () => {} }) {
  return async () => {
    const tasks = await listPendingApplications()
    const own = tasks.length ? String(await getOwnApplicantId()) : null
    const applications = []
    let deletedCount = 0, unverifiedCount = 0
    for (const task of tasks) {
      let check
      try { check = await readOwnRequest(task.requestId, get, { field31876: own }) } catch { check = { state: 'unknown' } }
      let deleted = false
      try { deleted = await confirmDeletedRequest(check.responses || [], get) }
      catch { /* Retain uncertain rows; never turn a network error into an empty list. */ }
      if (deleted) {
        deletedCount++
        try { await onDeleted(task) } catch { /* OA deletion proof remains valid if local hint persistence fails. */ }
        continue
      }
      const verified = check.state === 'exists'
      if (!verified) unverifiedCount++
      applications.push({ ...task, oaExistenceVerified: verified, canCancel: verified,
        verificationMessage: verified ? '已核对 OA 申请单存在' : 'OA 状态暂无法核实，未开放撤销，请稍后刷新或打开 OA 查看' })
    }
    return { applications, sourceCount: tasks.length, deletedCount, unverifiedCount }
  }
}
