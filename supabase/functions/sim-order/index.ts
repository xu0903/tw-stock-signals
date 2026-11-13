// 下單與報價。
//   POST /sim-order  body: OrderRequest（accountId 由登入者反查，不信任前端）→ { orderId, status, fills, message }
//   GET  /sim-order?quote=2330&session=lot|odd → Book（瀏覽器不能直接跨網域讀證交所）
import { submitOrder, OrderError } from '../_shared/order.js'
import { MisQuoteSource } from '../_shared/quote.js'
import { CORS, json, currentUser, serviceClient, makeDb, must } from '../_shared/db.ts'

const quotes = new MisQuoteSource()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const user = await currentUser(req)
  if (!user) return json({ error: '請先登入' }, 401)
  const sb = serviceClient()
  const db = makeDb(sb)

  try {
    if (req.method === 'GET') {
      const u = new URL(req.url)
      const symbol = (u.searchParams.get('quote') ?? '').trim().toUpperCase()
      const session = u.searchParams.get('session') === 'odd' ? 'odd' : 'lot'
      const sec = await db.security(symbol)
      if (!sec) return json({ error: `查無 ${symbol}` }, 404)
      const book = (await quotes.getBooks([{ symbol, market: sec.market }], session)).get(symbol)
      if (!book) return json({ error: '報價中斷' }, 503)
      return json({ ...book, name: sec.name, kind: sec.kind, market: sec.market, serverTime: new Date().toISOString() })
    }

    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const body = await req.json().catch(() => ({}))
    const acc = must(await sb.from('accounts').select('id').eq('user_id', user.id).eq('kind', 'normal').maybeSingle()) as { id: string } | null
    if (!acc) return json({ error: '你還沒有模擬帳戶，請先輸入邀請碼' }, 403)
    const r = await submitOrder({
      accountId: acc.id,
      symbol: String(body.symbol ?? ''),
      session: body.session,
      side: body.side,
      priceType: body.priceType,
      limit: body.limit == null || body.limit === '' ? null : Number(body.limit),
      qty: Number(body.qty),
    }, new Date(), db, quotes)
    return json(r)
  } catch (e) {
    if (e instanceof OrderError) return json({ error: e.message }, 400)
    console.error(e)
    return json({ error: '系統錯誤，請稍後再試' }, 500)
  }
})
