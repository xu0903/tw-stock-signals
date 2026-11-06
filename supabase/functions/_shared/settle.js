// 收盤結算的純邏輯：盤後零股撮合、除權息配發換算。

import { matchAfterHours, commission, sellTax, fillAmount, taipeiDate, LOT_SIZE } from './rules.js'

export const PAR_VALUE = 10

/**
 * 現金股利 = floor(股數 × 每股現金)；≥ 門檻扣補充保費；配股 = 股數 × 每股配股金額 ÷ 面額，不足一股折現（× 面額）
 * @param {number} shares @param {import('./refdata.js').CorpAction} a @param {import('./rules.js').FeeConfig} fees
 */
export function dividendPayout(shares, a, fees) {
  const cash = Math.floor(shares * a.cashPerShare + 1e-9)
  const nhi = cash >= fees.nhiThreshold ? Math.round(cash * fees.nhiRate) : 0
  // 用萬分之一股為單位算，避免浮點誤差
  const exact = Math.round((shares * a.stockPerShare / PAR_VALUE) * 10000)
  const newShares = Math.floor(exact / 10000)
  const cashInLieu = Math.floor(((exact % 10000) / 10000) * PAR_VALUE + 1e-9)
  return { cash, nhi, newShares, cashInLieu }
}

export function payoutExplain(shares, a, fees, p) {
  return {
    shares, cash_per_share: a.cashPerShare, stock_per_share: a.stockPerShare, par_value: PAR_VALUE,
    nhi_rate: p.nhi ? fees.nhiRate : 0, nhi_threshold: fees.nhiThreshold,
    pay_date: a.payDate, pay_date_estimated: a.payDateEstimated,
    note: a.payDateEstimated ? '開放資料沒有發放日，依除息日 + 30 天預估發放日' : undefined,
    lot_size: LOT_SIZE,
  }
}

/**
 * 盤後零股：用 14:30 的成交價一次撮合
 * @param {{id: string, accountId: string, symbol: string, side: 'buy'|'sell', limit: number, remaining: number, kind: import('./rules.js').Kind}[]} orders
 * @param {Map<string, number|null>} closes symbol → 盤後零股成交價
 * @param {Date} now
 * @param {(accountId: string) => import('./rules.js').FeeConfig} fees
 */
export function matchAfterHoursOrders(orders, closes, now, fees) {
  const date = taipeiDate(now)
  const out = []
  for (const o of orders) {
    const fills = matchAfterHours(closes.get(o.symbol) ?? null, o.side, o.limit, o.remaining)
    if (!fills.length) continue
    const amount = fillAmount(fills)
    out.push({
      orderId: o.id, fills, amount,
      feeTotal: commission(amount, 'odd_after', fees(o.accountId)),
      tax: o.side === 'sell' ? sellTax(amount, o.kind, date) : 0,
    })
  }
  return out
}
