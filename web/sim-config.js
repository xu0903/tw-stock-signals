// 模擬交易前端設定。兩個值都是公開的（權限由資料庫 RLS 控管），和 LifeMaster 的 .env 相同。
// 不要填 service_role / secret key。
export const SUPABASE_URL = 'https://cvpcgqgpwelokwqltktd.supabase.co'
export const SUPABASE_ANON_KEY = ''   // 填入 LifeMaster .env 的 VITE_SUPABASE_ANON_KEY
