<script setup>
import { computed } from 'vue'
import { cleanName, freeSlotCount, relativeDay, shortDate, weekday } from '../time'

const props = defineProps({
  venues: { type: Array, required: true },
  dates: { type: Array, required: true },
  now: { type: Object, required: true },
  selected: { type: String, default: null },
})
const emit = defineEmits(['select'])

const maxSlots = computed(() => props.venues[0]?.availability?.[props.dates[0]] ? Object.keys(props.venues[0].availability[props.dates[0]]).length : 11)

const rows = computed(() =>
  [...props.venues]
    .map((v) => ({
      venue: v,
      cells: props.dates.map((d) => ({ date: d, free: freeSlotCount(v, d, props.now) })),
      total: props.dates.reduce((s, d) => s + freeSlotCount(v, d, props.now), 0),
    }))
    .sort((a, b) => b.total - a.total)
)

const heat = (free) => {
  const ratio = Math.min(1, free / maxSlots.value)
  if (free === 0) return { background: 'transparent', borderColor: 'rgba(148,163,184,.14)' }
  return {
    background: `hsla(152, 70%, 45%, ${0.1 + ratio * 0.55})`,
    borderColor: `hsla(152, 70%, 55%, ${0.25 + ratio * 0.6})`,
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>总览 · 每天还能约到几个时段</h2>
      <span class="hint">点击行查看该场馆的时段明细</span>
    </div>

    <div class="matrix">
      <div class="matrix-head">
        <span class="col-venue">场馆</span>
        <span v-for="d in dates" :key="d" class="col-date">
          <b>{{ relativeDay(d, now) }}</b>
          <small>{{ shortDate(d) }} {{ weekday(d) }}</small>
        </span>
        <span class="col-total">合计</span>
      </div>

      <button
        v-for="r in rows"
        :key="r.venue.id"
        class="matrix-row"
        :class="{ active: r.venue.id === selected }"
        @click="emit('select', r.venue.id)"
      >
        <span class="col-venue">
          <b>{{ cleanName(r.venue.name) }}</b>
          <small>{{ r.venue.isParent ? `${r.venue.children} 片场地` : '整体预约' }}</small>
        </span>
        <span v-for="c in r.cells" :key="c.date" class="cell" :class="{ zero: c.free === 0 }" :style="heat(c.free)">
          <b>{{ c.free }}</b><small>/{{ maxSlots }}</small>
        </span>
        <span class="col-total" :class="{ zero: r.total === 0 }">{{ r.total }}</span>
      </button>
    </div>
  </section>
</template>