// 收盤結算（pg_cron 台北 14:31 與 14:45）。每一步都可以重複執行而不重複入帳。
// 1. 盤後零股：用 14:30 後的零股成交價撮合
// 2. 當天沒成交的單一律 expired、退回圈存（盤後零股等到 14:40 之後的那次才過期）
// 3. 下一個交易日是除權息日 → 記下今天收盤的持股
// 4. 發放日到了、還沒發的股利 → 入帳
import { matchAfterHoursOrders, dividendPayout, payoutExplain } from '../_shared/settle.js'
import { MisQuoteSource } from '../_shared/quote.js'
import { taipeiDate, taipeiSeconds, mergeFees, SESSION_TIMES } from '../_shared/rules.js'
import { nextTradingDay, isTradingDay } from '../_shared/refdata.js'
import { fillExplain } from '../_shared/order.js'
import { json, checkCronSecret, serviceClient, makeDb, loadFees, loadHolidays, must } from '../_shared/db.ts'

const quotes = new MisQuoteSource()
const FINAL_RUN = SESSION_TIMES.ODD_AFTER_END + 10 * 60   // 14:40 之後的那次是最後一次

Deno.serve(async (req) => {
  if (!checkCronSecret(req)) return new Response('forbidden', { status: 403 })
  const sb = serviceClient()
  const db = makeDb(sb)
  const now = new Date()
  const today = taipeiDate(now)
  const secs = taipeiSeconds(now)
  const holidays = await loadHolidays(sb)
  const out: Record<string, unknown> = { today }
  const errors: string[] = []

  if (isTradingDay(today, holidays) && secs >= SESSION_TIMES.ODD_AFTER_MATCH_START) {
    // 1. 盤後零股
    const orders = must(await sb.from('orders').select('id, account_id, symbol, side, limit_price, qty, filled_qty')
      .eq('session', 'odd_after').eq('trade_date', today).in('status', ['open', 'partial']).order('created_at')) as any[]
    if (orders.length) {
      const symbols = [...new Set(orders.map((o) => o.symbol))]
      const secRows = new Map((must(await sb.from('securities').select('symbol, market, kind').in('symbol', symbols)) as any[]).map((s) => [s.symbol, s]))
      const books = await quotes.getBooks(symbols.filter((s) => secRows.has(s)).map((s) => ({ symbol: s, market: secRows.get(s).market })), 'odd')
      const closes = new Map<string, number | null>()
      for (const [sym, b] of books) {
        // 報價時間要在 14:30 之後，才是盤後零股的成交價
        if (taipeiDate(new Date(b.time)) === today && taipeiSeconds(new Date(b.time)) >= SESSION_TIMES.ODD_AFTER_MATCH_START) closes.set(sym, b.last)
      }
      const fees = await loadFees(sb, [...new Set(orders.map((o) => o.account_id))])
      const feeOf = (id: string) => fees.get(id) ?? mergeFees(null)
      const open = orders.filter((o) => secRows.has(o.symbol)).map((o) => ({
        id: o.id, accountId: o.account_id, symbol: o.symbol, side: o.side, limit: Number(o.limit_price),
        remaining: o.qty - o.filled_qty, kind: secRows.get(o.symbol).kind,
      }))
      const results = matchAfterHoursOrders(open, closes, now, feeOf)
      for (const r of results) {
        const o = open.find((x) => x.id === r.orderId)!
        try {
          await db.applyFills(r.orderId, r.fills, r.feeTotal, r.tax, fillExplain({
            fills: r.fills, session: 'odd_after', side: o.side, kind: o.kind, fees: feeOf(o.accountId),
            feeTotal: r.feeTotal, tax: r.tax, amountBefore: 0, tradeDate: today,
          }))
        } catch (e) { errors.push(`fill ${r.orderId}: ${(e as Error).message}`) }
      }
      out.afterHours = { orders: open.length, filled: results.length, pricesReady: closes.size }
    }

    // 2. 過期
    const stale = must(await sb.from('orders').select('id, session, trade_date').in('status', ['open', 'partial']).lte('trade_date', today)) as any[]
    let expired = 0
    for (const o of stale) {
      if (o.session === 'odd_after' && o.trade_date === today && secs < FINAL_RUN) continue
      try { await db.closeOrder(o.id, 'expired'); expired++ } catch (e) { errors.push(`expire ${o.id}: ${(e as Error).message}`) }
    }
    out.expired = expired

    // 3. 除權息資格
    const next = nextTradingDay(today, holidays)
    const acts = must(await sb.from('corp_actions').select('ex_date').gt('ex_date', today).lte('ex_date', next)) as any[]
    for (const d of [...new Set(acts.map((a) => a.ex_date))]) {
      out[`snapshot_${d}`] = must(await sb.rpc('snapshot_entitlements', { p_ex_date: d }))
    }
  } else if (!isTradingDay(today, holidays)) {
    // 休市日：只清掉過去沒處理到的單
    const stale = must(await sb.from('orders').select('id').in('status', ['open', 'partial']).lt('trade_date', today)) as any[]
    for (const o of stale) await db.closeOrder(o.id, 'expired')
  }

  // 4. 發放股利（每天都檢查，發放日是今天或更早且還沒發的）
  const due = must(await sb.from('entitlements').select('account_id, symbol, ex_date, shares').eq('paid', false)) as any[]
  if (due.length) {
    const acts = must(await sb.from('corp_actions').select('symbol, ex_date, cash_per_share, stock_per_share, pay_date, pay_date_estimated')
      .lte('pay_date', today).in('symbol', [...new Set(due.map((d) => d.symbol))])) as any[]
    const actOf = new Map(acts.map((a) => [`${a.symbol}|${a.ex_date}`, a]))
    const fees = await loadFees(sb, [...new Set(due.map((d) => d.account_id))])
    let paid = 0
    for (const d of due) {
      const r = actOf.get(`${d.symbol}|${d.ex_date}`)
      if (!r) continue
      const a = { symbol: r.symbol, exDate: r.ex_date, cashPerShare: Number(r.cash_per_share), stockPerShare: Number(r.stock_per_share), payDate: r.pay_date, payDateEstimated: r.pay_date_estimated }
      const f = fees.get(d.account_id) ?? mergeFees(null)
      const p = dividendPayout(d.shares, a, f)
      try {
        await sb.rpc('pay_entitlement', {
          p_account: d.account_id, p_symbol: d.symbol, p_ex_date: d.ex_date, p_cash: p.cash, p_nhi: p.nhi,
          p_shares: p.newShares, p_cash_in_lieu: p.cashInLieu, p_explain: payoutExplain(d.shares, a, f, p),
        }).then((x) => { if (x.error) throw new Error(x.error.message) })
        paid++
      } catch (e) { errors.push(`pay ${d.account_id} ${d.symbol}: ${(e as Error).message}`) }
    }
    out.dividendsPaid = paid
  }
  out.errors = errors
  return json(out, errors.length ? 207 : 200)
})
