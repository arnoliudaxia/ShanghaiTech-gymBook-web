<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchSnapshot } from './api'
import { nowInShanghai } from './time'
import OverviewMatrix from './components/OverviewMatrix.vue'
import VenueGrid from './components/VenueGrid.vue'

const snap = ref({ status: 'idle', data: null, error: null, progress: { done: 0, total: 0 }, schedule: [] })
const now = ref(nowInShanghai())
const clock = ref(Date.now())
const selected = ref(null)
let pollTimer = null
let clockTimer = null

const data = computed(() => snap.value.data)
const status = computed(() => snap.value.status)
const progress = computed(() => snap.value.progress ?? { done: 0, total: 0 })
const error = computed(() => snap.value.error)
const schedule = computed(() => snap.value.schedule ?? [])
const nextRunAt = computed(() => {
  const times = schedule.value.map((r) => r.nextRunAt).filter(Boolean).map((t) => Date.parse(t)).sort((a, b) => a - b)
  return times[0] ?? null
})
const countdown = computed(() => {
  if (!nextRunAt.value) return null
  const sec = Math.round((nextRunAt.value - clock.value) / 1000)
  if (sec <= 0) return '即将刷新'
  return sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s 后刷新` : `${sec}s 后刷新`
})

const current = computed(() => {
  const vs = data.value?.venues ?? []
  return vs.find((v) => v.id === selected.value) ?? vs[0] ?? null
})

const updatedAt = computed(() => {
  const t = snap.value.finishedAt
  if (!t) return '—'
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t))
})

const totalFree = computed(() =>
  (data.value?.venues ?? []).reduce(
    (sum, v) => sum + Object.values(v.availability).reduce((s, row) => s + Object.values(row).filter((c) => Array.isArray(c) && c.length).length, 0),
    0
  )
)

async function load() {
  const next = await fetchSnapshot()
  if (next) snap.value = next
}

onMounted(() => {
  load()
  pollTimer = setInterval(load, 30000)  // 只读轮询，等待 cron 刷新结果
  clockTimer = setInterval(() => {
    clock.value = Date.now()
    now.value = nowInShanghai()
  }, 1000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <h1>🏟️ 上科大场馆空闲看板</h1>
        <p class="sub">
          数据源：OA 场馆预约系统 · 未来 {{ data?.dates?.length ?? 3 }} 天 ·
          {{ data ? `${data.venues.length} 个场馆 / ${totalFree} 条可约记录` : '等待首次采集' }}
        </p>
      </div>
      <div class="actions">
        <span v-if="status === 'loading'" class="chip loading">
          <i class="dot" />采集中 {{ progress.done }}/{{ progress.total }}
        </span>
        <span v-else-if="status === 'error'" class="chip err">{{ snap.trigger === 'cron' ? '自动刷新失败' : '采集失败' }}</span>
        <span v-else class="chip ok">更新于 {{ updatedAt }}</span>
        <span v-if="countdown" class="chip sched" :title="schedule.map((r) => r.expression).join(' | ')">
          ⏱ {{ countdown }}
        </span>
      </div>
    </header>

    <main v-if="!data" class="empty">
      <div v-if="status === 'loading'" class="spinner" />
      <template v-if="status === 'loading'">
        <p>正在登录 OA 并采集 {{ progress.total || '…' }} 个时段…</p>
        <div class="bar"><div class="bar-fill" :style="{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '8%' }" /></div>
      </template>
      <template v-else-if="status === 'error'">
        <p class="err-text">❌ {{ error }}</p>
        <p class="hint">定时任务会在下一个周期重试（{{ countdown ?? '规则未装载' }}）</p>
      </template>
      <template v-else>
        <p>本地无缓存，等待定时采集任务首次执行（{{ countdown ?? '未装载 cron 规则' }}）</p>
        <p class="hint">刷新只由 cron.txt / 环境变量驱动，页面不提供手动采集</p>
      </template>
    </main>

    <main v-else class="content">
      <OverviewMatrix :venues="data.venues" :dates="data.dates" :now="now" :selected="current?.id" @select="selected = $event" />

      <VenueGrid v-if="current" :venue="current" :dates="data.dates" :now="now" />

      <footer class="foot">
        <span>时段口径：{{ data.slots[0] }} … {{ data.slots[data.slots.length - 1] }}（11 段）</span>
        <span v-if="data.skipped?.length">已忽略仅整体预约的场馆：{{ data.skipped.join('、') }}</span>
        <span v-if="schedule.length">刷新规则：{{ schedule.map((r) => r.expression).join(' / ') }}（cron.txt）</span>
        <span>绿色数字 = 该时段仍可约的场地片数</span>
      </footer>
    </main>
  </div>
</template>