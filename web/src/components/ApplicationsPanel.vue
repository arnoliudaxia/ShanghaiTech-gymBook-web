<script setup>
import { nextTick, ref } from 'vue'
import { cancelApplication, fetchApplications } from '../api'

const emit = defineEmits(['cancelled', 'reconciled'])
const open = ref(false)
const loading = ref(false)
const loaded = ref(false)
const applications = ref([])
const deletedCount = ref(0)
const error = ref('')
const feedback = ref(null)
const selected = ref(null)
const cancelling = ref(false)
// 不确定的提交在本次页面会话中保持锁定，即使重新读取仍显示待审核也不自动重试。
const uncertainIds = ref(new Set())
const confirmButton = ref(null)
const refreshButton = ref(null)
const cancelButtons = new Map()

function messageOf(result, fallback) {
  return result?.message || result?.error || fallback
}

function needsLogin(result) {
  return [401, 403].includes(result?.httpStatus) || /login|auth|登录|认证|会话.*失效/i.test(`${result?.error || ''} ${result?.message || ''}`)
}

async function loadApplications() {
  if (loading.value || cancelling.value || selected.value) return
  loading.value = true
  loaded.value = false
  error.value = ''
  try {
    const result = await fetchApplications()
    if (!result.ok || !Array.isArray(result.applications)) {
      // The backend refreshes portal authentication before returning an auth failure.
      error.value = messageOf(result, '申请列表读取失败，请稍后刷新申请列表。')
      return
    }
    applications.value = result.applications
    deletedCount.value = result.deletedCount || 0
    if (deletedCount.value) emit('reconciled')
    loaded.value = true
  } catch {
    error.value = '无法读取申请列表（网络异常或服务响应无效），请刷新申请列表；这不代表没有申请。'
  } finally {
    loading.value = false
  }
}

function togglePanel() {
  if (cancelling.value || selected.value) return
  open.value = !open.value
  if (open.value) loadApplications()
}

function oaUrl(value) {
  try {
    const url = new URL(value, window.location.origin)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function displayTime(value) {
  if (!value) return '未提供'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
  }).format(date)
}

async function askCancel(application) {
  if (loading.value || cancelling.value || selected.value || application.canCancel === false || uncertainIds.value.has(application.id)) return
  selected.value = { ...application }
  await nextTick()
  confirmButton.value?.focus()
}

async function dismissConfirmation() {
  if (cancelling.value) return
  const id = selected.value?.id
  selected.value = null
  await nextTick()
  cancelButtons.get(id)?.focus()
}

async function confirmCancellation() {
  if (!selected.value || cancelling.value) return
  const application = selected.value
  cancelling.value = true
  feedback.value = null
  try {
    const result = await cancelApplication(application.id)
    const identity = `申请 ${result.requestId || application.requestId || application.id}`
    if (result.ok && result.state === 'cancelled') {
      applications.value = applications.value.filter((item) => item.id !== application.id)
      feedback.value = {
        kind: 'success',
        text: `${identity} 已确认删除`,
      }
      emit('cancelled', { id: application.id, requestId: result.requestId || application.requestId })
    } else if (!result.ok && ['failed', 'ineligible'].includes(result.state)) {
      feedback.value = {
        kind: 'warning',
        text: `${identity}：${result.state === 'ineligible' ? '当前不符合撤销条件' : '撤销未完成'}。${messageOf(result, '请刷新申请列表并在 OA 中核对状态。')}${result.stage ? `（阶段：${result.stage}）` : ''}${needsLogin(result) ? ' 请先完成 OA 登录。' : ''}`,
      }
    } else {
      markUnknown(application, messageOf(result, '服务未能确认最终删除结果。'))
    }
  } catch {
    markUnknown(application, '网络异常或服务响应无效，无法确认是否已执行删除。')
  } finally {
    cancelling.value = false
    selected.value = null
    await nextTick()
    refreshButton.value?.focus()
  }
}

function markUnknown(application, message) {
  uncertainIds.value.add(application.id)
  feedback.value = {
    kind: 'warning',
    text: `申请 ${application.requestId || application.id} 撤销结果未知。${message} 请勿重试撤销；点击“刷新申请列表”并打开 OA 核对最终状态。本页已禁用该申请的再次撤销。`,
  }
}
</script>

<template>
  <section class="panel applications-panel" aria-labelledby="applications-heading">
    <div class="panel-head">
      <h2 id="applications-heading">我的待审核场馆申请</h2>
      <button class="btn" type="button" :aria-expanded="open" aria-controls="applications-content" :disabled="cancelling || !!selected" @click="togglePanel">
        {{ open ? '收起申请' : '查看申请' }}
      </button>
    </div>
    <div v-if="open" id="applications-content" :aria-busy="loading || cancelling">
      <div class="application-toolbar">
        <p class="hint">仅列出当前账号待审核的场馆申请，不刷新场馆空闲数据。</p>
        <button ref="refreshButton" class="btn" type="button" :disabled="loading || cancelling || !!selected" @click="loadApplications">{{ loading ? '读取中…' : '刷新申请列表' }}</button>
      </div>
      <p v-if="feedback" class="application-notice" :class="feedback.kind" role="status">{{ feedback.text }}</p>
      <p v-if="loading" class="hint" role="status">正在读取待审核申请…</p>
      <p v-else-if="error" class="application-notice warning" role="alert">{{ error }}</p>
      <template v-else-if="loaded">
        <p v-if="deletedCount" class="hint">门户仍保留 {{ deletedCount }} 条待审核记录，但 OA 已确认删除，已从可撤销列表排除。</p>
        <p v-if="!applications.length" class="hint" role="status">当前没有待审核的场馆申请。</p>
        <ul v-else class="application-list">
          <li v-for="application in applications" :key="application.id" class="application-item">
            <div class="application-details">
              <h3>{{ application.title }}</h3>
              <p>申请编号：{{ application.requestId || application.id }} · <span class="tag">{{ application.statusLabel || '待审核' }}</span></p>
              <p>提交时间（北京时间）：<time :datetime="application.createdAt">{{ displayTime(application.createdAt) }}</time></p>
              <p v-if="application.venue || application.date || application.slotLabel || application.siteName">{{ [application.venue, application.date, application.slotLabel, application.siteName].filter(Boolean).join(' · ') }}</p>
              <p v-if="application.verificationMessage" :class="{ 'application-warning': application.canCancel === false }">{{ application.verificationMessage }}</p>
              <p v-if="uncertainIds.has(application.id)" class="application-warning">结果未知，请勿重试；请刷新列表并在 OA 中核对。</p>
            </div>
            <div class="application-actions">
              <a v-if="application.url && oaUrl(application.url)" :href="oaUrl(application.url)" target="_blank" rel="noopener noreferrer">在 OA 查看<span class="sr-only">（新窗口）</span></a>
              <button :ref="(element) => element ? cancelButtons.set(application.id, element) : cancelButtons.delete(application.id)" class="btn danger" type="button" :disabled="loading || cancelling || !!selected || application.status !== 'pending' || application.canCancel === false || uncertainIds.has(application.id)" :aria-label="`撤销申请：${application.title}（${application.requestId || application.id}）`" @click="askCancel(application)">撤销申请</button>
            </div>
          </li>
        </ul>
      </template>
      <section v-if="selected" class="application-confirm" role="region" aria-labelledby="cancel-heading" @keydown.esc="dismissConfirmation">
        <h3 id="cancel-heading">确认撤销这条申请？</h3>
        <p><strong>{{ selected.title }}</strong></p>
        <p>申请编号：{{ selected.requestId || selected.id }} · 提交时间：{{ displayTime(selected.createdAt) }}</p>
        <p v-if="selected.venue || selected.date || selected.slotLabel || selected.siteName">{{ [selected.venue, selected.date, selected.slotLabel, selected.siteName].filter(Boolean).join(' · ') }}</p>
        <p>将执行“强制收回 → 删除”。删除不可恢复，如需预约必须重新申请。只有点击下方确认按钮后才会执行；不会自动重试。</p>
        <div class="application-actions">
          <button class="btn" type="button" :disabled="cancelling" @click="dismissConfirmation">保留申请</button>
          <button ref="confirmButton" class="btn danger" type="button" :disabled="cancelling" @click="confirmCancellation">{{ cancelling ? '正在撤销，请勿重复操作…' : '确认强制收回并删除' }}</button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.applications-panel { margin-bottom: 20px; }
.panel-head { align-items: center; margin-bottom: 0; }
.application-toolbar, .application-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.application-toolbar { justify-content: space-between; margin-top: 14px; }
.hint, .application-details p { color: var(--muted); font-size: 12px; line-height: 1.7; }
.application-list { list-style: none; padding: 0; margin: 14px 0 0; }
.application-item { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
.application-details { flex: 1 1 280px; min-width: 0; overflow-wrap: anywhere; }
h3 { margin: 0 0 8px; font-size: 14px; }
p { margin: 6px 0; }
a { color: #7dd3fc; }
.danger { color: #fecaca; border-color: rgba(248, 113, 113, .5); background: rgba(248, 113, 113, .1); }
.danger:hover:not(:disabled) { background: rgba(248, 113, 113, .2); }
.application-confirm, .application-notice { padding: 14px; margin-top: 14px; border: 1px solid var(--line); border-radius: 10px; line-height: 1.7; overflow-wrap: anywhere; }
.application-confirm, .warning { color: #fde68a; border-color: rgba(251, 191, 36, .4); background: rgba(251, 191, 36, .06); }
.application-warning { color: #fde68a !important; }
.success { color: #a7f3d0; border-color: rgba(52, 211, 153, .35); }
.application-confirm .application-actions { margin-top: 12px; }
button:focus-visible, a:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 4px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
