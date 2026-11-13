import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FEES, mergeFees, commission, sellTax, tickSize, isValidPrice, validQty, kindOf,
  matchMarket, matchLimit, matchAfterHours, buyReserve, sessionState, taipeiDate, fillAmount,
} from './rules.js'

test('commission', () => {
  assert.equal(commission(2420 * 1000, 'lot', DEFAULT_FEES), 3449)
  assert.equal(commission(2420, 'odd', DEFAULT_FEES), 20)
  assert.equal(commission(100000, 'lot', mergeFees({ discount: 0.28 })), 40)
  assert.equal(commission(0, 'lot', DEFAULT_FEES), 0)
})
test('mergeFees ignores junk', () => {
  const f = mergeFees({ discount: -1, minFee: 1, foo: 3, commissionRate: 'x' })
  assert.equal(f.discount, 1); assert.equal(f.minFee, 1); assert.equal(f.commissionRate, DEFAULT_FEES.commissionRate); assert.ok(!('foo' in f))
})
test('sellTax', () => {
  assert.equal(sellTax(241500, 'stock', '2026-10-21'), 724)
  assert.equal(sellTax(100000, 'etf', '2026-10-21'), 100)
  assert.equal(sellTax(100000, 'bond_etf', '2026-12-31'), 0)
  assert.equal(sellTax(100000, 'bond_etf', '2027-01-04'), 100)
})
test('tickSize', () => {
  for (const [p, t] of [[9.99, 0.01], [10, 0.05], [49.95, 0.05], [50, 0.1], [100, 0.5], [500, 1], [999, 1], [1000, 5], [2420, 5]]) assert.equal(tickSize(p, 'stock'), t)
  assert.equal(tickSize(49.99, 'etf'), 0.01); assert.equal(tickSize(50, 'etf'), 0.05)
  assert.ok(isValidPrice(2420, 'stock', 2645, 2165)); assert.ok(!isValidPrice(2422, 'stock', 2645, 2165)); assert.ok(!isValidPrice(2650, 'stock', 2645, 2165))
  assert.ok(isValidPrice(10.05, 'stock', 11, 9))
  assert.ok(!isValidPrice(10.051, 'stock', 11, 9)); assert.ok(!isValidPrice(0, 'stock', 11, 0))
})
test('validQty', () => {
  assert.ok(validQty(2000, 'lot')); assert.ok(!validQty(1500, 'lot')); assert.ok(!validQty(0, 'lot'))
  assert.ok(validQty(1, 'odd')); assert.ok(validQty(999, 'odd_after')); assert.ok(!validQty(1000, 'odd')); assert.ok(!validQty(1.5, 'odd'))
})
test('kindOf', () => {
  assert.equal(kindOf('2330'), 'stock'); assert.equal(kindOf('0050'), 'etf'); assert.equal(kindOf('00631L'), 'etf')
  assert.equal(kindOf('00679B'), 'bond_etf'); assert.equal(kindOf('00981A'), 'etf'); assert.equal(kindOf('020020'), null); assert.equal(kindOf('03001P'), null)
})

const book = { symbol: '2330', session: 'lot', asks: [{ price: 2420, qty: 1000 }, { price: 2425, qty: 2000 }], bids: [{ price: 2415, qty: 3000 }], last: 2420, limitUp: 2645, limitDown: 2165, ref: 2405, time: '2026-10-21T05:00:00Z' }
test('matchMarket walks levels', () => assert.deepEqual(matchMarket(book, 'buy', 2000), [{ price: 2420, qty: 1000 }, { price: 2425, qty: 1000 }]))
test('matchMarket partial when book thin', () => assert.deepEqual(matchMarket(book, 'buy', 5000), [{ price: 2420, qty: 1000 }, { price: 2425, qty: 2000 }]))
test('matchMarket at limit up with no asks', () => assert.deepEqual(matchMarket({ ...book, asks: [] }, 'buy', 1000), []))
test('matchLimit', () => {
  assert.deepEqual(matchLimit(book, 'buy', 2420, 2000), [{ price: 2420, qty: 1000 }])
  assert.deepEqual(matchLimit(book, 'buy', 2410, 1000), [])
  assert.deepEqual(matchLimit(book, 'sell', 2400, 1000), [{ price: 2415, qty: 1000 }])
})
test('matchAfterHours', () => {
  assert.deepEqual(matchAfterHours(2420, 'buy', 2425, 10), [{ price: 2420, qty: 10 }])
  assert.deepEqual(matchAfterHours(2420, 'sell', 2425, 10), [])
  assert.deepEqual(matchAfterHours(null, 'buy', 2425, 10), [])
})
test('buyReserve', () => assert.equal(buyReserve(2645, 1000, 'lot', DEFAULT_FEES), 2645000 + 3769))
test('fillAmount rounds once in cents', () => {
  assert.equal(fillAmount([{ price: 10.05, qty: 3 }]), 30)
  assert.equal(fillAmount([{ price: 10.05, qty: 10 }]), 101)
})
test('sessionState', () => {
  const t = (hhmmss) => new Date(`2026-10-21T${hhmmss}+08:00`)
  assert.deepEqual(sessionState(t('08:59:59'), true), { lot: false, odd: false, oddMatch: false, oddAfter: false, oddAfterMatch: false })
  assert.equal(sessionState(t('09:05:00'), true).odd, true); assert.equal(sessionState(t('09:05:00'), true).oddMatch, false)
  assert.equal(sessionState(t('13:30:00'), true).lot, true); assert.equal(sessionState(t('13:30:01'), true).lot, false)
  assert.equal(sessionState(t('13:45:00'), true).oddAfter, true); assert.equal(sessionState(t('14:30:00'), true).oddAfterMatch, true)
  assert.equal(sessionState(t('10:00:00'), false).lot, false)
})
test('taipeiDate', () => {
  assert.equal(taipeiDate(new Date('2026-10-21T16:30:00Z')), '2026-10-22')
  assert.equal(taipeiDate(new Date('2026-10-21T15:59:59Z')), '2026-10-21')
})
