import test from 'node:test'
import assert from 'node:assert/strict'
import { bookingDatePolicy, shanghaiNow } from '../../shared/booking-date.mjs'
import { buildPayload, prepareBooking, submitBooking, BookingError } from '../src/booking.js'
import { freeSlotCount } from '../../web/src/time.js'

const saturday = (time) => new Date(`2026-11-07T${time}+08:00`)
const options = { venue: '乒乓球', date: '2026-11-09', slot: 8, siteId: '63_25', owner: '测试', phone: '12345678' }

test('Shanghai noon is strict: Saturday → Monday opens only after noon', () => {
  for (const time of ['11:59:59', '12:00:00', '12:00:01']) {
    const now = saturday(time)
    const expected = time === '12:00:01'
    assert.equal(bookingDatePolicy('2026-11-09', now).allowed, expected, time)
    assert.equal(bookingDatePolicy('2026-11-09', shanghaiNow(now)).allowed, expected)
    for (const date of ['2026-11-07', '2026-11-08']) assert.equal(bookingDatePolicy(date, now).allowed, true)
    assert.equal(bookingDatePolicy('2026-11-10', now).allowed, false)
  }
  assert.equal(bookingDatePolicy('2026-11-09', saturday('12:00:00.001')).allowed, true)
  assert.match(bookingDatePolicy('2026-11-09', saturday('11:59:59')).message, /2026-11-07.*12:00.*之后/)
})

test('past, malformed and impossible calendar dates fail closed', () => {
  const now = saturday('13:00:00')
  assert.equal(bookingDatePolicy('2026-11-06', now).reason, 'past')
  for (const date of [undefined, '', '2026-11-7', '2026-02-29', '2026-11-31', '2026-13-01']) {
    assert.equal(bookingDatePolicy(date, now).reason, 'invalid', String(date))
  }
  assert.equal(bookingDatePolicy('2028-02-29', new Date('2028-02-28T13:00:00+08:00')).allowed, true)
})

test('calendar day boundaries, month/year rollover and Shanghai timezone', () => {
  const now = new Date('2026-12-31T16:00:01Z') // Jan 1, Shanghai midnight
  assert.equal(shanghaiNow(now).date, '2027-01-01')
  assert.equal(bookingDatePolicy('2026-12-31', now).reason, 'past')
  assert.equal(bookingDatePolicy('2027-01-02', now).allowed, true)
  assert.equal(bookingDatePolicy('2027-01-03', now).allowed, false)
  // Late Saturday does not move the horizon forward to Tuesday.
  assert.equal(bookingDatePolicy('2026-11-10', saturday('23:59:59')).allowed, false)
})

test('buildPayload enforces date window with a deterministic clock', () => {
  assert.throws(() => buildPayload(options, saturday('12:00:00')), BookingError)
  assert.equal(buildPayload(options, saturday('12:00:01')).field31901, options.date)
  assert.throws(() => buildPayload({ ...options, date: '2026-11-31' }, saturday('13:00:00')), BookingError)
})

test('prepare and direct submit reject before any network, including caller wire date', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Network forbidden in offline test') })
  for (const date of ['2000-01-01', '9999-12-31', '2026-02-30', undefined]) {
    await assert.rejects(prepareBooking({ ...options, date }), BookingError)
    await assert.rejects(submitBooking({ field31901: date }, { date: shanghaiNow().date }), BookingError)
  }
  assert.equal(calls, 0)
})

test('UI counts bookable slots, not merely tree-free slots; clock unlocks without refresh', () => {
  const venue = { availability: { '2026-11-09': { '18:00-19:00': ['court'] } } }
  assert.equal(freeSlotCount(venue, '2026-11-09', shanghaiNow(saturday('12:00:00'))), 0)
  assert.equal(freeSlotCount(venue, '2026-11-09', shanghaiNow(saturday('12:00:01'))), 1)
})
