<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchSnapshot } from './api'
import { freeSlotCount, nowInShanghai } from './time'
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

const totalFree = computed(() => (data.value?.venues ?? []).reduce(
  (sum, venue) => sum + (data.value?.dates ?? []).reduce((n, date) => n + freeSlotCount(venue, date, now.value), 0), 0))
const connectionError = ref(false)

function selectVenue(id) {
  selected.value = id
  if (window.matchMedia('(max-width: 720px)').matches) {
    document.getElementById('venue-detail')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
  }
}

async function load() {
  try {
    const next = await fetchSnapshot()
    if (!next) throw new Error('No snapshot')
    snap.value = next
    connectionError.value = false
  } catch {
    connectionError.value = true
  }
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
      <a class="brand" href="#"><span class="brand-mark" aria-hidden="true">S/</span><span>上科大 · 运动场馆<small>SHANGHAITECH / SPORTS</small></span></a>
      <div class="actions" role="status">
        <span v-if="connectionError" class="chip err">连接中断 · 自动重试中</span>
        <span v-else-if="status === 'loading'" class="chip loading"><i class="dot" />更新中 {{ progress.done }}/{{ progress.total }}</span>
        <span v-else-if="status === 'error'" class="chip err">更新失败 · 稍后重试</span>
        <span v-else class="chip ok">{{ data ? `更新于 ${updatedAt}` : '等待更新' }}</span>
        <span v-if="countdown" class="refresh-time">{{ countdown }}</span>
      </div>
    </header>

    <section class="intro">
      <div><p class="eyebrow">MAKE TIME. GET MOVING.</p><h1>今天，<span>上场。</span></h1><p class="intro-copy">找个空场，来场尽兴的运动。</p></div>
      <div v-if="data" class="intro-stat"><strong>{{ totalFree }}<span>↗</span></strong><p>未来 {{ data.dates.length }} 天 · 可约时段</p><small>{{ data.venues.length }} 个场馆 · 预约请前往 OA</small></div>
    </section>

    <main v-if="!data" class="empty" role="status">
      <template v-if="connectionError"><p>暂时无法连接，请稍后再试。</p><p class="hint">页面会自动重试。</p></template>
      <template v-else-if="status === 'loading'"><div class="spinner" /><p>正在更新场馆空闲信息…</p><div class="bar"><div class="bar-fill" :style="{ width: progress.total ? `${progress.done / progress.total * 100}%` : '8%' }" /></div></template>
      <template v-else-if="status === 'error'"><p class="err-text">场馆信息暂时不可用</p><p class="hint">{{ countdown ?? '等待下次自动更新' }}</p></template>
      <template v-else><p>场馆信息准备中</p><p class="hint">{{ countdown ?? '首次更新完成后将自动显示' }}</p></template>
    </main>

    <main v-else class="content">
      <p v-if="status === 'error' || connectionError" class="data-notice" role="status">当前展示上次成功获取的数据，空闲情况可能已变化。</p>
      <OverviewMatrix :venues="data.venues" :dates="data.dates" :now="now" :selected="current?.id" @select="selectVenue" />
      <VenueGrid v-if="current" :venue="current" :dates="data.dates" :now="now" />
      <footer class="foot"><span>数据来自 OA 场馆预约系统 · 以实际预约页面为准</span><span>所有时间均为北京时间</span></footer>
    </main>
  </div>
</template>
