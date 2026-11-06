// 模擬交易前端。資料只讀自己的（RLS）；下單、取消、入金都走後端函式。
// 網址加 ?demo 會用假資料，不連 Supabase（截圖與離線開發用）。
import {
  DEFAULT_FEES, FEE_KEYS, mergeFees, commission, sellTax, buyReserve, fillAmount, validQty, isValidPrice,
  tickSize, kindOf, SESSION_LABEL, taipeiDate,
} from './rules.js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './sim-config.js'

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const money = (x) => x == null ? '—' : Math.round(x).toLocaleString('zh-TW')
const price = (x) => x == null ? '—' : Number(x).toLocaleString('zh-TW', { maximumFractionDigits: 2, minimumFractionDigits: x < 1000 ? 2 : 0 })
const signed = (x) => x == null ? '—' : (x > 0 ? '+' : '') + money(x)
const cls = (x) => x > 0 ? 'up' : x < 0 ? 'down' : ''
const pctTxt = (x) => x == null || !isFinite(x) ? '' : ` (${x > 0 ? '+' : ''}${(x * 100).toFixed(2)}%)`
const DEMO = new URLSearchParams(location.search).has('demo')

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show')
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200)
}

// ---------------- 資料層 ----------------

async function realApi() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm')
  // 用自己的 storageKey：不要蓋掉 LifeMaster 在同一個網域的匿名登入
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: 'sim' }, auth: { storageKey: 'tw-sim-auth', persistSession: true } })
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data }
  const fn = async (path, init = {}) => {
    const { data: { session } } = await sb.auth.getSession()
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
      ...init,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
    return j
  }
  return {
    async user() { const { data } = await sb.auth.getUser(); return data.user && !data.user.is_anonymous ? data.user : null },
    async signIn(email, password) { must(await sb.auth.signInWithPassword({ email, password })) },
    async signUp(email, password) {
      const d = must(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } }))
      return !d.session
    },
    async signOut() { await sb.auth.signOut() },
    async member(uid) { return must(await sb.from('members').select('display_name, is_admin').eq('user_id', uid).maybeSingle()) },
    async account(uid) { return must(await sb.from('accounts').select('*').eq('user_id', uid).eq('kind', 'normal').maybeSingle()) },
    async redeem(code, name) { return must(await sb.rpc('redeem_invite', { p_code: code, p_name: name })) },
    async positions(acc) { return must(await sb.from('positions').select('*').eq('account_id', acc).order('symbol')) },
    async orders(acc) { return must(await sb.from('orders').select('*').eq('account_id', acc).order('created_at', { ascending: false }).limit(60)) },
    async ledger(acc) { return must(await sb.from('ledger').select('*').eq('account_id', acc).order('id', { ascending: false }).limit(150)) },
    async securities(symbols) { return symbols.length ? must(await sb.from('securities').select('*').in('symbol', symbols)) : [] },
    async search(q) {
      const s = q.replace(/[%,()]/g, '')
      return must(await sb.from('securities').select('*').or(`symbol.ilike.${s}%,name.ilike.%${s}%`).order('symbol').limit(20))
    },
    quote(symbol, session) { return fn(`sim-order?quote=${encodeURIComponent(symbol)}&session=${session}`) },
    order(body) { return fn('sim-order', { method: 'POST', body: JSON.stringify(body) }) },
    async cancel(id) { return must(await sb.rpc('cancel_my_order', { p_order: id })) },
    async setFees(acc, o) { must(await sb.rpc('set_fee_overrides', { p_account: acc, p_overrides: o })) },
    admin(body) { return fn('sim-admin', { method: 'POST', body: JSON.stringify(body) }) },
  }
}

function demoApi() {
  const now = new Date().toISOString()
  const secs = [
    { symbol: '2330', name: '台積電', market: 'tse', kind: 'stock' }, { symbol: '0050', name: '元大台灣50', market: 'tse', kind: 'etf' },
    { symbol: '2317', name: '鴻海', market: 'tse', kind: 'stock' }, { symbol: '6488', name: '環球晶', market: 'otc', kind: 'stock' },
  ]
  const acc = { id: 'demo', cash: 79563, reserved: 2440, fee_overrides: null, kind: 'normal' }
  const positions = [{ symbol: '2330', qty: 8, cost: 19380 }, { symbol: '0050', qty: 50, cost: 9870 }]
  const orders = [
    { id: 'o3', symbol: '2317', session: 'odd', side: 'buy', price_type: 'limit', limit_price: 220, qty: 11, filled_qty: 0, status: 'open', fee_charged: 0, created_at: now },
    { id: 'o2', symbol: '0050', session: 'odd', side: 'buy', price_type: 'market', limit_price: null, qty: 50, filled_qty: 50, avg_price: 197, status: 'filled', fee_charged: 20, created_at: now },
    { id: 'o1', symbol: '2330', session: 'odd', side: 'buy', price_type: 'market', limit_price: null, qty: 8, filled_qty: 8, avg_price: 2420, status: 'filled', fee_charged: 20, created_at: now },
  ]
  const ledger = [
    { id: 6, at: now, amount: -20, cash_after: 79563, code: 'FEE', ref: 'o2', explain: { formula: '成交金額 + 手續費', commission: { rate: 0.001425, discount: 1, min: 20, cumulative_amount: 9850, total: 20 }, settle_date: '2026-11-10' } },
    { id: 5, at: now, amount: -9850, cash_after: 79583, code: 'BUY', ref: 'o2', explain: { symbol: '0050', qty: 50, fills: [{ price: 197, qty: 50 }], amount: 9850 } },
    { id: 4, at: now, amount: -20, cash_after: 89433, code: 'FEE', ref: 'o1', explain: { commission: { total: 20 } } },
    { id: 3, at: now, amount: -19360, cash_after: 89453, code: 'BUY', ref: 'o1', explain: { symbol: '2330', qty: 8, fills: [{ price: 2420, qty: 8 }], amount: 19360 } },
    { id: 2, at: now, amount: 8813, cash_after: 108813, code: 'ADMIN_DEPOSIT', ref: null, explain: { note: '比賽獎金' } },
    { id: 1, at: now, amount: 100000, cash_after: 100000, code: 'OPEN_GRANT', ref: 'DEMO1234', explain: { note: '開戶贈送' } },
  ]
  const book = (symbol, session) => {
    const ref = { 2330: 2405, '0050': 196.5, 2317: 221.5, 6488: 1320 }[symbol] ?? 100
    const last = { 2330: 2440, '0050': 198.3, 2317: 219, 6488: 1452 }[symbol] ?? ref
    const k = kindOf(symbol), t = tickSize(last, k), m = session === 'lot' ? 1000 : 1
    const lv = (d) => Array.from({ length: 5 }, (_, i) => ({ price: Math.round((last + d * (i + (d > 0 ? 1 : 0)) * t) * 100) / 100, qty: (37 * (i + 3) % 41 + 3) * (session === 'lot' ? m : 10) }))
    return { symbol, session, asks: lv(1), bids: lv(-1), last, ref, limitUp: Math.round(ref * 1.1), limitDown: Math.round(ref * 0.9), time: new Date().toISOString(), name: secs.find((s) => s.symbol === symbol)?.name }
  }
  return {
    async user() { return { id: 'u', email: 'demo@example.com' } },
    async signIn() {}, async signUp() { return false }, async signOut() {},
    async member() { return { display_name: '示範', is_admin: true } },
    async account() { return acc },
    async redeem() { return 'demo' },
    async positions() { return positions }, async orders() { return orders }, async ledger() { return ledger },
    async securities(s) { return secs.filter((x) => s.includes(x.symbol)) },
    async search(q) { return secs.filter((x) => x.symbol.startsWith(q) || x.name.includes(q)) },
    async quote(s, session) { return book(s, session) },
    async order() { return { status: 'filled', message: '全部成交 1 股（示範）', fills: [] } },
    async cancel() { return true }, async setFees() {},
    async admin(b) {
      if (b.action === 'accounts') return { accounts: [{ account_id: 'demo', display_name: '示範', email: 'demo@example.com', kind: 'normal', cash: 79563, reserved: 2440 }, { account_id: 'f1', display_name: '朋友 A', email: 'a@example.com', kind: 'normal', cash: 100000, reserved: 0 }] }
      if (b.action === 'invite') return { code: 'K7QW2M9X' }
      return { cash: 0 }
    },
  }
}

// ---------------- 狀態 ----------------

let api, U = null, M = null, A = null
let timer = null
const stop = () => { if (timer) { clearInterval(timer); timer = null } }
const qcache = new Map()
async function quote(symbol, session = 'lot') {
  const k = session + symbol, c = qcache.get(k)
  if (c && Date.now() - c.t < 4000) return c.b
  const b = await api.quote(symbol, session); qcache.set(k, { t: Date.now(), b }); return b
}
const markPrice = (b) => b ? (b.last ?? b.ref) : null

const CODE_LABEL = {
  OPEN_GRANT: '開戶贈送', ADMIN_DEPOSIT: '管理員入金', BUY: '買進', SELL: '賣出', FEE: '手續費', TAX: '證交稅',
  DIVIDEND: '現金股利', NHI_PREMIUM: '補充保費', STOCK_DIVIDEND: '股票股利', STOCK_DIVIDEND_CASH_IN_LIEU: '配股零股折現',
}
const STATUS = { open: ['掛單中', 'ok'], partial: ['部分成交', 'warn'], filled: ['全部成交', ''], cancelled: ['已取消', ''], expired: ['已過期', ''], rejected: ['已拒絕', 'warn'] }

// ---------------- 畫面 ----------------

function setTabs(r) {
  $('#tabs').hidden = !A
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.r === r))
}

function viewSetup() {
  $('#main').innerHTML = `<div class="card"><h3>還沒設定</h3><div>請在 <code>web/sim-config.js</code> 填入 Supabase anon key，部署步驟見 <code>supabase/README.md</code>。</div>
    <a class="btn block" href="?demo#home">看示範畫面</a></div>`
}

function viewLogin() {
  $('#main').innerHTML = `<div class="card"><h3>登入模擬交易</h3>
    <div class="sub">用假錢照真實台股規則練習：即時五檔、手續費與稅、除權息。只開放受邀的朋友。</div>
    <label for="em">Email</label><input id="em" type="email" autocomplete="email">
    <label for="pw">密碼</label><input id="pw" type="password" autocomplete="current-password">
    <button class="btn block" id="in">登入</button>
    <button class="btn block ghost" id="up">註冊新帳號</button></div>`
  const go = (fn) => async () => {
    try { const needConfirm = await fn($('#em').value.trim(), $('#pw').value); if (needConfirm) toast('請到信箱點確認連結，再回來登入'); else route() }
    catch (e) { toast(e.message) }
  }
  $('#in').onclick = go((e, p) => api.signIn(e, p))
  $('#up').onclick = go((e, p) => api.signUp(e, p))
}

function viewInvite() {
  $('#main').innerHTML = `<div class="card"><h3>輸入邀請碼開戶</h3>
    <div class="sub">開戶會拿到 100,000 元模擬資金。邀請碼向管理員索取。</div>
    <label for="code">邀請碼</label><input id="code" autocapitalize="characters" maxlength="8">
    <label for="nm">暱稱</label><input id="nm" maxlength="30" placeholder="管理員看得到">
    <button class="btn block" id="go">開戶</button>
    <button class="btn block ghost" id="out">登出（${esc(U.email)}）</button></div>`
  $('#go').onclick = async () => { try { await api.redeem($('#code').value, $('#nm').value); toast('開戶完成'); await loadMe(); location.hash = '#home'; route() } catch (e) { toast(e.message) } }
  $('#out').onclick = async () => { await api.signOut(); U = null; route() }
}

async function holdingsWithQuotes() {
  const pos = (await api.positions(A.id)).filter((p) => p.qty > 0)
  const secs = new Map((await api.securities(pos.map((p) => p.symbol))).map((s) => [s.symbol, s]))
  const quotes = await Promise.all(pos.map((p) => quote(p.symbol, 'lot').catch(() => null)))
  return pos.map((p, i) => {
    const px = markPrice(quotes[i]), mv = px == null ? null : Math.round(px * p.qty)
    const sec = secs.get(p.symbol) || { name: p.symbol, kind: kindOf(p.symbol) || 'stock' }
    // 未實現損益 = 市值 − 成本 − 預估賣出手續費與稅（悲觀）
    const exitCost = mv == null ? 0 : commission(mv, p.qty >= 1000 ? 'lot' : 'odd', mergeFees(A.fee_overrides)) + sellTax(mv, sec.kind, taipeiDate(new Date()))
    return { ...p, sec, px, mv, chg: quotes[i] && px != null ? px - quotes[i].ref : null, ref: quotes[i]?.ref, pnl: mv == null ? null : mv - p.cost - exitCost }
  })
}

async function viewHome() {
  const rows = await holdingsWithQuotes()
  const mv = rows.reduce((s, r) => s + (r.mv ?? 0), 0)
  const pnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0)
  const missing = rows.some((r) => r.mv == null)
  $('#main').innerHTML = `<div class="card">
      <div class="sub">總資產</div><div class="big num">${money(A.cash + mv)}</div>
      <dl class="kv" style="margin-top:8px">
        <dt>現金</dt><dd class="num">${money(A.cash)}</dd>
        <dt>圈存（掛單中）</dt><dd class="num">${money(A.reserved)}</dd>
        <dt>可用現金</dt><dd class="num">${money(A.cash - A.reserved)}</dd>
        <dt>持股市值</dt><dd class="num">${money(mv)}</dd>
        <dt>未實現損益</dt><dd class="num ${cls(pnl)}">${signed(pnl)}</dd>
      </dl>
      ${missing ? '<div class="warnbox">部分股票報價中斷，市值沒算進去。</div>' : ''}
      <div class="sub" style="margin-top:8px">未實現損益已扣掉現在賣出的預估手續費與證交稅。</div></div>
    ${rows.length ? `<div class="list">${rows.map(holdingRow).join('')}</div>` : '<div class="empty">還沒有持股。<br><a href="#order">去下單</a></div>'}`
}
const holdingRow = (r) => `<a class="item row" href="#order/${r.symbol}" style="color:inherit">
  <div><div><span class="nm">${esc(r.sec.name)}</span><span class="code">${r.symbol}</span></div>
  <div class="sub num">${r.qty.toLocaleString()} 股 · 均價 ${price(r.cost / r.qty)}</div></div><span class="sp"></span>
  <div style="text-align:right"><div class="num ${cls(r.chg)}">${price(r.px)}</div><div class="num ${cls(r.pnl)}">${signed(r.pnl)}${pctTxt(r.pnl / r.cost)}</div></div></a>`

async function viewPositions() {
  const rows = await holdingsWithQuotes()
  $('#main').innerHTML = rows.length ? `<div class="list">${rows.map((r) => `${holdingRow(r)}
    <div class="item sub num" style="border-top:0;padding-top:0">成本 ${money(r.cost)}（含手續費）· 市值 ${money(r.mv)}</div>`).join('')}</div>`
    : '<div class="empty">還沒有持股</div>'
}

async function viewOrders() {
  const os = await api.orders(A.id)
  const secs = new Map((await api.securities([...new Set(os.map((o) => o.symbol))])).map((s) => [s.symbol, s]))
  $('#main').innerHTML = os.length ? `<div class="list">${os.map((o) => {
    const [st, sc] = STATUS[o.status] || [o.status, '']
    const live = o.status === 'open' || o.status === 'partial'
    return `<div class="item">
      <div class="row"><span class="nm ${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '買' : '賣'}</span>
        <span class="nm">${esc(secs.get(o.symbol)?.name || o.symbol)}</span><span class="code">${o.symbol}</span>
        <span class="sp"></span><span class="badge ${sc}">${st}</span></div>
      <div class="row sub num"><span>${SESSION_LABEL[o.session]} · ${o.price_type === 'market' ? '市價' : '限價 ' + price(o.limit_price)} · ${o.qty.toLocaleString()} 股</span>
        <span class="sp"></span><span>${o.filled_qty ? `成交 ${o.filled_qty.toLocaleString()} 股 @ ${price(o.avg_price)}` : ''}</span></div>
      <div class="row sub"><span>${new Date(o.created_at).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })}${o.fee_charged ? ` · 手續費 ${money(o.fee_charged)}` : ''}</span><span class="sp"></span>
        ${live ? `<button class="btn small ghost" data-cancel="${o.id}">取消</button>` : ''}</div></div>`
  }).join('')}</div>` : '<div class="empty">還沒有委託</div>'
  document.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
    try { await api.cancel(b.dataset.cancel); toast('已取消，圈存退回'); await loadMe(); viewOrders() } catch (e) { toast(e.message) }
  })
}

async function viewLedger() {
  const rows = await api.ledger(A.id)
  $('#main').innerHTML = rows.length ? `<div class="list">${rows.map((l) => `<details class="item">
      <summary class="row"><div><div class="nm">${CODE_LABEL[l.code] || l.code}${l.explain?.symbol ? ` <span class="code">${esc(l.explain.symbol)}</span>` : ''}</div>
        <div class="sub">${new Date(l.at).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })}${l.explain?.settle_date ? ` · 交割日 ${l.explain.settle_date}` : ''}</div></div>
        <span class="sp"></span><div style="text-align:right"><div class="num ${cls(l.amount)}">${signed(l.amount)}</div><div class="sub num">餘額 ${money(l.cash_after)}</div></div></summary>
      <pre>${esc(explainText(l))}</pre></details>`).join('')}</div>` : '<div class="empty">沒有紀錄</div>'
}
function explainText(l) {
  const e = l.explain || {}, out = []
  if (e.fills) out.push('成交：' + e.fills.map((f) => `${price(f.price)} × ${f.qty} 股`).join('、') + ` = ${money(e.amount)} 元`)
  if (l.code === 'FEE' && e.commission) out.push(`手續費 = 累計成交金額 ${money(e.commission.cumulative_amount)} × ${(e.commission.rate * 100).toFixed(4)}% × 折扣 ${e.commission.discount}，四捨五入，最低 ${e.commission.min} 元 → 累計 ${money(e.commission.total)} 元，這次收 ${money(-l.amount)} 元`)
  if (l.code === 'TAX') out.push(`證交稅 = 成交金額 ${money(e.amount)} × 稅率，無條件捨去 → ${money(-l.amount)} 元`)
  if (l.code === 'SELL' && e.cost != null) out.push(`成本 ${money(e.cost)}，已實現損益 ${signed(e.realized)} 元`)
  if (e.shares && e.cash_per_share != null) out.push(`除權息日 ${e.ex_date}：${e.shares} 股 × 現金 ${e.cash_per_share} 元、配股 ${e.stock_per_share} 元（面額 ${e.par_value}）`)
  if (e.pay_date_estimated) out.push('發放日為預估（除息日 + 30 天）')
  if (e.note) out.push(e.note)
  out.push(JSON.stringify(e, null, 2))
  return out.join('\n')
}

// ---------------- 下單 ----------------

const F = { symbol: null, sec: null, session: 'lot', side: 'buy', type: 'limit', limit: '', qty: '', book: null }

async function viewOrder(code) {
  if (code && code !== F.symbol) { F.symbol = code; F.sec = null; F.book = null; F.limit = '' }
  if (F.symbol && !F.sec) {
    F.sec = (await api.securities([F.symbol]))[0] || null
    if (!F.sec) { toast(`查無 ${F.symbol}，或不能模擬交易`); F.symbol = null }
  }
  $('#main').innerHTML = `<div class="card">
      <label for="q" style="margin-top:0">股票</label>
      <input id="q" type="search" placeholder="代號或名稱，例如 2330 或 台積電" value="${F.sec ? esc(F.sec.symbol + ' ' + F.sec.name) : ''}" autocomplete="off">
      <div class="results" id="res"></div></div>
    ${F.sec ? `<div class="card" id="bookcard"><div class="empty">報價載入中…</div></div>
    <div class="card">
      <div class="seg" id="sess">${['lot', 'odd', 'odd_after'].map((s) => `<button data-v="${s}" class="${F.session === s ? 'on' : ''}">${SESSION_LABEL[s]}</button>`).join('')}</div>
      <div class="grid2" style="margin-top:10px">
        <div class="seg side" id="side">${[['buy', '買進'], ['sell', '賣出']].map(([v, n]) => `<button data-v="${v}" class="${F.side === v ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="seg" id="ptype">${[['limit', '限價'], ['market', '市價']].map(([v, n]) => `<button data-v="${v}" class="${F.type === v ? 'on' : ''}" ${F.session === 'odd_after' && v === 'market' ? 'disabled' : ''}>${n}</button>`).join('')}</div>
      </div>
      <div class="grid2">
        <div><label for="lp">價格</label><input id="lp" inputmode="decimal" value="${esc(F.type === 'market' ? '' : F.limit)}" ${F.type === 'market' ? 'disabled placeholder="市價"' : ''}></div>
        <div><label for="qt">股數</label><input id="qt" inputmode="numeric" value="${esc(F.qty)}" placeholder="${F.session === 'lot' ? '1000 的倍數' : '1–999'}"></div>
      </div>
      <div id="calc" class="sub" style="margin-top:10px"></div>
      <button class="btn block ${F.side}" id="send">送出${F.side === 'buy' ? '買進' : '賣出'}</button>
    </div>` : ''}`

  let tm
  $('#q').oninput = () => {
    clearTimeout(tm)
    tm = setTimeout(async () => {
      const q = $('#q').value.trim()
      if (!q) { $('#res').innerHTML = ''; return }
      const rs = await api.search(q).catch(() => [])
      $('#res').innerHTML = rs.map((s) => `<button data-s="${s.symbol}"><span class="nm">${esc(s.name)}</span><span class="code">${s.symbol}</span><span class="sp"></span><span class="sub">${s.market === 'tse' ? '上市' : '上櫃'} · ${{ stock: '股票', etf: 'ETF', bond_etf: '債券 ETF' }[s.kind]}</span></button>`).join('') || '<div class="sub">找不到</div>'
      document.querySelectorAll('#res button').forEach((b) => b.onclick = () => { location.hash = `#order/${b.dataset.s}` })
    }, 250)
  }
  $('#q').onfocus = () => $('#q').select()
  if (!F.sec) return

  const seg = (id, key, after) => document.querySelectorAll(`#${id} button`).forEach((b) => b.onclick = () => {
    F[key] = b.dataset.v; after && after(); viewOrder(F.symbol)
  })
  seg('sess', 'session', () => { if (F.session === 'odd_after') F.type = 'limit'; F.qty = ''; F.book = null })
  seg('side', 'side'); seg('ptype', 'type')
  $('#lp') && ($('#lp').oninput = () => { F.limit = $('#lp').value; calc() })
  $('#qt').oninput = () => { F.qty = $('#qt').value; calc() }
  $('#send').onclick = send

  stop()
  const refresh = async () => {
    try { F.book = await quote(F.symbol, F.session === 'lot' ? 'lot' : 'odd') } catch (e) { F.book = { error: e.message } }
    if (location.hash.startsWith('#order')) { renderBook(); calc() } else stop()
  }
  await refresh()
  timer = setInterval(refresh, 5000)
}

function renderBook() {
  const b = F.book, el = $('#bookcard')
  if (!el) return
  if (!b || b.error) { el.innerHTML = `<div class="warnbox">報價中斷${b?.error ? `：${esc(b.error)}` : ''}</div>`; return }
  const age = (Date.now() - Date.parse(b.time)) / 1000
  const px = markPrice(b), chg = px != null && b.ref ? px - b.ref : null
  const rows = Array.from({ length: 5 }, (_, i) => {
    const bid = b.bids[i], ask = b.asks[i]
    const cell = (l, c) => l ? `<div class="lv ${c}" data-p="${l.price}"><span class="num ${cls(l.price - b.ref)}">${price(l.price)}</span><span class="num sub">${(F.session === 'lot' ? l.qty / 1000 : l.qty).toLocaleString()}</span></div>` : '<div class="lv"><span class="sub">—</span></div>'
    return cell(bid, 'bid') + cell(ask, 'ask')
  }).join('')
  el.innerHTML = `<div class="row"><div><span class="nm">${esc(F.sec.name)}</span><span class="code">${F.sec.symbol}</span></div><span class="sp"></span>
      <span class="big num ${cls(chg)}" style="font-size:22px">${price(px)}</span></div>
    <div class="row sub num"><span class="${cls(chg)}">${chg == null ? '' : (chg > 0 ? '▲' : chg < 0 ? '▼' : '') + price(Math.abs(chg)) + pctTxt(chg / b.ref)}</span><span class="sp"></span>
      <span>漲停 ${price(b.limitUp)} · 跌停 ${price(b.limitDown)}</span></div>
    <div class="row sub" style="margin:8px 0 4px"><span>買價　${F.session === 'lot' ? '張' : '股'}</span><span class="sp"></span><span>賣價　${F.session === 'lot' ? '張' : '股'}</span></div>
    <div class="book">${rows}</div>
    ${age > 30 && F.session !== 'odd_after' ? `<div class="warnbox">報價中斷：${Math.round(age)} 秒沒有更新，暫時不能下單</div>` : `<div class="sub" style="margin-top:6px">報價時間 ${new Date(b.time).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })} · 每 5 秒更新</div>`}`
  el.querySelectorAll('[data-p]').forEach((d) => d.onclick = () => { if (F.type === 'limit') { F.limit = d.dataset.p; $('#lp').value = F.limit; calc() } })
}

function calc() {
  const el = $('#calc'); if (!el) return
  const b = F.book, qty = Number(F.qty), fees = mergeFees(A.fee_overrides), kind = F.sec.kind
  const msgs = []
  if (F.qty !== '' && !validQty(qty, F.session)) msgs.push(F.session === 'lot' ? '整股數量要是 1,000 的倍數' : '零股是 1–999 股')
  let px = null
  if (F.type === 'limit') {
    px = Number(F.limit)
    if (F.limit !== '' && b && !b.error && !isValidPrice(px, kind, b.limitUp, b.limitDown)) msgs.push(`價格要符合升降單位 ${tickSize(px || 1, kind)}，且在 ${price(b.limitDown)}–${price(b.limitUp)} 之間`)
  } else if (b && !b.error) {
    px = F.side === 'buy' ? (b.asks[0]?.price ?? null) : (b.bids[0]?.price ?? null)
  }
  if (!px || !qty || msgs.length) { el.innerHTML = msgs.map((m) => `<div class="up">${esc(m)}</div>`).join('') || '輸入價格與股數後顯示試算'; return }
  const amount = fillAmount([{ price: px, qty }]), fee = commission(amount, F.session, fees)
  const lines = [`預估成交金額 ${money(amount)} 元${F.type === 'market' ? '（以目前最佳價估算）' : ''}`, `手續費 ${money(fee)} 元`]
  if (F.side === 'buy') {
    const res = buyReserve(F.type === 'market' ? b.limitUp : px, qty, F.session, fees)
    lines.push(`圈存 ${money(res)} 元${F.type === 'market' ? '（市價單用漲停價圈存，成交後退回多的）' : ''}，可用 ${money(A.cash - A.reserved)} 元`)
    if (res > A.cash - A.reserved) lines.push('<span class="up">可用現金不足</span>')
  } else {
    const tax = sellTax(amount, kind, taipeiDate(new Date()))
    lines.push(`證交稅 ${money(tax)} 元`, `預估入帳 ${money(amount - fee - tax)} 元`)
  }
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('')
}

async function send() {
  const btn = $('#send'); btn.disabled = true
  try {
    const r = await api.order({ symbol: F.symbol, session: F.session, side: F.side, priceType: F.type, limit: F.type === 'limit' ? Number(F.limit) : null, qty: Number(F.qty) })
    toast(r.message); qcache.clear(); await loadMe(); F.qty = ''; viewOrder(F.symbol)
  } catch (e) { toast(e.message); btn.disabled = false }
}

// ---------------- 設定、管理 ----------------

const FEE_LABEL = {
  commissionRate: '手續費率', discount: '手續費折扣（1 = 不打折，0.28 = 2.8 折）', minFee: '整股最低手續費（元）', minFeeOdd: '零股最低手續費（元）',
  marginRate: '融資年利率（第三階段）', shortFeeRate: '融券手續費率（第三階段）', shortRebateRate: '融券擔保品利率（第三階段）',
  borrowDailyRate: '借券費日利率（第二階段）', nhiRate: '補充保費率', nhiThreshold: '補充保費門檻（元）',
}
function viewSettings() {
  const cur = mergeFees(A?.fee_overrides)
  $('#main').innerHTML = `${A ? `<div class="card"><h3>費率</h3><div class="sub">預設是「盡量悲觀」的假設；改成你券商的實際條件，之後的委託就照新費率算。</div>
      ${FEE_KEYS.map((k) => `<label for="f-${k}">${FEE_LABEL[k]}</label><input id="f-${k}" inputmode="decimal" value="${cur[k]}" placeholder="${DEFAULT_FEES[k]}">`).join('')}
      <button class="btn block" id="save">儲存</button><button class="btn block ghost" id="reset">恢復預設</button></div>` : ''}
    ${M?.is_admin ? '<a class="btn block ghost" href="#admin">管理員</a>' : ''}
    <div class="card"><div class="sub">登入帳號 ${esc(U?.email)}</div><button class="btn block ghost" id="out">登出</button></div>`
  $('#out').onclick = async () => { await api.signOut(); U = M = A = null; location.hash = ''; route() }
  if (!A) return
  $('#save').onclick = async () => {
    const o = {}
    for (const k of FEE_KEYS) { const v = Number($(`#f-${k}`).value); if (isFinite(v) && v >= 0 && v !== DEFAULT_FEES[k]) o[k] = v }
    try { await api.setFees(A.id, o); await loadMe(); toast('已儲存') } catch (e) { toast(e.message) }
  }
  $('#reset').onclick = async () => { try { await api.setFees(A.id, {}); await loadMe(); viewSettings(); toast('已恢復預設') } catch (e) { toast(e.message) } }
}

async function viewAdmin() {
  if (!M?.is_admin) { $('#main').innerHTML = '<div class="empty">只有管理員能看這頁</div>'; return }
  const { accounts } = await api.admin({ action: 'accounts' })
  $('#main').innerHTML = `<div class="card"><h3>邀請碼</h3><button class="btn" id="inv">產生邀請碼</button><div id="code" class="big num" style="margin-top:8px"></div></div>
    <div class="card"><h3>入金</h3>
      <label for="acc">帳戶</label><select id="acc">${accounts.map((a) => `<option value="${a.account_id}">${esc(a.display_name || a.email)}（現金 ${money(a.cash)}）</option>`).join('')}</select>
      <div class="grid2"><div><label for="amt">金額</label><input id="amt" inputmode="numeric"></div><div><label for="note">備註</label><input id="note"></div></div>
      <button class="btn block" id="dep">入金</button></div>
    <div class="list">${accounts.map((a) => `<div class="item row"><div><div class="nm">${esc(a.display_name || '—')}</div><div class="sub">${esc(a.email || '')}</div></div><span class="sp"></span>
      <div style="text-align:right" class="num"><div>${money(a.cash)}</div><div class="sub">圈存 ${money(a.reserved)}</div></div></div>`).join('')}</div>`
  $('#inv').onclick = async () => { try { $('#code').textContent = (await api.admin({ action: 'invite' })).code } catch (e) { toast(e.message) } }
  $('#dep').onclick = async () => {
    try { await api.admin({ action: 'deposit', accountId: $('#acc').value, amount: Number($('#amt').value), note: $('#note').value }); toast('已入金'); await loadMe(); viewAdmin() } catch (e) { toast(e.message) }
  }
}

// ---------------- 路由 ----------------

async function loadMe() {
  U = await api.user()
  M = U ? await api.member(U.id) : null
  A = U ? await api.account(U.id) : null
}

async function route() {
  stop()
  const [r, arg] = location.hash.replace(/^#/, '').split('/')
  try {
    if (!api) { viewSetup(); setTabs(''); return }
    if (!U) { setTabs(''); viewLogin(); return }
    if (r === 'settings') { setTabs(''); viewSettings(); return }
    if (!A) { setTabs(''); viewInvite(); return }
    setTabs(r || 'home')
    if (r === 'order') await viewOrder(arg ? decodeURIComponent(arg).toUpperCase() : F.symbol)
    else if (r === 'orders') await viewOrders()
    else if (r === 'positions') await viewPositions()
    else if (r === 'ledger') await viewLedger()
    else if (r === 'admin') await viewAdmin()
    else await viewHome()
  } catch (e) {
    $('#main').innerHTML = `<div class="warnbox">${esc(e.message)}</div>`
  }
  window.scrollTo(0, 0)
}

window.addEventListener('hashchange', route)
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (location.hash.startsWith('#order')) route() })
;(async () => {
  if (DEMO) api = demoApi()
  else if (SUPABASE_ANON_KEY) {
    try { api = await realApi() } catch (e) { $('#main').innerHTML = `<div class="warnbox">載入失敗：${esc(e.message)}</div>`; return }
  }
  if (api) await loadMe().catch((e) => toast(e.message))
  route()
})()
