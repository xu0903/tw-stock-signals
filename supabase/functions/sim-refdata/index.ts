// 每個平日台北 08:00 更新：股票清單、休市日、除權息。
import {
  SOURCES, parseTwseSecurities, parseTpexSecurities, parseTwseExRights, parseTpexExRights, parseHolidays, withPayDates,
} from '../_shared/refdata.js'
import { json, checkCronSecret, serviceClient, loadHolidays, must } from '../_shared/db.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
async function get(url: string): Promise<any[]> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  const j = await r.json()
  return Array.isArray(j) ? j : []
}
async function upsert(sb: ReturnType<typeof serviceClient>, table: string, rows: any[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) must(await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict }))
}

Deno.serve(async (req) => {
  if (!checkCronSecret(req)) return new Response('forbidden', { status: 403 })
  const sb = serviceClient()
  const out: Record<string, unknown> = {}
  const errors: string[] = []
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { out[name] = await fn() } catch (e) { errors.push(`${name}: ${(e as Error).message}`) }
  }

  await step('holidays', async () => {
    const h = parseHolidays(await get(SOURCES.holidays))
    await upsert(sb, 'holidays', [...h].map((date) => ({ date })), 'date')
    return h.size
  })
  await step('securities', async () => {
    const rows = [...parseTwseSecurities(await get(SOURCES.twseSecurities)), ...parseTpexSecurities(await get(SOURCES.tpexSecurities))]
    const now = new Date().toISOString()
    await upsert(sb, 'securities', rows.map((s) => ({ ...s, updated_at: now })), 'symbol')
    return rows.length
  })
  await step('corp_actions', async () => {
    const holidays = await loadHolidays(sb)
    const acts = withPayDates([...parseTwseExRights(await get(SOURCES.twseExRights)), ...parseTpexExRights(await get(SOURCES.tpexExRights))], holidays)
    const now = new Date().toISOString()
    await upsert(sb, 'corp_actions', acts.map((a) => ({
      symbol: a.symbol, ex_date: a.exDate, cash_per_share: a.cashPerShare, stock_per_share: a.stockPerShare,
      pay_date: a.payDate, pay_date_estimated: a.payDateEstimated, updated_at: now,
    })), 'symbol,ex_date')
    return acts.length
  })
  out.errors = errors
  return json(out, errors.length ? 207 : 200)
})
