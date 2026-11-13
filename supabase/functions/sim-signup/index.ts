// 用邀請碼註冊。Supabase 內建寄信只寄給專案成員，受邀的朋友收不到驗證信，
// 所以由管理員發的一次性邀請碼代替 email 驗證：邀請碼有效且未使用，才建立已確認的帳號。
// 前端接著用同一組帳密登入，再呼叫 redeem_invite 用掉邀請碼並開戶。
//   POST { email, password, code } → { ok: true }
import { createClient } from 'npm:@supabase/supabase-js@2.49.4'
import { CORS, json } from '../_shared/db.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const body = await req.json().catch(() => ({}))
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const code = String(body.code ?? '').trim().toUpperCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Email 格式不對' }, 400)
  if (password.length < 8) return json({ error: '密碼至少 8 個字' }, 400)

  const inv = await admin.schema('sim').from('invites').select('code, used_by').eq('code', code).maybeSingle()
  if (inv.error) return json({ error: '系統錯誤，請稍後再試' }, 500)
  if (!inv.data) return json({ error: '邀請碼不存在' }, 400)
  if (inv.data.used_by) return json({ error: '邀請碼已經被使用過了' }, 400)

  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) return json({ error: '這個 email 已經註冊過了，請直接登入（忘記密碼請找管理員）' }, 400)
  return json({ ok: true })
})
