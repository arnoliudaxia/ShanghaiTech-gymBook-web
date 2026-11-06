<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { cleanName, isPast, relativeDay, shortDate } from '../time'
import { fetchBookingMeta, fetchBookingQuota, submitBooking } from '../api'
import { bookingDatePolicy } from '../../../shared/booking-date.mjs'
import { bookingFieldsError } from '../../../shared/booking-fields.mjs'

/** 场馆名 → OA 表单「场馆类型」取值。只有这几个场馆支持在线预约 */
const BOOKABLE = { 羽毛球场: '羽毛球场', 乒乓球场: '乒乓球', 网球场: '网球场', 匹克球场: '匹克球场', 排球场: '排球场' }

const props = defineProps({
  venue: { type: Object, required: true },
  dates: { type: Array, required: true },
  now: { type: Object, required: true },
  quotaVersion: { type: Number, default: 0 },
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

const datePolicy = (date) => bookingDatePolicy(date, props.now)
const pickedPolicy = computed(() => picked.value ? datePolicy(picked.value.date) : null)
const daySummary = (date) => datePolicy(date).allowed ? slots.value.filter((s) => state(date, s).kind === 'free').length : 0

// 切换场馆时清空选中
watch(() => props.venue.id, () => {
  picked.value = null
  target.value = null
})

/* ---------------------------------------------------------------- 预约（半自动）
 * 后端单次提交后，以本人 OA 申请单的存在性验证结果；不自动重试。
 */
const STORAGE_KEY = 'gymbook.booking.form'
// 原始名带「室内」前缀（室内乒乓球场），先清洗再查表
const bookingVenue = computed(() => BOOKABLE[cleanName(props.venue.name)] ?? null)
const meta = ref(null)
const form = reactive({ people: 1, personType: '学生', thirdParty: '无', owner: '', phone: '' })
const target = ref(null) // 已选中的场地名
const busy = ref(false)
const feedback = ref('')
const quota = ref(null) // 今天各场馆类型的限额状态（本地记录）

async function refreshQuota() {
  try { quota.value = (await fetchBookingQuota()).quota ?? null } catch {}
}
watch(() => props.quotaVersion, refreshQuota)

onMounted(async () => {
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (cached) Object.assign(form, cached)
  } catch {}
  await refreshQuota()
  try {
    const m = await fetchBookingMeta()
    meta.value = m
    if (!form.owner && m.defaults?.owner) form.owner = m.defaults.owner
    if (!form.phone && m.defaults?.phone) form.phone = m.defaults.phone
  } catch {}
})

/** 今天该场馆类型是否已用掉限额 */
const quotaUsed = computed(() => {
  if (!bookingVenue.value || !quota.value) return null
  const q = quota.value[bookingVenue.value]
  if (!q?.used) return null
  return q.bookings?.[0] ?? {}
})

function chooseCourt(court) {
  target.value = target.value === court ? null : court
  feedback.value = ''
}

async function confirmBooking() {
  if (!bookingVenue.value || !target.value || !picked.value) return
  if (!pickedPolicy.value?.allowed || isPast(picked.value.date, picked.value.slot, props.now)) {
    feedback.value = pickedPolicy.value?.message || '该时段已过，不能预约'
    return
  }
  const siteId = props.venue.courtIds?.[target.value]
  if (!siteId) {
    feedback.value = `没取到「${target.value}」的场地 id，请等下一次采集完成再试`
    return
  }
  const fieldsError = bookingFieldsError(form)
  if (fieldsError) {
    feedback.value = `❌ ${fieldsError}`
    return
  }
  busy.value = true
  feedback.value = '正在提交…'
  const date = picked.value.date
  const slotLabel = picked.value.slot
  const court = target.value
  try {
    const res = await submitBooking({
      venue: bookingVenue.value,
      slotLabel,
      date,
      slot: slots.value.indexOf(slotLabel) + 1,
      siteId,
      siteName: court,
      venueId: props.venue.id,
      people: form.people,
      personType: form.personType,
      thirdParty: form.thirdParty,
      owner: form.owner,
      phone: form.phone,
    })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form))
    if (res.state === 'quota-used') {
      feedback.value = `⚠️ ${res.message}`
      quota.value = { ...(quota.value ?? {}), [bookingVenue.value]: res.quota }
    } else if (res.state === 'ok' && res.ok) {
      // 提交成功后本地把该场地从可约列表移除，等下一轮采集覆盖
      const list = props.venue.availability?.[date]?.[slotLabel]
      if (Array.isArray(list)) {
        const i = list.indexOf(court)
        if (i >= 0) list.splice(i, 1)
      }
      feedback.value = `✅ 已提交：${date} ${slotLabel} ${court}${res.requestId ? `（单号 ${res.requestId}）` : ''}。提交成功不代表审批完成，请到 OA「我的请求」查看审批状态`
      target.value = null
      picked.value = null
      await refreshQuota()
    } else if (res.state === 'failed' || res.state === 'rejected') {
      feedback.value = `❌ ${res.message || 'OA 明确拒绝了本次提交'}`
    } else {
      const tree = res.verified === 'gone' ? '场地树已不显示该场地，但不能证明本次提交成功。'
        : res.verified === 'still-free' ? '场地树仍显示可约，但不能据此认定提交失败。' : ''
      const message = res.message || res.error || '提交结果无法确认'
      const reminder = /核实|重复提交/.test(message) ? '' : '请到 OA「我的请求」核实，请勿直接重复提交。'
      feedback.value = `⚠️ ${message}。${tree}${reminder}`
    }
  } catch (err) {
    feedback.value = `⚠️ 提交结果无法确认：${err?.message || err}。请到 OA「我的请求」核实，请勿直接重复提交。`
  } finally {
    busy.value = false
  }
}

</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>
        {{ cleanName(venue.name) }}
        <span class="tag">{{ venue.isParent ? `${venue.children} 片` : '整体' }}</span>
      </h2>
      <span class="hint">绿色仅表示树接口空闲；未开放日期可查看但不可预约</span>
    </div>

    <div class="detail">
      <div class="detail-head">
        <span class="col-slot">时段</span>
        <span v-for="d in dates" :key="d" class="col-date">
          <b>{{ relativeDay(d, now) }}</b>
          <small :title="datePolicy(d).message">{{ shortDate(d) }} · {{ datePolicy(d).allowed ? `可约 ${daySummary(d)} 段` : '尚未开放' }}</small>
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
            :aria-label="`${d} ${slot} ${s.kind === 'free' ? (datePolicy(d).allowed ? (single ? '可约' : s.courts.length + ' 片可约') : '树接口空闲，尚未开放预约') : ''}`"
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
          <span class="picked-count">{{ pickedPolicy.allowed ? (single ? '可约' : `${picked.courts.length} / ${venue.children} 片可约`) : `树接口空闲 ${picked.courts.length} 片 · 尚未开放` }}</span>
        </div>
        <p v-if="!pickedPolicy.allowed" class="book-feedback">{{ pickedPolicy.message }}</p>
        <div class="courts">
          <button
            v-for="c in picked.courts"
            :key="c"
            type="button"
            class="court-chip"
            :class="{ target: target === c, disabled: !bookingVenue || !pickedPolicy.allowed }"
            :disabled="!bookingVenue || !pickedPolicy.allowed"
            :title="!pickedPolicy.allowed ? pickedPolicy.message : bookingVenue ? '点选后可预约' : '该场馆暂不支持在线预约'"
            @click="chooseCourt(c)"
          >
            {{ c }}
          </button>
        </div>

        <!-- 选中场地后展开的预约表单 -->
        <transition name="fade">
          <div v-if="bookingVenue && target" class="book-box">
            <p v-if="quotaUsed" class="quota-warn">
              ⚠️ 今天已经约过{{ cleanName(venue.name) }}（{{ quotaUsed.date }} {{ quotaUsed.slotLabel || '' }} {{ quotaUsed.siteName || '' }}）。
              每个场馆类型每人每天只能成功预约 1 次，再提交会被 OA 拒绝。
            </p>
            <div class="book-row">
              <label>参加人数<input v-model.number="form.people" type="number" min="1" /></label>
              <label>
                人员类别
                <select v-model="form.personType">
                  <option v-for="(v, k) in meta?.personTypes ?? { 学生: '0' }" :key="k" :value="k">{{ k }}</option>
                </select>
              </label>
              <label>
                第三方
                <select v-model="form.thirdParty">
                  <option v-for="(v, k) in meta?.thirdParty ?? { 无: '1' }" :key="k" :value="k">{{ k }}</option>
                </select>
              </label>
              <label>现场责任人<input v-model.trim="form.owner" type="text" placeholder="必填" /></label>
              <label>联系电话<input v-model.trim="form.phone" type="text" placeholder="必填" /></label>
            </div>
            <div class="book-actions">
              <button type="button" class="btn-primary" :disabled="busy || !!quotaUsed || !pickedPolicy.allowed || isPast(picked.date, picked.slot, now)" @click="confirmBooking">
                {{ busy ? '提交中…' : `确认预约 ${target}` }}
              </button>
              <span class="book-tip">以 OA 明确结果为准，场地树仅作补充核验</span>
            </div>
          </div>
        </transition>

        <p v-if="feedback" class="book-feedback">{{ feedback }}</p>
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