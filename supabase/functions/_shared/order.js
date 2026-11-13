// 下單流程（純流程，不碰網路）：檢查規則 → 圈存建單 → 能立刻成交就成交。
// Db 與 QuoteSource 由呼叫端注入，測試用假物件。

import {
  sessionState, taipeiDate, validQty, isValidPrice, buyReserve, matchMarket, matchLimit,
  commission, sellTax, fillAmount, SESSION_LABEL, addDays,
} from './rules.js'
import { isStale } from './quote.js'

/** @typedef {import('./rules.js').Session} Session */
/** @typedef {import('./rules.js').Side} Side */
/** @typedef {import('./rules.js').Fill} Fill */
/** @typedef {import('./rules.js').FeeConfig} FeeConfig */
/** @typedef {import('./refdata.js').Security} Security */
/** @typedef {import('./quote.js').QuoteSource} QuoteSource */

/**
 * @typedef {Object} OrderRequest
 * @property {string} accountId
 * @property {string} symbol
 * @property {Session} session
 * @property {Side} side
 * @property {'market'|'limit'} priceType
 * @property {number|null} limit
 * @property {number} qty
 */

/**
 * @typedef {Object} PlaceArgs
 * @property {string} accountId @property {string} symbol @property {Session} session @property {Side} side
 * @property {'market'|'limit'} priceType @property {number|null} limit @property {number} qty
 * @property {number} reserve @property {string} tradeDate
 *
 * @typedef {Object} Db
 * @property {(symbol: string) => Promise<Security|null>} security
 * @property {(date: string) => Promise<boolean>} isTradingDay
 * @property {(accountId: string) => Promise<FeeConfig>} feeConfig
 * @property {(a: PlaceArgs) => Promise<string>} placeOrder 失敗時丟出帶中文原因的 Error
 * @property {(orderId: string, fills: Fill[], feeTotal: number, tax: number, explain: object) => Promise<void>} applyFills
 * @property {(orderId: string, status: 'cancelled'|'expired') => Promise<void>} closeOrder
 */

/** 使用者看得懂的錯誤；HTTP 回 400 */
export class OrderError extends Error {}

/** 交割日：成交日後第 2 個交易日（只看週末，休市日由呼叫端提供時再算） */
export function settleDate(tradeDate, holidays = new Set()) {
  let d = tradeDate, n = 0
  while (n < 2) {
    d = addDays(d, 1)
    const wd = new Date(d + 'T00:00:00Z').getUTCDay()
    if (wd !== 0 && wd !== 6 && !holidays.has(d)) n++
  }
  return d
}

/** 成交後要記在對帳單 explain 的算式 */
export function fillExplain({ fills, session, side, kind, fees, feeTotal, tax, amountBefore, tradeDate }) {
  const amount = fillAmount(fills)
  const cum = amountBefore + amount
  return {
    formula: side === 'buy' ? '成交金額 + 手續費' : '成交金額 − 手續費 − 證交稅',
    commission: { rate: fees.commissionRate, discount: fees.discount, min: session === 'lot' ? fees.minFee : fees.minFeeOdd, cumulative_amount: cum, total: feeTotal },
    tax: side === 'sell' ? { kind, amount: tax } : undefined,
    trade_date: tradeDate,
    settle_date: settleDate(tradeDate),
  }
}

/**
 * @param {OrderRequest} req @param {Date} now @param {Db} db @param {QuoteSource} quotes
 * @returns {Promise<{orderId: string, status: string, fills: Fill[], message: string}>}
 */
export async function submitOrder(req, now, db, quotes) {
  const { accountId, side, priceType, qty } = req
  const session = req.session
  const symbol = String(req.symbol || '').trim().toUpperCase()
  if (!['lot', 'odd', 'odd_after'].includes(session)) throw new OrderError('交易時段錯誤')
  if (!['buy', 'sell'].includes(side)) throw new OrderError('買賣別錯誤')
  if (!['market', 'limit'].includes(priceType)) throw new OrderError('價格類別錯誤')

  const sec = await db.security(symbol)
  if (!sec) throw new OrderError(`查無 ${symbol}，或這檔不能模擬交易（只支援上市櫃股票與 ETF）`)

  const date = taipeiDate(now)
  const tradingDay = await db.isTradingDay(date)
  if (!tradingDay) throw new OrderError('今天休市，不接受委託')
  const st = sessionState(now, true)
  const open = session === 'lot' ? st.lot : session === 'odd' ? st.odd : st.oddAfter
  if (!open) {
    const hours = { lot: '09:00–13:30', odd: '09:00–13:30', odd_after: '13:40–14:30' }[session]
    throw new OrderError(`${SESSION_LABEL[session]}委託時間是 ${hours}，現在不能下單`)
  }
  if (session === 'odd_after' && priceType !== 'limit') throw new OrderError('盤後零股只接受限價單')
  if (session === 'odd' && priceType === 'market' && !st.oddMatch) throw new OrderError('盤中零股 09:10 才開始撮合，這之前請用限價單')
  if (!validQty(qty, session)) {
    throw new OrderError(session === 'lot' ? '整股數量要是 1,000 股（一張）的倍數' : '零股數量是 1–999 股')
  }

  const books = await quotes.getBooks([{ symbol, market: sec.market }], session === 'lot' ? 'lot' : 'odd')
  const book = books.get(symbol)
  if (!book || !(book.limitUp > 0)) throw new OrderError('報價中斷，暫時不能下單')
  // 盤後零股時段沒有即時五檔，只需要當天的漲跌停價
  if (session !== 'odd_after' && isStale(book, now)) throw new OrderError('報價中斷（超過 30 秒沒有更新），暫時不能下單')

  let limit = null
  if (priceType === 'limit') {
    limit = Number(req.limit)
    if (!isValidPrice(limit, sec.kind, book.limitUp, book.limitDown)) {
      throw new OrderError(`委託價 ${req.limit} 不符合升降單位，或超出漲跌停（${book.limitDown}–${book.limitUp}）`)
    }
  }

  const fees = await db.feeConfig(accountId)
  const reserve = side === 'buy' ? buyReserve(priceType === 'market' ? book.limitUp : limit, qty, session, fees) : 0
  let orderId
  try {
    orderId = await db.placeOrder({ accountId, symbol, session, side, priceType, limit, qty, reserve, tradeDate: date })
  } catch (e) {
    throw new OrderError(e instanceof Error ? e.message : String(e))
  }

  const canMatch = session === 'lot' || (session === 'odd' && st.oddMatch)
  /** @type {Fill[]} */
  let fills = []
  if (canMatch) fills = priceType === 'market' ? matchMarket(book, side, qty) : matchLimit(book, side, limit, qty)
  const filled = fills.reduce((s, f) => s + f.qty, 0)
  if (filled > 0) {
    const amount = fillAmount(fills)
    const feeTotal = commission(amount, session, fees)
    const tax = side === 'sell' ? sellTax(amount, sec.kind, date) : 0
    await db.applyFills(orderId, fills, feeTotal, tax,
      fillExplain({ fills, session, side, kind: sec.kind, fees, feeTotal, tax, amountBefore: 0, tradeDate: date }))
  }

  let status, message
  if (filled === qty) { status = 'filled'; message = `全部成交 ${qty} 股` }
  else if (priceType === 'market') {
    await db.closeOrder(orderId, 'cancelled')
    status = 'cancelled'
    message = filled ? `成交 ${filled} 股，五檔不夠的 ${qty - filled} 股已取消` : '五檔沒有對手單（可能漲跌停），市價單已取消'
  } else if (filled > 0) { status = 'partial'; message = `成交 ${filled} 股，剩下 ${qty - filled} 股掛單中` }
  else {
    status = 'open'
    message = session === 'odd_after' ? '已委託，14:30 用盤後零股成交價撮合' : canMatch ? '已掛單，價格碰到時成交' : '已掛單，09:10 開始撮合'
  }
  return { orderId, status, fills, message }
}
