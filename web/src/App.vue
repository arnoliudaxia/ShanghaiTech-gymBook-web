<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchSnapshot, requestRefresh } from './api'
import { nowInShanghai, relativeDay } from './time'
import OverviewMatrix from './components/OverviewMatrix.vue'
import VenueGrid from './components/VenueGrid.vue'

const snap = ref({ status: 'idle', data: null, error: null, progress: { done: 0, total: 0 } })
const now = ref(nowInShanghai())
const selected = ref(null)
let timer = null

const data = computed(() => snap.value.data)
const status = computed(() => snap.value.status)
const progress = computed(() => snap.value.progress ?? { done: 0, total: 0 })
const error = computed(() => snap.value.error)

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
  snap.value = (await fetchSnapshot()) ?? snap.value
  if (snap.value.status === 'loading' || !snap.value.data) startPolling()
  else stopPolling()
}

function startPolling() {
  if (timer) return
  timer = setInterval(async () => {
    snap.value = await fetchSnapshot()
    if (snap.value.status !== 'loading' && snap.value.data) stopPolling()
  }, 2000)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

async function doRefresh() {
  snap.value = (await requestRefresh()) ?? snap.value
  startPolling()
}

onMounted(() => {
  load()
  setInterval(() => (now.value = nowInShanghai()), 30000)
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <h1>🏟️ 上科大场馆空闲看板</h1>
        <p class="sub">
          数据源：OA 场馆预约系统 · 未来 {{ data?.dates?.length ?? 3 }} 天 ·
          {{ data ? `${data.venues.length} 个场馆 / ${totalFree} 条可约记录` : '等待采集' }}
        </p>
      </div>
      <div class="actions">
        <span v-if="status === 'loading'" class="chip loading">
          <i class="dot" />采集中 {{ progress.done }}/{{ progress.total }}
        </span>
        <span v-else-if="status === 'error'" class="chip err">采集失败</span>
        <span v-else class="chip ok">更新于 {{ updatedAt }}</span>
        <button class="btn" :disabled="status === 'loading'" @click="doRefresh">
          {{ status === 'loading' ? '采集中…' : '刷新' }}
        </button>
      </div>
    </header>

    <main v-if="!data" class="empty">
      <div v-if="status === 'loading'" class="spinner" />
      <template v-if="status === 'loading'">
        <p>正在登录 OA 并采集 {{ progress.total || '…' }} 个时段…</p>
        <div class="bar"><div class="bar-fill" :style="{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '8%' }" /></div>
      </template>
      <p v-else-if="status === 'error'" class="err-text">❌ {{ error }}</p>
      <button v-else class="btn" @click="doRefresh">开始采集</button>
    </main>

    <main v-else class="content">
      <OverviewMatrix :venues="data.venues" :dates="data.dates" :now="now" :selected="current?.id" @select="selected = $event" />

      <VenueGrid v-if="current" :venue="current" :dates="data.dates" :now="now" />

      <footer class="foot">
        <span>时段口径：{{ data.slots[0] }} … {{ data.slots[data.slots.length - 1] }}（11 段）</span>
        <span v-if="data.skipped?.length">已忽略仅整体预约的场馆：{{ data.skipped.join('、') }}</span>
        <span>绿色数字 = 该时段仍可约的场地片数</span>
      </footer>
    </main>
  </div>
</template>