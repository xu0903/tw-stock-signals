// 模擬交易的規則計算：費用、稅、升降單位、數量、撮合、圈存、交易時段。
// 純函式，不碰網路與資料庫；Node 測試、Deno Edge Function、瀏覽器共用同一份。

/** @typedef {'tse' | 'otc'} Market */
/** @typedef {'stock' | 'etf' | 'bond_etf'} Kind */
/** @typedef {'lot' | 'odd' | 'odd_after'} Session */
/** @typedef {'buy' | 'sell'} Side */

/**
 * @typedef {Object} FeeConfig
 * @property {number} commissionRate 手續費率
 * @property {number} discount 手續費折扣（1 = 不打折）
 * @property {number} minFee 整股每筆最低手續費
 * @property {number} minFeeOdd 零股每筆最低手續費
 * @property {number} marginRate 融資年利率（第一階段不用）
 * @property {number} shortFeeRate 融券手續費率（第一階段不用）
 * @property {number} shortRebateRate 融券擔保品利率（第一階段不用）
 * @property {number} borrowDailyRate 當沖借券費日利率（第一階段不用）
 * @property {number} nhiRate 股利補充保費率
 * @property {number} nhiThreshold 補充保費門檻（單筆現金股利）
 */

/** @type {Readonly<FeeConfig>} */
export const DEFAULT_FEES = Object.freeze({
  commissionRate: 0.001425,
  discount: 1,
  minFee: 20,
  minFeeOdd: 20,
  marginRate: 0.07,
  shortFeeRate: 0.001,
  shortRebateRate: 0,
  borrowDailyRate: 0.035,
  nhiRate: 0.0211,
  nhiThreshold: 20000,
})

export const FEE_KEYS = Object.freeze(Object.keys(DEFAULT_FEES))

export const STOCK_TAX = 0.003
export const ETF_TAX = 0.001
export const BOND_ETF_TAX = 0.001
/** 債券 ETF 證交稅停徵到這天（含）；修法延長時改這裡 */
export const BOND_ETF_TAX_FREE_UNTIL = '2026-12-31'

export const NEW_ACCOUNT_CASH = 100000
export const LOT_SIZE = 1000

/** 交易時段（台北時間，秒數自 00:00 起算）。盤中零股首次撮合時間可能在 2026-12-07 調整，改 ODD_MATCH_START。 */
const hms = (h, m, s = 0) => h * 3600 + m * 60 + s
export const SESSION_TIMES = Object.freeze({
  LOT_START: hms(9, 0), LOT_END: hms(13, 30),
  ODD_START: hms(9, 0), ODD_MATCH_START: hms(9, 10), ODD_END: hms(13, 30),
  ODD_AFTER_START: hms(13, 40), ODD_AFTER_END: hms(14, 30),
  ODD_AFTER_MATCH_START: hms(14, 30), ODD_AFTER_MATCH_END: hms(14, 59, 59),
})

/**
 * @param {Partial<FeeConfig> | null | undefined} overrides
 * @returns {FeeConfig}
 */
export function mergeFees(overrides) {
  const out = { ...DEFAULT_FEES }
  if (overrides) {
    for (const k of FEE_KEYS) {
      const v = overrides[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
    }
  }
  return out
}

/** 換成整數「分」，避免浮點誤差 */
export const toCents = (p) => Math.round(p * 100)

/**
 * 成交金額（元，四捨五入）。先用「分」加總再取整，資料庫 round(sum(price*qty)) 結果相同。
 * @param {{price: number, qty: number}[]} fills
 */
export function fillAmount(fills) {
  let cents = 0
  for (const f of fills) cents += toCents(f.price) * f.qty
  return Math.round(cents / 100)
}

/**
 * 手續費：金額 × 費率 × 折扣，四捨五入到元，最低 minFee（零股 minFeeOdd）
 * @param {number} amount @param {Session} session @param {FeeConfig} fees
 */
export function commission(amount, session, fees) {
  if (amount <= 0) return 0
  const raw = Math.round(amount * fees.commissionRate * fees.discount + 1e-9)
  const min = session === 'lot' ? fees.minFee : fees.minFeeOdd
  return Math.max(raw, min)
}

/** @param {Kind} kind @param {string} date YYYY-MM-DD */
export function taxRate(kind, date) {
  if (kind === 'stock') return STOCK_TAX
  if (kind === 'etf') return ETF_TAX
  return date <= BOND_ETF_TAX_FREE_UNTIL ? 0 : BOND_ETF_TAX
}

/**
 * 賣出證交稅，無條件捨去到元
 * @param {number} amount @param {Kind} kind @param {string} date YYYY-MM-DD
 */
export function sellTax(amount, kind, date) {
  if (amount <= 0) return 0
  return Math.floor(amount * taxRate(kind, date) + 1e-9)
}

/** @param {number} price @param {Kind} kind */
export function tickSize(price, kind) {
  const c = toCents(price)
  if (kind !== 'stock') return c < 5000 ? 0.01 : 0.05
  if (c < 1000) return 0.01
  if (c < 5000) return 0.05
  if (c < 10000) return 0.1
  if (c < 50000) return 0.5
  if (c < 100000) return 1
  return 5
}

/** 委託價符合升降單位且在漲跌停之間 */
export function isValidPrice(price, kind, limitUp, limitDown) {
  if (!(price > 0) || !Number.isFinite(price)) return false
  const c = toCents(price)
  if (Math.abs(c - price * 100) > 1e-6) return false
  if (c > toCents(limitUp) || c < toCents(limitDown)) return false
  return c % toCents(tickSize(price, kind)) === 0
}

/** 整股 1000 的倍數；零股 1–999 股 */
export function validQty(qty, session) {
  if (!Number.isInteger(qty) || qty <= 0) return false
  return session === 'lot' ? qty % LOT_SIZE === 0 : qty <= 999
}

/** 依代號判斷種類；ETN、權證等不可交易回 null */
export function kindOf(symbol) {
  const s = String(symbol || '').trim().toUpperCase()
  if (/^00\d{2,4}[A-Z]?$/.test(s)) return s.endsWith('B') ? 'bond_etf' : 'etf'
  if (/^[1-9]\d{3}$/.test(s)) return 'stock'
  return null
}

/**
 * @typedef {{price: number, qty: number}} Level 數量一律「股」
 * @typedef {{price: number, qty: number}} Fill
 * @typedef {Object} Book
 * @property {string} symbol
 * @property {'lot'|'odd'} session
 * @property {Level[]} asks 由低到高
 * @property {Level[]} bids 由高到低
 * @property {number|null} last
 * @property {number} limitUp
 * @property {number} limitDown
 * @property {number} ref
 * @property {string} time ISO
 */

function walk(levels, qty, ok) {
  /** @type {Fill[]} */
  const out = []
  let left = qty
  for (const l of levels) {
    if (left <= 0) break
    if (!(l.qty > 0) || !ok(l.price)) continue
    const q = Math.min(left, l.qty)
    out.push({ price: l.price, qty: q })
    left -= q
  }
  return out
}

/** 市價單：逐檔吃，五檔不夠就只回傳吃得到的部分 @param {Book} book @param {Side} side @param {number} qty */
export function matchMarket(book, side, qty) {
  return walk(side === 'buy' ? book.asks : book.bids, qty, () => true)
}

/** 限價單：只吃價格不劣於限價的檔位，成交價用對手檔位價 */
export function matchLimit(book, side, limit, qty) {
  const lc = toCents(limit)
  return side === 'buy'
    ? walk(book.asks, qty, (p) => toCents(p) <= lc)
    : walk(book.bids, qty, (p) => toCents(p) >= lc)
}

/** 盤後零股：用 14:30 成交價一次撮合，全部成交或不成交 */
export function matchAfterHours(closePrice, side, limit, qty) {
  if (closePrice == null || !(closePrice > 0)) return []
  const c = toCents(closePrice), lc = toCents(limit)
  const ok = side === 'buy' ? lc >= c : lc <= c
  return ok ? [{ price: closePrice, qty }] : []
}

/** 買單圈存 = 價格 × 股數 + 手續費（市價單用漲停價） */
export function buyReserve(price, qty, session, fees) {
  const amount = fillAmount([{ price, qty }])
  return amount + commission(amount, session, fees)
}

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000

/** @param {Date} now @returns {string} 台北日期 YYYY-MM-DD */
export function taipeiDate(now) {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}

/** 台北時間的秒數（自當天 00:00） */
export function taipeiSeconds(now) {
  const t = new Date(now.getTime() + TAIPEI_OFFSET_MS)
  return t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds()
}

/**
 * @typedef {{lot: boolean, odd: boolean, oddMatch: boolean, oddAfter: boolean, oddAfterMatch: boolean}} SessionState
 * @param {Date} now @param {boolean} isTradingDay
 * @returns {SessionState}
 */
export function sessionState(now, isTradingDay) {
  if (!isTradingDay) return { lot: false, odd: false, oddMatch: false, oddAfter: false, oddAfterMatch: false }
  const s = taipeiSeconds(now), T = SESSION_TIMES
  const inr = (a, b) => s >= a && s <= b
  return {
    lot: inr(T.LOT_START, T.LOT_END),
    odd: inr(T.ODD_START, T.ODD_END),
    oddMatch: inr(T.ODD_MATCH_START, T.ODD_END),
    oddAfter: inr(T.ODD_AFTER_START, T.ODD_AFTER_END),
    oddAfterMatch: inr(T.ODD_AFTER_MATCH_START, T.ODD_AFTER_MATCH_END),
  }
}

/** 加 n 個日曆天（YYYY-MM-DD） */
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export const SESSION_LABEL = Object.freeze({ lot: '整股', odd: '盤中零股', odd_after: '盤後零股' })
