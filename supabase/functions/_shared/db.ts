// Edge Function 共用：Supabase 連線、Db 介面實作、HTTP 小工具。
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4'
import { mergeFees } from './rules.js'
import { isTradingDay as isTradingDayIn } from './refdata.js'
import type { Db } from './order.js'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

export type Sb = SupabaseClient<any, 'sim', any>

export function serviceClient(): Sb {
  return createClient(URL_, SERVICE_KEY, { db: { schema: 'sim' }, auth: { persistSession: false } }) as Sb
}

/** 以使用者的 JWT 呼叫：讓 plpgsql 函式用 auth.uid() 自己檢查權限 */
export function userClient(authHeader: string): Sb {
  return createClient(URL_, ANON_KEY, {
    db: { schema: 'sim' },
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  }) as Sb
}

export async function currentUser(req: Request) {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  const { data, error } = await userClient(auth).auth.getUser(auth.slice(7))
  if (error || !data.user || data.user.is_anonymous) return null
  return data.user
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } })

export function checkCronSecret(req: Request) {
  const s = Deno.env.get('CRON_SECRET')
  return !!s && req.headers.get('x-cron-secret') === s
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

export async function loadHolidays(sb: Sb): Promise<Set<string>> {
  const rows = must(await sb.from('holidays').select('date')) as { date: string }[]
  return new Set(rows.map((r) => r.date))
}

export async function loadFees(sb: Sb, accountIds: string[]) {
  const map = new Map<string, ReturnType<typeof mergeFees>>()
  if (!accountIds.length) return map
  const rows = must(await sb.from('accounts').select('id, fee_overrides').in('id', accountIds)) as { id: string; fee_overrides: any }[]
  for (const r of rows) map.set(r.id, mergeFees(r.fee_overrides))
  return map
}

export function makeDb(sb: Sb): Db {
  let holidays: Set<string> | null = null
  return {
    async security(symbol) {
      return must(await sb.from('securities').select('symbol, name, market, kind').eq('symbol', symbol).maybeSingle()) as any
    },
    async isTradingDay(date) {
      holidays ??= await loadHolidays(sb)
      return isTradingDayIn(date, holidays)
    },
    async feeConfig(accountId) {
      return (await loadFees(sb, [accountId])).get(accountId) ?? mergeFees(null)
    },
    async placeOrder(a) {
      return must(await sb.rpc('place_order', {
        p_account: a.accountId, p_symbol: a.symbol, p_session: a.session, p_side: a.side, p_price_type: a.priceType,
        p_limit: a.limit, p_qty: a.qty, p_reserve: a.reserve, p_trade_date: a.tradeDate,
      })) as string
    },
    async applyFills(orderId, fills, feeTotal, tax, explain) {
      must(await sb.rpc('apply_fills', { p_order: orderId, p_fills: fills, p_fee_total: feeTotal, p_tax: tax, p_explain: explain }))
    },
    async closeOrder(orderId, status) {
      must(await sb.rpc('close_order', { p_order: orderId, p_status: status }))
    },
  }
}

export { must }
