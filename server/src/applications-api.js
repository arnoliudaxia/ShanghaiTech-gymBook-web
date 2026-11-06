const TITLE_PREFIX = '学生和教工场馆借用申请-'

/** Only the server's freshly fetched personal pending list can authorize a cancellation. */
export function installApplicationsRoutes(app, { listPendingApplications, listApplicationsForDisplay = listPendingApplications, cancelApplication }) {
  app.get('/api/applications', async (_req, res) => {
    try {
      const result = await listApplicationsForDisplay()
      const data = Array.isArray(result) ? { applications: result } : result
      res.json({ ok: true, ...data, source: 'egate', fetchedAt: new Date().toISOString() })
    } catch (err) {
      res.status(err.status === 401 ? 401 : 502).json({ ok: false, error: err.publicMessage || '读取门户申请列表失败，请稍后刷新；不会用本地记录冒充门户结果' })
    }
  })

  app.post('/api/applications/:id/cancel', async (req, res) => {
    // Explicit JSON confirmation and same-origin browser requests only; never accept a caller-supplied OA URL.
    const origin = req.get('origin')
    let sameOrigin = true
    if (origin) {
      try { sameOrigin = new URL(origin).host === req.get('host') } catch { sameOrigin = false }
    }
    if (!sameOrigin || !req.is('application/json') || req.body?.confirm !== true) {
      return res.status(400).json({ ok: false, state: 'ineligible', message: '撤销需要本站页面的明确确认' })
    }
    try {
      const applications = await listPendingApplications()
      const task = applications.find((item) => String(item.id) === req.params.id)
      if (!task || task.status !== 'pending' || !task.title?.startsWith(TITLE_PREFIX) || !/^\d+$/.test(String(task.requestId ?? ''))) {
        return res.status(409).json({ ok: false, state: 'ineligible', message: '该申请已不在本人待审核场馆列表中，未执行撤销；请刷新列表核实' })
      }
      const result = await cancelApplication(task)
      const code = result.ok ? 200 : result.state === 'unknown' ? 202 : result.state === 'ineligible' ? 409 : 502
      res.status(code).json(result)
    } catch (err) {
      // A transport error could have happened after the destructive request was sent.
      res.status(502).json({ ok: false, state: 'unknown', message: err.publicMessage || '无法确认撤销结果，请到 OA 查看该单；请勿直接重复撤销' })
    }
  })
}
