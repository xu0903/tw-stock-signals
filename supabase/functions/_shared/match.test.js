import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchOpenOrders, bookKey } from './match.js'
import { sessionState, DEFAULT_FEES } from './rules.js'

const now = new Date('2026-10-21T10:00:00+08:00')
const book = { symbol: '2330', session: 'lot', asks: [{ price: 2420, qty: 1000 }, { price: 2425, qty: 2000 }], bids: [{ price: 2415, qty: 3000 }], last: 2420, limitUp: 2645, limitDown: 2165, ref: 2405, time: '2026-10-21T01:59:55Z' }
const books = new Map([[bookKey('lot', '2330'), book]])
const order = (o) => ({ id: 'o1', accountId: 'a', symbol: '2330', session: 'lot', side: 'buy', limit: 2420, remaining: 1000, feeCharged: 0, filledAmount: 0, kind: 'stock', ...o })
const fees = () => DEFAULT_FEES

test('限價買單碰到 → 成交', () => {
  const r = matchOpenOrders([order({})], books, now, sessionState(now, true), fees)
  assert.deepEqual(r, [{ orderId: 'o1', fills: [{ price: 2420, qty: 1000 }], feeTotal: 3449, tax: 0, amount: 2420000 }])
})
test('沒碰到 → 不成交', () => {
  assert.deepEqual(matchOpenOrders([order({ limit: 2415 })], books, now, sessionState(now, true), fees), [])
})
test('test_no_fill_after_close', () => {
  const t = new Date('2026-10-21T13:30:05+08:00')
  const fresh = new Map([[bookKey('lot', '2330'), { ...book, time: '2026-10-21T05:30:00Z' }]])
  assert.deepEqual(matchOpenOrders([order({})], fresh, t, sessionState(t, true), fees), [])
})
test('報價過舊 → 跳過', () => {
  const old = new Map([[bookKey('lot', '2330'), { ...book, time: '2026-10-21T01:58:00Z' }]])
  assert.deepEqual(matchOpenOrders([order({})], old, now, sessionState(now, true), fees), [])
})
test('同一檔兩張買單：第一張吃掉的量不再給第二張', () => {
  const r = matchOpenOrders([order({ id: 'o1', limit: 2425, remaining: 2000 }), order({ id: 'o2', limit: 2425, remaining: 2000 })], books, now, sessionState(now, true), fees)
  assert.deepEqual(r.map((x) => [x.orderId, x.fills]), [
    ['o1', [{ price: 2420, qty: 1000 }, { price: 2425, qty: 1000 }]],
    ['o2', [{ price: 2425, qty: 1000 }]],
  ])
  assert.equal(book.asks[0].qty, 1000)   // 原本的五檔沒被改到
})
test('部分成交後再成交：手續費累計、稅算差額', () => {
  const [r] = matchOpenOrders([order({ side: 'sell', limit: 2415, remaining: 1000, filledAmount: 2415000, feeCharged: 3441 })], books, now, sessionState(now, true), fees)
  assert.equal(r.feeTotal, 6883)   // (2415000 × 2) × 0.1425% = 6882.9
  assert.equal(r.tax, 7245)
})
test('盤中零股 09:10 前不撮合；盤後零股單不在這裡撮合', () => {
  const t = new Date('2026-10-21T09:05:00+08:00')
  const ob = new Map([[bookKey('odd', '2330'), { ...book, session: 'odd', time: '2026-10-21T01:04:58Z' }]])
  assert.deepEqual(matchOpenOrders([order({ session: 'odd', remaining: 5 })], ob, t, sessionState(t, true), fees), [])
  assert.deepEqual(matchOpenOrders([order({ session: 'odd_after', remaining: 5 })], ob, now, sessionState(now, true), fees), [])
})
