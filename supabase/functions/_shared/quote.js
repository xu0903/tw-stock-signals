// 報價模組：證交所 mis 即時五檔（整股 getStockInfo、零股 getOddInfo），以及測試用的假報價。
// mis 不是官方文件化的 API，欄位或網址改了只要改這個檔案。

/** @typedef {import('./rules.js').Book} Book */
/** @typedef {import('./rules.js').Market} Market */

const MIS = 'https://mis.twse.com.tw/stock/api/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const BATCH = 50

const num = (s) => {
  if (s == null || s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}
const split = (s) => (typeof s === 'string' && s !== '-' ? s.split('_').filter((x) => x !== '') : [])

function levels(prices, qtys, mult) {
  const p = split(prices), q = split(qtys), out = []
  for (let i = 0; i < p.length; i++) {
    const price = num(p[i]), qty = num(q[i])
    if (price == null || qty == null) continue   // 漲跌停時常見 "-" 或 0
    out.push({ price, qty: Math.round(qty * mult) })
  }
  return out
}

/**
 * 解析 mis 回應。整股五檔量單位是「張」→ ×1000；零股是「股」。
 * @param {any} json @param {'lot'|'odd'} session
 * @returns {Map<string, Book>}
 */
export function parseMis(json, session) {
  const out = new Map()
  const mult = session === 'lot' ? 1000 : 1
  for (const m of (json && json.msgArray) || []) {
    if (!m || !m.c) continue
    const ms = Number(m.tlong)
    out.set(m.c, {
      symbol: m.c,
      session,
      asks: levels(m.a, m.f, mult).sort((x, y) => x.price - y.price),
      bids: levels(m.b, m.g, mult).sort((x, y) => y.price - x.price),
      last: num(m.z),
      limitUp: num(m.u) ?? 0,
      limitDown: num(m.w) ?? 0,
      ref: num(m.y) ?? 0,
      time: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString(),
    })
  }
  return out
}

/** 報價時間超過 maxAgeSec 秒就視為中斷 */
export function isStale(book, now, maxAgeSec = 30) {
  const t = Date.parse(book.time)
  return !Number.isFinite(t) || now.getTime() - t > maxAgeSec * 1000
}

/**
 * @typedef {{ symbol: string, market: Market }} QuoteItem
 * @typedef {{ getBooks(items: QuoteItem[], session: 'lot'|'odd'): Promise<Map<string, Book>> }} QuoteSource
 */

/** @implements {QuoteSource} */
export class MisQuoteSource {
  /** @param {typeof fetch} [fetchFn] */
  constructor(fetchFn) { this.fetch = fetchFn || globalThis.fetch.bind(globalThis) }

  async getBooks(items, session) {
    const out = new Map()
    const page = session === 'lot' ? 'getStockInfo.jsp' : 'getOddInfo.jsp'
    for (let i = 0; i < items.length; i += BATCH) {
      const ch = items.slice(i, i + BATCH).map((x) => `${x.market}_${x.symbol}.tw`).join('|')
      const url = `${MIS}${page}?ex_ch=${encodeURIComponent(ch)}&json=1&delay=0&_=${Date.now()}`
      try {
        const r = await this.fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://mis.twse.com.tw/stock/index.jsp' } })
        if (!r.ok) continue
        for (const [k, v] of parseMis(await r.json(), session)) out.set(k, v)
      } catch { /* 抓不到就當作沒有報價，呼叫端會顯示「報價中斷」 */ }
    }
    return out
  }
}

/** 測試用：建構子吃 Map<symbol, Book>（或 Map<`${session}:${symbol}`, Book>） @implements {QuoteSource} */
export class FakeQuoteSource {
  /** @param {Map<string, Book>} books */
  constructor(books) { this.books = books; this.calls = [] }

  async getBooks(items, session) {
    this.calls.push({ items, session })
    const out = new Map()
    for (const { symbol } of items) {
      const b = this.books.get(`${session}:${symbol}`) || this.books.get(symbol)
      if (b && b.session === session) out.set(symbol, structuredClone(b))
    }
    return out
  }
}
