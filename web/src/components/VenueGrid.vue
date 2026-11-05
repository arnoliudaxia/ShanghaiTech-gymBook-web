<script setup>
import { computed, ref, watch } from 'vue'
import { cleanName, isPast, relativeDay, shortDate } from '../time'

const props = defineProps({
  venue: { type: Object, required: true },
  dates: { type: Array, required: true },
  now: { type: Object, required: true },
})

const slots = computed(() => Object.keys(props.venue.availability?.[props.dates[0]] ?? {}))
/** 只有一片场地的场馆（含整体预约型）：格子里不显示片数，改用对勾 */
const single = computed(() => (props.venue.children ?? 0) <= 1)
const picked = ref(null) // { date, slot, courts }

const state = (date, slot) => {
  if (isPast(date, slot, props.now)) return { kind: 'past' }
  const courts = props.venue.availability?.[date]?.[slot]
  if (courts === null || courts === undefined) return { kind: 'error' }
  if (courts.length === 0) return { kind: 'full' }
  return { kind: 'free', courts }
}

const style = (s) => {
  if (s.kind !== 'free') return {}
  const ratio = Math.min(1, s.courts.length / Math.max(1, props.venue.children))
  return { background: `hsla(152, 68%, 45%, ${0.14 + ratio * 0.6})`, borderColor: `hsla(152, 68%, 58%, ${0.3 + ratio * 0.5})` }
}

const isPicked = (date, slot) => picked.value?.date === date && picked.value?.slot === slot

const pick = (date, slot) => {
  const s = state(date, slot)
  if (s.kind !== 'free') {
    picked.value = null
    return
  }
  picked.value = isPicked(date, slot) ? null : { date, slot, courts: s.courts }
}

const daySummary = (date) => slots.value.filter((s) => state(date, s).kind === 'free').length

// 切换场馆时清空选中
watch(() => props.venue.id, () => (picked.value = null))
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>
        {{ cleanName(venue.name) }}
        <span class="tag">{{ venue.isParent ? `${venue.children} 片` : '整体' }}</span>
      </h2>
      <span class="hint">点击绿色格子查看具体场地</span>
    </div>

    <div class="detail">
      <div class="detail-head">
        <span class="col-slot">时段</span>
        <span v-for="d in dates" :key="d" class="col-date">
          <b>{{ relativeDay(d, now) }}</b>
          <small>{{ shortDate(d) }} · 可约 {{ daySummary(d) }} 段</small>
        </span>
      </div>

      <div v-for="slot in slots" :key="slot" class="detail-row">
        <span class="col-slot">{{ slot }}</span>
        <template v-for="d in dates" :key="d">
          <button
            v-for="s in [state(d, slot)]"
            :key="s.kind"
            type="button"
            class="cell"
            :class="[s.kind, { picked: isPicked(d, slot) }]"
            :style="style(s)"
            :disabled="s.kind !== 'free'"
            :aria-label="`${d} ${slot} ${s.kind === 'free' ? (single ? '可约' : s.courts.length + ' 片可约') : ''}`"
            @click="pick(d, slot)"
          >
            <b v-if="s.kind === 'free'" :class="{ mark: single }">{{ single ? '✓' : s.courts.length }}</b>
            <b v-else-if="s.kind === 'full'">—</b>
            <b v-else-if="s.kind === 'past'">已过</b>
            <b v-else>×</b>
          </button>
        </template>
      </div>
    </div>

    <!-- 选中格子：列出具体可约场地 -->
    <transition name="fade">
      <div v-if="picked" class="picked-panel">
        <div class="picked-head">
          <b>{{ relativeDay(picked.date, now) }} {{ shortDate(picked.date) }} · {{ picked.slot }}</b>
          <span class="picked-count">{{ single ? '可约' : `${picked.courts.length} / ${venue.children} 片可约` }}</span>
        </div>
        <div class="courts">
          <span v-for="c in picked.courts" :key="c" class="court-chip">{{ c }}</span>
        </div>
      </div>
    </transition>

    <div class="legend">
      <span><i class="sw full" />约满</span>
      <span><i class="sw low" />少量</span>
      <span><i class="sw high" />充足</span>
      <span><i class="sw past" />已过</span>
      <span><i class="sw err" />请求失败</span>
    </div>
  </section>
</template>