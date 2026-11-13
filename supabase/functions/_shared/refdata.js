// 參考資料解析：股票清單、除權息、休市日（證交所與櫃買中心 OpenAPI）。
// 這些 API 的欄位名稱偶爾會調整；欄位對不上時先看 fixtures/ 的真實回應再改 pick() 的候選名稱。

import { kindOf, addDays } from './rules.js'

/** @typedef {import('./rules.js').Market} Market */
/** @typedef {import('./rules.js').Kind} Kind */

export const SOURCES = Object.freeze({
  twseSecurities: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  tpexSecurities: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
  twseExRights: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL',
  tpexExRights: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost',
  holidays: 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule',
})

/** 民國日期 → ISO：'1151021' 或 '115/10/21' → '2026-10-21' */
export function rocToIso(roc) {
  const s = String(roc || '').trim()
  let m = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/)
  if (!m) m = s.match(/^(\d{3})(\d{2})(\d{2})$/)
  if (!m) throw new Error(`看不懂的民國日期：${roc}`)
  const y = Number(m[1]) + 1911
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

/** 從多個候選欄位名稱取值 */
function pick(row, names) {
  for (const n of names) if (row[n] != null && row[n] !== '') return String(row[n]).trim()
  return ''
}
const toNum = (s) => {
  const n = Number(String(s || '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * @typedef {{ symbol: string, name: string, market: Market, kind: Kind }} Security
 */
function parseSecurities(rows, market, codeKeys, nameKeys) {
  /** @type {Security[]} */
  const out = []
  const seen = new Set()
  for (const r of rows || []) {
    const symbol = pick(r, codeKeys).toUpperCase(), name = pick(r, nameKeys)
    const kind = kindOf(symbol)
    if (!kind || !name || seen.has(symbol)) continue
    seen.add(symbol)
    out.push({ symbol, name, market, kind })
  }
  return out
}
export const parseTwseSecurities = (rows) => parseSecurities(rows, 'tse', ['Code'], ['Name'])
export const parseTpexSecurities = (rows) => parseSecurities(rows, 'otc', ['SecuritiesCompanyCode', 'Code'], ['CompanyName', 'Name'])

/**
 * stockPerShare 是「每股配股金額（元）」；配發股數 = 持股 × stockPerShare ÷ 面額 10。
 * 開放資料沒有發放日，payDate 先填空，由 withPayDates 用 estimatePayDate 補上。
 * @typedef {{ symbol: string, exDate: string, cashPerShare: number, stockPerShare: number, payDate: string, payDateEstimated: boolean }} CorpAction
 */
function parseExRights(rows, keys) {
  /** @type {CorpAction[]} */
  const out = []
  for (const r of rows || []) {
    const symbol = pick(r, keys.code).toUpperCase()
    if (!kindOf(symbol)) continue
    let exDate
    try { exDate = rocToIso(pick(r, keys.date)) } catch { continue }
    const cashPerShare = toNum(pick(r, keys.cash))
    // 無償配股率是「每股配幾股」，換成每股配股金額 = 配股率 × 10 元
    const stockPerShare = Math.round(toNum(pick(r, keys.stock)) * 10 * 1e6) / 1e6
    if (cashPerShare <= 0 && stockPerShare <= 0) continue
    out.push({ symbol, exDate, cashPerShare, stockPerShare, payDate: '', payDateEstimated: true })
  }
  return out
}
export const parseTwseExRights = (rows) => parseExRights(rows, {
  code: ['Code'], date: ['Date'], cash: ['CashDividend'], stock: ['StockDividendRatio'],
})
export const parseTpexExRights = (rows) => parseExRights(rows, {
  code: ['SecuritiesCompanyCode', 'Code'],
  date: ['ExRightsExDividendDate', 'ExRrightsExDividendDate', 'ExDividendDate', 'Date'],
  cash: ['CashDividend', 'CashDividendPerShare'],
  stock: ['StockDividendRatio', 'StockDividend'],
})

/** 休市日：名稱含「開始交易」「最後交易」的是交易日，其他列出的日子都休市 */
export function parseHolidays(rows) {
  const out = new Set()
  for (const r of rows || []) {
    const name = pick(r, ['Name']) + pick(r, ['Description'])
    if (/開始交易|最後交易/.test(pick(r, ['Name']))) continue
    if (!name) continue
    try { out.add(rocToIso(pick(r, ['Date']))) } catch { /* 跳過 */ }
  }
  return out
}

/** @param {string} date YYYY-MM-DD @param {Set<string>} holidays */
export function isTradingDay(date, holidays) {
  const wd = new Date(date + 'T00:00:00Z').getUTCDay()
  return wd !== 0 && wd !== 6 && !holidays.has(date)
}

/** 下一個交易日（不含當天） */
export function nextTradingDay(date, holidays) {
  let d = addDays(date, 1)
  for (let i = 0; i < 30 && !isTradingDay(d, holidays); i++) d = addDays(d, 1)
  return d
}

/** 預估股利發放日：除息日 + 30 個日曆天，遇非交易日順延 */
export function estimatePayDate(exDate, holidays) {
  let d = addDays(exDate, 30)
  for (let i = 0; i < 30 && !isTradingDay(d, holidays); i++) d = addDays(d, 1)
  return d
}

/** @param {CorpAction[]} actions @param {Set<string>} holidays */
export function withPayDates(actions, holidays) {
  return actions.map((a) => a.payDate ? a : { ...a, payDate: estimatePayDate(a.exDate, holidays), payDateEstimated: true })
}
