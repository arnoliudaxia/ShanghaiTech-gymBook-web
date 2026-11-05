<script setup>
import { computed } from 'vue'
import { cleanName, isPast, relativeDay, shortDate } from '../time'

const props = defineProps({
  venue: { type: Object, required: true },
  dates: { type: Array, required: true },
  now: { type: Object, required: true },
})

const slots = computed(() => Object.keys(props.venue.availability?.[props.dates[0]] ?? {}))

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

const daySummary = (date) =>
  slots.value.filter((s) => state(date, s).kind === 'free').length
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>
        {{ cleanName(venue.name) }}
        <span class="tag">{{ venue.isParent ? `${venue.children} 片` : '整体' }}</span>
      </h2>
      <span class="hint">悬停格子可看具体场地名</span>
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
          <span
            v-for="s in [state(d, slot)]"
            :key="s.kind"
            class="cell"
            :class="s.kind"
            :style="style(s)"
            :title="s.kind === 'free' ? s.courts.join('、') : s.kind === 'full' ? '已约满' : s.kind === 'past' ? '时段已过' : '请求失败'"
          >
            <b v-if="s.kind === 'free'">{{ s.courts.length }}</b>
            <b v-else-if="s.kind === 'full'">—</b>
            <b v-else-if="s.kind === 'past'">已过</b>
            <b v-else>×</b>
          </span>
        </template>
      </div>
    </div>

    <div class="legend">
      <span><i class="sw full" />约满</span>
      <span><i class="sw low" />少量</span>
      <span><i class="sw high" />充足</span>
      <span><i class="sw past" />已过</span>
      <span><i class="sw err" />请求失败</span>
    </div>
  </section>
</template>