<script setup>
import { cleanName, freeSlotCount, relativeDay, shortDate } from '../time'
import { sportTheme } from '../sports'
import SportArt from './SportArt.vue'
defineProps({ venues: Array, dates: Array, now: Object, selected: [String, Number] })
const emit = defineEmits(['select'])
</script>

<template>
  <section aria-labelledby="sports-title">
    <div class="section-heading">
      <h2 id="sports-title"><span>01</span> 选一项，动起来。</h2>
      <p>选择运动，查看空闲场地 ↘</p>
    </div>
    <div class="sports-grid">
      <button v-for="(venue, index) in venues" :key="venue.id" type="button"
        class="sport-card" :class="{ active: selected === venue.id }"
        :style="{ '--sport': sportTheme(venue.name).color }"
        :aria-pressed="selected === venue.id" aria-controls="venue-detail"
        @click="emit('select', venue.id)">
        <span class="sport-poster">
          <span class="sport-index">{{ String(index + 1).padStart(2, '0') }} / {{ sportTheme(venue.name).label }}</span>
          <SportArt :kind="sportTheme(venue.name).kind" />
          <span class="sport-name">{{ cleanName(venue.name) }}</span>
          <span class="sport-arrow" aria-hidden="true">{{ selected === venue.id ? '✓' : '↗' }}</span>
        </span>
        <span class="sport-days">
          <span v-for="date in dates" :key="date">
            <small>{{ relativeDay(date, now) || shortDate(date) }}</small>
            <strong>{{ freeSlotCount(venue, date, now) }}<em> 时段</em></strong>
          </span>
        </span>
        <span class="sport-card-foot">{{ selected === venue.id ? '正在查看时段' : '查看空闲时段' }} <span aria-hidden="true">→</span></span>
      </button>
    </div>
    <p v-if="!venues.length" class="hint">暂无可展示的场馆，等待下次更新。</p>
  </section>
</template>
