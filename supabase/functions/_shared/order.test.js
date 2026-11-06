import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submitOrder, OrderError, settleDate } from './order.js'
import { FakeQuoteSource } from './quote.js'
import { DEFAULT_FEES, commission } from './rules.js'

const T = (hhmmss) => new Date(`2026-10-21T${hhmmss}+08:00`)
const lotBook = (time) => ({ symbol: '2330', session: 'lot', asks: [{ price: 2420, qty: 1000 }, { price: 2425, qty: 2000 }], bids: [{ price: 2415, qty: 3000 }], last: 2420, limitUp: 2645, limitDown: 2165, ref: 2405, time })
const oddBook = (time) => ({ ...lotBook(time), session: 'odd', asks: [{ price: 2420, qty: 400 }], bids: [{ price: 2415, qty: 300 }] })

function fakeDb({ trading = true, placeError = null } = {}) {
  const log = { placed: [], applied: [], closed: [] }
  return {
    log,
    security: async (s) => (s === '2330' ? { symbol: '2330', name: '台積電', market: 'tse', kind: 'stock' } : null),
    isTradingDay: async () => trading,
    feeConfig: async () => DEFAULT_FEES,
    placeOrder: async (a) => { if (placeError) throw new Error(placeError); log.placed.push(a); return 'o' + log.placed.length },
    applyFills: async (id, fills, feeTotal, tax, explain) => { log.applied.push({ id, fills, feeTotal, tax, explain }) },
    closeOrder: async (id, status) => { log.closed.push({ id, status }) },
  }
}
const quotes = (time) => new FakeQuoteSource(new Map([['lot:2330', lotBook(time)], ['odd:2330', oddBook(time)]]))
const req = (o) => ({ accountId: 'acc', symbol: '2330', session: 'lot', side: 'buy', priceType: 'market', limit: null, qty: 1000, ...o })
const fresh = (t) => new Date(T(t).getTime() - 5000).toISOString()

test('收盤後市價單被拒且不建單', async () => {
  const db = fakeDb()
  await assert.rejects(submitOrder(req({}), T('13:31:00'), db, quotes(fresh('13:31:00'))), OrderError)
  assert.equal(db.log.placed.length, 0)
})
test('休市日被拒', async () => {
  const db = fakeDb({ trading: false })
  await assert.rejects(submitOrder(req({}), T('10:00:00'), db, quotes(fresh('10:00:00'))), /休市/)
})
test('報價過舊被拒', async () => {
  const db = fakeDb()
  await assert.rejects(submitOrder(req({}), T('10:00:00'), db, quotes('2026-10-21T01:59:00Z')), /報價中斷/)
  assert.equal(db.log.placed.length, 0)
})
test('整股 1500 股被拒', async () => {
  await assert.rejects(submitOrder(req({ qty: 1500 }), T('10:00:00'), fakeDb(), quotes(fresh('10:00:00'))), /1,000/)
})
test('不存在的股票被拒', async () => {
  await assert.rejects(submitOrder(req({ symbol: '9999' }), T('10:00:00'), fakeDb(), quotes(fresh('10:00:00'))), /查無/)
})
test('市價買 2000 股吃兩檔', async () => {
  const db = fakeDb()
  const r = await submitOrder(req({ qty: 2000 }), T('10:00:00'), db, quotes(fresh('10:00:00')))
  assert.equal(r.status, 'filled')
  assert.equal(db.log.placed[0].reserve, 2645 * 2000 + commission(2645 * 2000, 'lot', DEFAULT_FEES))
  assert.deepEqual(db.log.applied[0].fills, [{ price: 2420, qty: 1000 }, { price: 2425, qty: 1000 }])
  assert.equal(db.log.applied[0].feeTotal, commission(2420 * 1000 + 2425 * 1000, 'lot', DEFAULT_FEES))
  assert.equal(db.log.applied[0].tax, 0)
  assert.equal(db.log.applied[0].explain.settle_date, '2026-10-23')
})
test('市價買超過五檔：剩下的取消', async () => {
  const db = fakeDb()
  const r = await submitOrder(req({ qty: 5000 }), T('10:00:00'), db, quotes(fresh('10:00:00')))
  assert.equal(r.status, 'cancelled'); assert.deepEqual(db.log.closed, [{ id: 'o1', status: 'cancelled' }])
})
test('市價賣出收證交稅', async () => {
  const db = fakeDb()
  await submitOrder(req({ side: 'sell' }), T('10:00:00'), db, quotes(fresh('10:00:00')))
  assert.equal(db.log.placed[0].reserve, 0)
  assert.equal(db.log.applied[0].tax, Math.floor(2415000 * 0.003))
})
test('盤後零股市價單被拒', async () => {
  await assert.rejects(submitOrder(req({ session: 'odd_after', qty: 10 }), T('13:45:00'), fakeDb(), quotes(fresh('13:30:00'))), /只接受限價/)
})
test('盤後零股限價單：不檢查報價時間、不立刻成交', async () => {
  const db = fakeDb()
  const r = await submitOrder(req({ session: 'odd_after', qty: 10, priceType: 'limit', limit: 2420 }), T('13:45:00'), db, quotes('2026-10-21T05:30:00Z'))
  assert.equal(r.status, 'open'); assert.equal(db.log.applied.length, 0)
})
test('限價沒碰到 → 掛單', async () => {
  const db = fakeDb()
  const r = await submitOrder(req({ priceType: 'limit', limit: 2410 }), T('10:00:00'), db, quotes(fresh('10:00:00')))
  assert.equal(r.status, 'open'); assert.equal(db.log.applied.length, 0); assert.equal(db.log.placed[0].reserve, 2410000 + 3434)
})
test('限價不符升降單位被拒', async () => {
  await assert.rejects(submitOrder(req({ priceType: 'limit', limit: 2422 }), T('10:00:00'), fakeDb(), quotes(fresh('10:00:00'))), /升降單位/)
})
test('盤中零股 09:10 前：市價拒絕、限價只掛單', async () => {
  await assert.rejects(submitOrder(req({ session: 'odd', qty: 5 }), T('09:05:00'), fakeDb(), quotes(fresh('09:05:00'))), /09:10/)
  const db = fakeDb()
  const r = await submitOrder(req({ session: 'odd', qty: 5, priceType: 'limit', limit: 2430 }), T('09:05:00'), db, quotes(fresh('09:05:00')))
  assert.equal(r.status, 'open'); assert.equal(db.log.applied.length, 0)
})
test('盤中零股市價買：手續費最低 20', async () => {
  const db = fakeDb()
  const r = await submitOrder(req({ session: 'odd', qty: 1 }), T('10:00:00'), db, quotes(fresh('10:00:00')))
  assert.equal(r.status, 'filled'); assert.equal(db.log.applied[0].feeTotal, 20); assert.deepEqual(r.fills, [{ price: 2420, qty: 1 }])
})
test('資料庫拒絕（現金不足）轉成 OrderError', async () => {
  await assert.rejects(submitOrder(req({}), T('10:00:00'), fakeDb({ placeError: '可用現金不足' }), quotes(fresh('10:00:00'))), (e) => e instanceof OrderError && /現金不足/.test(e.message))
})
test('settleDate skips weekend', () => assert.equal(settleDate('2026-10-22'), '2026-10-26'))
