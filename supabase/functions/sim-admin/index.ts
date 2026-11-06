// 管理員：入金、發邀請碼、列出帳戶。以使用者 JWT 呼叫 plpgsql，由函式自己檢查 is_admin。
//   POST { action: 'deposit', accountId, amount, note } | { action: 'invite' } | { action: 'accounts' }
import { CORS, json, userClient } from '../_shared/db.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return json({ error: '請先登入' }, 401)
  const sb = userClient(auth)
  const body = await req.json().catch(() => ({}))

  let r
  if (body.action === 'deposit') {
    const amount = Math.round(Number(body.amount))
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: '入金金額要大於 0' }, 400)
    r = await sb.rpc('admin_deposit', { p_account: body.accountId, p_amount: amount, p_note: String(body.note ?? '') })
    if (!r.error) return json({ cash: r.data })
  } else if (body.action === 'invite') {
    r = await sb.rpc('admin_create_invite')
    if (!r.error) return json({ code: r.data })
  } else if (body.action === 'accounts') {
    r = await sb.rpc('admin_list_accounts')
    if (!r.error) return json({ accounts: r.data })
  } else {
    return json({ error: '不認得的動作' }, 400)
  }
  return json({ error: r.error!.message }, 400)
})
