import test from 'node:test'
import assert from 'node:assert/strict'
import { bookingFieldsError } from '../../shared/booking-fields.mjs'
import { shanghaiNow } from '../../shared/booking-date.mjs'
import { buildPayload, prepareBooking, submitBooking, BookingError } from '../src/booking.js'
const options = { venue: '排球场', date: shanghaiNow().date, slot: 1, siteId: '63_45', people: 1, owner: '测试', phone: '12345678' }

test('required contact fields and positive integer people produce clear shared messages', () => {
  assert.equal(bookingFieldsError({ people: 1 }), '请填写现场责任人和联系电话')
  assert.equal(bookingFieldsError({ ...options, owner: '  ' }), '请填写现场责任人')
  assert.equal(bookingFieldsError({ ...options, phone: '' }), '请填写联系电话')
  for (const people of [0, -1, 1.5, 'abc', '']) assert.equal(bookingFieldsError({ ...options, people }), '参加人数必须为正整数')
  assert.equal(bookingFieldsError(options), '')
  const payload = buildPayload({ ...options, owner: ' 测试 ', phone: ' 12345678 ' })
  assert.equal(payload.field31888, '测试')
  assert.equal(payload.field31889, '12345678')
})

test('missing required contacts never fetch the OA form or send an operation POST', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('Network forbidden') })
  await assert.rejects(prepareBooking({ ...options, owner: '', phone: '' }), /请填写现场责任人和联系电话/)
  await assert.rejects(submitBooking({ field31901: options.date, field31888: '', field31889: '', field31884: '1' }), BookingError)
  assert.equal(calls, 0)
})
