// 撮合排程的純邏輯：把掛著的限價單對上最新五檔。

import { matchLimit, commission, sellTax, fillAmount, taipeiDate } from './rules.js'
import { isStale } from './quote.js'

/**
 * @typedef {Object} OpenOrder
 * @property {string} id @property {string} accountId @property {string} symbol
 * @property {'lot'|'odd'|'odd_after'} session @property {'buy'|'sell'} side
 * @property {number} limit 限價（市價單不會掛著）
 * @property {number} remaining 剩餘股數
 * @property {number} feeCharged 已收手續費
 * @property {number} filledAmount 已成交金額（元）
 * @property {import('./rules.js').Kind} kind
 */

export const bookKey = (session, symbol) => `${session}:${symbol}`

/**
 * orders 要依建單時間排好（先來先撮合）；同一檔同一時段的五檔量會被前面的單吃掉，不會重複給後面的單。
 * @param {OpenOrder[]} orders
 * @param {Map<string, import('./rules.js').Book>} books key 為 `${session}:${symbol}`（session 為 lot 或 odd）
 * @param {Date} now
 * @param {import('./rules.js').SessionState} state
 * @param {(accountId: string) => import('./rules.js').FeeConfig} fees
 */
export function matchOpenOrders(orders, books, now, state, fees) {
  const date = taipeiDate(now)
  const left = new Map()   // 每份五檔剩下的量
  const out = []
  for (const o of orders) {
    if (o.session === 'lot' ? !state.lot : o.session === 'odd' ? !state.oddMatch : true) continue
    const key = bookKey(o.session, o.symbol)
    const book = books.get(key)
    if (!book || isStale(book, now)) continue
    if (!left.has(key)) left.set(key, { ...book, asks: book.asks.map((l) => ({ ...l })), bids: book.bids.map((l) => ({ ...l })) })
    const b = left.get(key)
    const fills = matchLimit(b, o.side, o.limit, o.remaining)
    if (!fills.length) continue
    const levels = o.side === 'buy' ? b.asks : b.bids
    for (const f of fills) {
      const l = levels.find((x) => x.price === f.price)
      if (l) l.qty -= f.qty
    }
    const amount = fillAmount(fills)
    const cfg = fees(o.accountId)
    const feeTotal = Math.max(commission(o.filledAmount + amount, o.session, cfg), o.feeCharged)
    const tax = o.side === 'sell' ? sellTax(o.filledAmount + amount, o.kind, date) - sellTax(o.filledAmount, o.kind, date) : 0
    out.push({ orderId: o.id, fills, feeTotal, tax, amount })
  }
  return out
}
