/** Explicit portal authentication action. Never logs cookie/token/credentials. */
import { loginPortal, listPendingApplications } from './portal.js'
try {
  await loginPortal({ reauthenticate: process.argv.includes('--reauth') })
  const rows = await listPendingApplications()
  console.log(`门户会话可用：${rows.length} 条本人待审核场馆申请`)
} catch (error) {
  console.error(error.publicMessage || '门户认证或查询失败')
  process.exitCode = 1
}
