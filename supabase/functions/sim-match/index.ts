// pg_cron 每分鐘呼叫一次（交易時段）；一次呼叫內跑 6 輪、每輪間隔 10 秒，撮合掛著的限價單。
import { matchOpenOrders, bookKey } from '../_shared/match.js'
import { MisQuoteSource } from '../_shared/quote.js'
import { sessionState, taipeiDate, fillAmount, mergeFees } from '../_shared/rules.js'
import { fillExplain } from '../_shared/order.js'
import { json, checkCronSecret, serviceClient, makeDb, loadFees, must, sleep } from '../_shared/db.ts'

const quotes = new MisQuoteSource()
const ROUNDS = 6, GAP_MS = 10_000

Deno.serve(async (req) => {
  if (!checkCronSecret(req)) return new Response('forbidden', { status: 403 })
  const sb = serviceClient()
  const db = makeDb(sb)
  const started = Date.now()
  const summary: { round: number; orders: number; filled: number; errors: string[] }[] = []

  for (let round = 0; round < ROUNDS; round++) {
    if (round) await sleep(Math.max(0, started + round * GAP_MS - Date.now()))
    const now = new Date()
    const date = taipeiDate(now)
    const state = sessionState(now, await db.isTradingDay(date))
    const sessions = [state.lot && 'lot', state.oddMatch && 'odd'].filter(Boolean) as string[]
    if (!sessions.length) { summary.push({ round, orders: 0, filled: 0, errors: [] }); break }

    const orders = must(await sb.from('orders')
      .select('id, account_id, symbol, session, side, limit_price, qty, filled_qty, fee_charged, created_at')
      .in('status', ['open', 'partial']).eq('trade_date', date).eq('price_type', 'limit').in('session', sessions)
      .order('created_at')) as any[]
    if (!orders.length) { summary.push({ round, orders: 0, filled: 0, errors: [] }); continue }

    const symbols = [...new Set(orders.map((o) => o.symbol))]
    const secs = new Map((must(await sb.from('securities').select('symbol, market, kind').in('symbol', symbols)) as any[]).map((s) => [s.symbol, s]))
    const partialIds = orders.filter((o) => o.filled_qty > 0).map((o) => o.id)
    const filledAmt = new Map<string, number>()
    if (partialIds.length) {
      const fills = must(await sb.from('fills').select('order_id, price, qty').in('order_id', partialIds)) as any[]
      const by = new Map<string, { price: number; qty: number }[]>()
      for (const f of fills) by.set(f.order_id, [...(by.get(f.order_id) ?? []), { price: Number(f.price), qty: f.qty }])
      for (const [k, v] of by) filledAmt.set(k, fillAmount(v))
    }
    const fees = await loadFees(sb, [...new Set(orders.map((o) => o.account_id))])

    const books = new Map()
    for (const s of sessions) {
      const items = [...new Set(orders.filter((o) => o.session === s).map((o) => o.symbol))]
        .filter((sym) => secs.has(sym)).map((sym) => ({ symbol: sym, market: secs.get(sym).market }))
      if (!items.length) continue
      for (const [sym, b] of await quotes.getBooks(items, s as 'lot' | 'odd')) books.set(bookKey(s, sym), b)
    }

    const open = orders.filter((o) => secs.has(o.symbol)).map((o) => ({
      id: o.id, accountId: o.account_id, symbol: o.symbol, session: o.session, side: o.side,
      limit: Number(o.limit_price), remaining: o.qty - o.filled_qty, feeCharged: Number(o.fee_charged),
      filledAmount: filledAmt.get(o.id) ?? 0, kind: secs.get(o.symbol).kind,
    }))
    const results = matchOpenOrders(open, books, now, state, (id: string) => fees.get(id) ?? mergeFees(null))
    const errors: string[] = []
    for (const r of results) {
      const o = open.find((x) => x.id === r.orderId)!
      try {
        await db.applyFills(r.orderId, r.fills, r.feeTotal, r.tax, fillExplain({
          fills: r.fills, session: o.session, side: o.side, kind: o.kind, fees: fees.get(o.accountId) ?? mergeFees(null),
          feeTotal: r.feeTotal, tax: r.tax, amountBefore: o.filledAmount, tradeDate: date,
        }))
      } catch (e) { errors.push(`${r.orderId}: ${(e as Error).message}`) }
    }
    summary.push({ round, orders: open.length, filled: results.length - errors.length, errors })
  }
  return json({ summary })
})
