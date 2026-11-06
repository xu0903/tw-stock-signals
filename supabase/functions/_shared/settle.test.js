import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dividendPayout, matchAfterHoursOrders } from './settle.js'
import { estimatePayDate } from './refdata.js'
import { DEFAULT_FEES } from './rules.js'

const act = (o) => ({ symbol: '2412', exDate: '2026-12-16', cashPerShare: 0, stockPerShare: 0, payDate: '2027-01-15', payDateEstimated: true, ...o })

test('現金股利', () => {
  assert.deepEqual(dividendPayout(1000, act({ cashPerShare: 7 }), DEFAULT_FEES), { cash: 7000, nhi: 0, newShares: 0, cashInLieu: 0 })
  assert.deepEqual(dividendPayout(3000, act({ cashPerShare: 7 }), DEFAULT_FEES), { cash: 21000, nhi: 443, newShares: 0, cashInLieu: 0 })
  assert.equal(dividendPayout(333, act({ cashPerShare: 4.5 }), DEFAULT_FEES).cash, 1498)
})
test('配股與零股折現', () => {
  assert.deepEqual(dividendPayout(150, act({ stockPerShare: 0.5 }), DEFAULT_FEES), { cash: 0, nhi: 0, newShares: 7, cashInLieu: 5 })
  assert.deepEqual(dividendPayout(1000, act({ stockPerShare: 1 }), DEFAULT_FEES), { cash: 0, nhi: 0, newShares: 100, cashInLieu: 0 })
})
test('estimatePayDate 遇休市順延', () => {
  assert.equal(estimatePayDate('2026-12-16', new Set(['2027-01-15'])), '2027-01-18')
})
test('盤後零股撮合', () => {
  const now = new Date('2026-10-21T14:31:00+08:00')
  const orders = [
    { id: 'b1', accountId: 'a', symbol: '2330', side: 'buy', limit: 2425, remaining: 10, kind: 'stock' },
    { id: 's1', accountId: 'a', symbol: '2330', side: 'sell', limit: 2425, remaining: 10, kind: 'stock' },
    { id: 'b2', accountId: 'a', symbol: '2317', side: 'buy', limit: 200, remaining: 10, kind: 'stock' },
  ]
  const r = matchAfterHoursOrders(orders, new Map([['2330', 2420], ['2317', null]]), now, () => DEFAULT_FEES)
  assert.deepEqual(r, [{ orderId: 'b1', fills: [{ price: 2420, qty: 10 }], amount: 24200, feeTotal: 34, tax: 0 }])
})
