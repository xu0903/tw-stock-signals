# 模擬交易第一階段（現股）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 受邀使用者在台股訊號網站用假錢交易上市櫃股票與 ETF：整股、盤中零股、盤後零股，市價／限價，照真實五檔成交，悲觀費率，除權息入帳，管理員可入金。

**Architecture:** 規則與流程邏輯寫成 ES module 的 `.js`（JSDoc 標型別），Node 24 測試、Deno Edge Function、瀏覽器三邊直接 import 同一份；只有 Edge Function 進入點 `index.ts` 與 `db.ts` 是 TypeScript。Supabase（LifeMaster 專案的 `sim` schema）存帳務；所有改錢的動作是 `security definer` 的 plpgsql 函式，在一個交易內鎖帳戶列、改現金／持股／對帳單。Edge Functions 負責抓報價、呼叫規則、再呼叫 plpgsql 落帳；pg_cron 驅動撮合與結算。前端是台股訊號網站裡的 `web/sim.html`（無建置步驟）。

**Tech Stack:** TypeScript（Node 24 `node --test` 跑測試、Supabase Edge Functions Deno 執行）、PostgreSQL plpgsql + RLS、pg_cron + pg_net、@supabase/supabase-js@2.49.4（CDN）、原生 HTML/JS。

**Spec:** `docs/specs/2026-10-21-paper-trading-design.md`

## Global Constraints

- Supabase 專案 `cvpcgqgpwelokwqltktd`；所有物件放在 schema `sim`，不碰 `public`。
- 前端只能讀自己的資料（RLS）；任何改動 cash／持股／對帳單的動作只能經由 `sim.*` security definer 函式（由 Edge Function 以 service role 呼叫，或由使用者呼叫但函式內驗證 `auth.uid()`）。
- 現金永不為負（管理員入金以外的每個扣款都要在同一交易內檢查）。
- 費率預設（`DEFAULT_FEES`）：手續費 0.1425% 不打折、整股與零股每筆最低 20 元、四捨五入到元；證交稅股票 0.3%、ETF 0.1%、債券 ETF 在 2026-12-31（含）前 0%、之後 0.1%、無條件捨去到元；補充保費單筆現金股利 ≥ 20,000 元扣 2.11%。融資 7%、融券手續費 0.1%、融券利息 0%、借券費日 3.5% 只先放進設定，第一階段不使用。
- 新帳戶 100,000 元；只有 `sim.members.is_admin = true` 的人能入金和發邀請碼；匿名登入（`is_anonymous`）不能開戶。
- 每筆對帳單都有 `code`（`ADMIN_DEPOSIT`、`OPEN_GRANT`、`BUY`、`SELL`、`FEE`、`TAX`、`DIVIDEND`、`NHI_PREMIUM`、`STOCK_DIVIDEND_CASH_IN_LIEU`）與 `explain` jsonb（算式與參數）。
- 報價超過 30 秒就視為中斷，不撮合、不成交。
- 時區一律用台北（UTC+8，無日光節約）。交易時段：整股 09:00–13:30；盤中零股委託 09:00–13:30、09:10 起撮合；盤後零股委託 13:40–14:30、14:30 撮合。時段寫成 `rules.js` 的常數。
- 介面文字一律繁體中文；漲紅跌綠；手機寬度 390px 不可橫向捲動。
- 測試指令：`node --test supabase/functions/_shared/`。`_shared/` 裡除了 `db.ts` 都是 `.js`（不經轉譯，三個執行環境共用），型別寫在 JSDoc；計畫中的 `type`／`interface` 寫法代表 JSDoc `@typedef`。

## Review Focus

1. **連點兩次送出**：兩筆買單同時到，合計圈存超過現金時，第二筆必須被拒絕，現金不可為負 → Task 5 `test_concurrent_reserve`。
2. **賣出超過可賣股數**：已有掛著的賣單時再下賣單，可賣 = 持股 − 掛單中的賣出股數 → Task 5 `test_sell_exceeds_available`。
3. **休市日、收盤後、報價過舊時下市價單**：要拒絕並說明原因，不能用舊價格成交 → Task 2 `sessionState` 測試、Task 3 `isStale` 測試、Task 6 下單函式測試。
4. **13:29:59 下單、13:30 之後才撮合**：收盤後不得再成交，該單在結算時取消並退回圈存 → Task 7 `test_no_fill_after_close`。
5. **整股／零股數量搞混**：整股時段數量必須是 1000 的倍數；零股時段 1–999 股 → Task 1 `validQty` 測試。

---

### Task 1: 費用、稅、升降單位、數量規則

**Files:**
- Create: `supabase/functions/_shared/rules.js`
- Test: `supabase/functions/_shared/rules.test.js`
- Create: `package.json`（只有 `"type": "module"` 與 `"scripts": {"test": "node --test supabase/functions/_shared/"}`）

**Interfaces:**
- Produces:
  - `type Market = 'tse' | 'otc'`、`type Kind = 'stock' | 'etf' | 'bond_etf'`、`type Session = 'lot' | 'odd' | 'odd_after'`、`type Side = 'buy' | 'sell'`
  - `interface FeeConfig { commissionRate; discount; minFee; minFeeOdd; marginRate; shortFeeRate; shortRebateRate; borrowDailyRate; nhiRate; nhiThreshold }`（皆 number）與 `DEFAULT_FEES`、`mergeFees(overrides: Partial<FeeConfig> | null): FeeConfig`
  - `commission(amount: number, session: Session, fees: FeeConfig): number`
  - `sellTax(amount: number, kind: Kind, date: string): number`（date 為 `YYYY-MM-DD`）
  - `tickSize(price: number, kind: Kind): number`、`isValidPrice(price: number, kind: Kind, limitUp: number, limitDown: number): boolean`
  - `validQty(qty: number, session: Session): boolean`
  - `kindOf(symbol: string): Kind | null`（`00` 開頭且結尾 `B` → bond_etf；其他 `00` 開頭 → etf；4 碼數字 → stock；其餘如 `02xxxx` ETN、權證 → null 不可交易）

- [ ] **Step 1: 寫測試**

```ts
test('commission', () => {
  assert.equal(commission(2420 * 1000, 'lot', DEFAULT_FEES), 3449)   // 2,420,000 × 0.1425% = 3448.5 → 3449
  assert.equal(commission(2420, 'odd', DEFAULT_FEES), 20)            // 3.45 → 最低 20
  assert.equal(commission(100000, 'lot', mergeFees({ discount: 0.28 })), 40) // 142.5×0.28=39.9 → 40
})
test('sellTax', () => {
  assert.equal(sellTax(241500, 'stock', '2026-10-21'), 724)      // 724.5 → 724
  assert.equal(sellTax(100000, 'etf', '2026-10-21'), 100)
  assert.equal(sellTax(100000, 'bond_etf', '2026-12-31'), 0)
  assert.equal(sellTax(100000, 'bond_etf', '2027-01-04'), 100)
})
test('tickSize', () => {
  for (const [p, t] of [[9.99, 0.01], [10, 0.05], [49.95, 0.05], [50, 0.1], [100, 0.5], [500, 1], [999, 1], [1000, 5], [2420, 5]]) assert.equal(tickSize(p, 'stock'), t)
  assert.equal(tickSize(49.99, 'etf'), 0.01); assert.equal(tickSize(50, 'etf'), 0.05)
  assert.ok(isValidPrice(2420, 'stock', 2645, 2165)); assert.ok(!isValidPrice(2422, 'stock', 2645, 2165)); assert.ok(!isValidPrice(2650, 'stock', 2645, 2165))
  assert.ok(isValidPrice(10.05, 'stock', 11, 9))   // 浮點：10.05 / 0.05 不可因誤差判錯
})
test('validQty', () => {
  assert.ok(validQty(2000, 'lot')); assert.ok(!validQty(1500, 'lot')); assert.ok(!validQty(0, 'lot'))
  assert.ok(validQty(1, 'odd')); assert.ok(validQty(999, 'odd_after')); assert.ok(!validQty(1000, 'odd')); assert.ok(!validQty(1.5, 'odd'))
})
test('kindOf', () => {
  assert.equal(kindOf('2330'), 'stock'); assert.equal(kindOf('0050'), 'etf'); assert.equal(kindOf('00631L'), 'etf')
  assert.equal(kindOf('00679B'), 'bond_etf'); assert.equal(kindOf('00981A'), 'etf'); assert.equal(kindOf('020020'), null); assert.equal(kindOf('03001P'), null)
})
```

- [ ] **Step 2:** `npm test` → FAIL（模組不存在）
- [ ] **Step 3: 實作 `rules.js`。** 價格比較一律換成整數「分」（×100 後 `Math.round`）再算，避免浮點誤差。債券 ETF 免稅到期日寫成常數 `BOND_ETF_TAX_FREE_UNTIL = '2026-12-31'`。
- [ ] **Step 4:** `npm test` → PASS
- [ ] **Step 5:** `git add package.json supabase/functions/_shared/rules*.js && git commit -m "sim: fee, tax, tick and quantity rules"`

---

### Task 2: 撮合、圈存、交易時段

**Files:**
- Modify: `supabase/functions/_shared/rules.js`
- Test: `supabase/functions/_shared/rules.test.js`

**Interfaces:**
- Consumes: Task 1 型別與 `commission`
- Produces:
  - `interface Level { price: number; qty: number }`（qty 一律「股」）
  - `interface Book { symbol: string; session: Session; asks: Level[]; bids: Level[]; last: number | null; limitUp: number; limitDown: number; ref: number; time: string }`（asks 由低到高、bids 由高到低，time 為 ISO）
  - `interface Fill { price: number; qty: number }`
  - `matchMarket(book: Book, side: Side, qty: number): Fill[]`（逐檔吃，五檔不夠就只回傳吃得到的部分）
  - `matchLimit(book: Book, side: Side, limit: number, qty: number): Fill[]`（只吃價格不劣於 limit 的檔位，成交價用對手檔位價）
  - `matchAfterHours(closePrice: number | null, side: Side, limit: number, qty: number): Fill[]`（全部成交於 closePrice，或不成交）
  - `buyReserve(price: number, qty: number, session: Session, fees: FeeConfig): number`（price × qty + commission）
  - `interface SessionState { lot: boolean; odd: boolean; oddMatch: boolean; oddAfter: boolean; oddAfterMatch: boolean }`、`sessionState(now: Date, isTradingDay: boolean): SessionState`
  - `taipeiDate(now: Date): string`（`YYYY-MM-DD`）

- [ ] **Step 1: 寫測試**

```ts
const book: Book = { symbol: '2330', session: 'lot', asks: [{ price: 2420, qty: 1000 }, { price: 2425, qty: 2000 }], bids: [{ price: 2415, qty: 3000 }], last: 2420, limitUp: 2645, limitDown: 2165, ref: 2405, time: '2026-10-21T05:00:00Z' }
test('matchMarket walks levels', () => assert.deepEqual(matchMarket(book, 'buy', 2000), [{ price: 2420, qty: 1000 }, { price: 2425, qty: 1000 }]))
test('matchMarket partial when book thin', () => assert.deepEqual(matchMarket(book, 'buy', 5000), [{ price: 2420, qty: 1000 }, { price: 2425, qty: 2000 }]))
test('matchMarket at limit up with no asks', () => assert.deepEqual(matchMarket({ ...book, asks: [] }, 'buy', 1000), []))
test('matchLimit', () => {
  assert.deepEqual(matchLimit(book, 'buy', 2420, 2000), [{ price: 2420, qty: 1000 }])
  assert.deepEqual(matchLimit(book, 'buy', 2410, 1000), [])
  assert.deepEqual(matchLimit(book, 'sell', 2400, 1000), [{ price: 2415, qty: 1000 }])
})
test('matchAfterHours', () => {
  assert.deepEqual(matchAfterHours(2420, 'buy', 2425, 10), [{ price: 2420, qty: 10 }])
  assert.deepEqual(matchAfterHours(2420, 'sell', 2425, 10), [])
  assert.deepEqual(matchAfterHours(null, 'buy', 2425, 10), [])
})
test('buyReserve', () => assert.equal(buyReserve(2645, 1000, 'lot', DEFAULT_FEES), 2645000 + 3769))
test('sessionState', () => {
  const t = (hhmmss: string) => new Date(`2026-10-21T${hhmmss}+08:00`)
  assert.deepEqual(sessionState(t('08:59:59'), true), { lot: false, odd: false, oddMatch: false, oddAfter: false, oddAfterMatch: false })
  assert.equal(sessionState(t('09:05:00'), true).odd, true); assert.equal(sessionState(t('09:05:00'), true).oddMatch, false)
  assert.equal(sessionState(t('13:30:00'), true).lot, true); assert.equal(sessionState(t('13:30:01'), true).lot, false)
  assert.equal(sessionState(t('13:45:00'), true).oddAfter, true); assert.equal(sessionState(t('14:30:00'), true).oddAfterMatch, true)
  assert.equal(sessionState(t('10:00:00'), false).lot, false)   // 休市日
})
```

- [ ] **Step 2:** `npm test` → FAIL
- [ ] **Step 3: 實作。** `oddAfterMatch` 為 14:30:00–14:59:59（給結算排程一個執行窗口）。
- [ ] **Step 4:** `npm test` → PASS
- [ ] **Step 5:** commit `"sim: matching, reservation and session rules"`

---

### Task 3: 報價模組

**Files:**
- Create: `supabase/functions/_shared/quote.js`
- Test: `supabase/functions/_shared/quote.test.js`
- Create: `supabase/functions/_shared/fixtures/mis-lot.json`、`fixtures/mis-odd.json`（Step 1 先用 curl 存下 `getStockInfo.jsp?ex_ch=tse_2330.tw|otc_6488.tw&json=1&delay=0` 與 `getOddInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0` 的真實回應）

**Interfaces:**
- Consumes: `Book`、`Session`、`Market`
- Produces:
  - `interface QuoteSource { getBooks(items: { symbol: string; market: Market }[], session: 'lot' | 'odd'): Promise<Map<string, Book>> }`
  - `class MisQuoteSource implements QuoteSource`（每次最多 50 檔一個請求；`User-Agent` 帶瀏覽器字串；`json=1&delay=0`）
  - `class FakeQuoteSource implements QuoteSource`（建構子吃 `Map<string, Book>`）
  - `parseMis(json: unknown, session: 'lot' | 'odd'): Map<string, Book>`
  - `isStale(book: Book, now: Date, maxAgeSec = 30): boolean`

欄位對應（已實測 2026-10-21）：`c` 代號、`a`/`b` 為 `_` 分隔的五檔價、`f`/`g` 為五檔量、`u` 漲停、`w` 跌停、`y` 昨收、`z` 最新成交（`-` 為無）、`tlong` 毫秒時間戳。**整股 `f`/`g` 單位是張，要 ×1000；零股是股。**價格 `-` 或 0 的檔位要丟掉（漲跌停時常見）。

- [ ] **Step 1: 存 fixtures 並寫測試**：從 fixture 解析出 2330 整股 asks[0] = `{ price: 2420, qty: 1064000 }`、limitUp 2645、ref 2405；零股 asks[0] = `{ price: 2420, qty: 400 }`；`a` 為 `"-"` 的合成案例 → asks 為空陣列；`isStale` 在 tlong 後 31 秒為 true、29 秒為 false。
- [ ] **Step 2:** `npm test` → FAIL
- [ ] **Step 3: 實作。**
- [ ] **Step 4:** `npm test` → PASS
- [ ] **Step 5:** commit `"sim: quote source for TWSE mis (lot and odd)"`

---

### Task 4: 參考資料解析（股票清單、除權息、休市日）

**Files:**
- Create: `supabase/functions/_shared/refdata.js`
- Test: `supabase/functions/_shared/refdata.test.js`
- Create: `supabase/functions/_shared/fixtures/` 底下各端點前 20 筆的真實回應

**Interfaces:**
- Produces:
  - `rocToIso(roc: string): string`（`'1151021'` → `'2026-10-21'`；也接受 `'115/10/21'`）
  - `interface Security { symbol: string; name: string; market: Market; kind: Kind }`
  - `parseTwseSecurities(rows): Security[]`（來源 `https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL`）、`parseTpexSecurities(rows): Security[]`（來源 `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes`）；`kindOf` 回 null 的丟掉
  - `interface CorpAction { symbol: string; exDate: string; cashPerShare: number; stockPerShare: number; payDate: string; payDateEstimated: boolean }`
  - `parseTwseExRights(rows): CorpAction[]`（`exchangeReport/TWT48U_ALL`：`Date`、`Code`、`CashDividend`、`StockDividendRatio`）、`parseTpexExRights(rows): CorpAction[]`（`tpex_exright_prepost`，實作時看 fixture 欄位）
  - `estimatePayDate(exDate: string, holidays: Set<string>): string`（除息日 + 30 個日曆天，遇非交易日順延）
  - `parseHolidays(rows): Set<string>`（`holidaySchedule/holidaySchedule`；名稱含「開始交易」或「最後交易」的不是休市日）
  - `isTradingDay(date: string, holidays: Set<string>): boolean`

開放資料沒有股利發放日，所以 `payDate` 一律用 `estimatePayDate`，並設 `payDateEstimated: true`。對帳單的 `explain` 要寫上「預估發放日」。

- [ ] **Step 1: 存 fixtures、寫測試**：`rocToIso`；TWT48U 中 `CashDividend` 空字串 → 0；`kindOf` 為 null 的代號被丟掉；`isTradingDay('2026-02-12')` 為 false（「市場無交易，僅辦理結算交割作業」）、`isTradingDay('2026-01-02')` 為 true、週六為 false。
- [ ] **Step 2:** FAIL → **Step 3:** 實作 → **Step 4:** PASS
- [ ] **Step 5:** commit `"sim: reference data parsers"`

---

### Task 5: 資料庫 schema、RLS、帳務函式

**Files:**
- Create: `supabase/sql/01_sim_schema.sql`、`supabase/sql/02_sim_ledger.sql`
- Test: `supabase/sql/tests/sim_test.sql`（整段包在 `begin; … rollback;`，失敗用 `raise exception`，最後 `raise notice 'ALL PASS'`）

**Interfaces:**
- Produces（表，全部在 `sim`）：
  - `members(user_id uuid pk → auth.users, display_name text, is_admin bool default false, created_at)`
  - `invites(code text pk, created_by uuid, used_by uuid null, used_at timestamptz null, created_at)`
  - `accounts(id uuid pk, user_id uuid, kind text check in ('normal','tutorial'), cash bigint, reserved bigint default 0, fee_overrides jsonb null, created_at)`；每個 user 每種 kind 只有一個
  - `securities(symbol pk, name, market, kind, updated_at)`、`holidays(date pk)`、`corp_actions(symbol, ex_date, cash_per_share numeric, stock_per_share numeric, pay_date date, pay_date_estimated bool, pk(symbol, ex_date))`
  - `orders(id uuid pk, account_id, symbol, session, side, price_type text check in ('market','limit'), limit_price numeric null, qty int, filled_qty int default 0, avg_price numeric null, fee_charged bigint default 0, reserved bigint default 0, status text check in ('open','filled','partial','cancelled','expired','rejected'), reject_reason text null, trade_date date, created_at)`
  - `fills(id bigserial, order_id, price numeric, qty int, at timestamptz)`
  - `positions(account_id, symbol, qty int, cost bigint, pk(account_id, symbol))`（cost 含買進手續費）
  - `ledger(id bigserial, account_id, at timestamptz, amount bigint, cash_after bigint, code text, ref text null, explain jsonb)`
  - `entitlements(account_id, symbol, ex_date, shares int, paid bool default false, pk(account_id, symbol, ex_date))`
- Produces（函式，全部 `security definer set search_path = sim, public`）：
  - `sim.redeem_invite(p_code text, p_name text) returns uuid`：呼叫者不可為匿名；邀請碼未使用；建立 member 與 normal 帳戶，cash 100000，寫 `OPEN_GRANT`
  - `sim.admin_deposit(p_account uuid, p_amount bigint, p_note text)`：呼叫者需 is_admin；寫 `ADMIN_DEPOSIT`
  - `sim.admin_create_invite() returns text`：8 碼大寫英數
  - `sim.place_order(p_account uuid, p_symbol text, p_session text, p_side text, p_price_type text, p_limit numeric, p_qty int, p_reserve bigint, p_trade_date date) returns uuid`：只給 service role（`revoke execute … from public, authenticated`）；`select … for update` 鎖帳戶；買單檢查 `cash - reserved >= p_reserve`，賣單檢查 `持股 - 同股票 open/partial 賣單剩餘股數 >= p_qty`；失敗就 `raise exception` 帶中文原因
  - `sim.apply_fills(p_order uuid, p_fills jsonb, p_fee_total bigint, p_tax bigint, p_explain jsonb)`：只給 service role；鎖帳戶；`p_fee_total` 是這張單累計應收手續費，扣 `p_fee_total - fee_charged` 的差額；買進：cash 扣成交金額 + 手續費差額、依比例釋放圈存、持股與成本增加；賣出：cash 加成交金額 − 手續費差額 − 稅、持股依平均成本減少；寫 BUY／SELL、FEE、TAX 三種對帳單；更新 filled_qty、avg_price、status
  - `sim.close_order(p_order uuid, p_status text)`：cancelled／expired，釋放剩餘圈存
  - `sim.cancel_my_order(p_order uuid)`：authenticated 可呼叫，只能取消自己的 open／partial 單 → 內部呼叫 `close_order`
- RLS：members、accounts、orders、fills、positions、ledger、entitlements 只能 select 自己的（以 `accounts.user_id = auth.uid()` 串接）；securities、holidays、corp_actions 登入者可讀；所有表不給 insert／update／delete。

- [ ] **Step 1: 寫 `sim_test.sql`**：建兩個測試 user（直接 insert `auth.users` 的最小欄位）、設一個 admin。測項：`test_redeem_invite`（cash 100000、邀請碼不能用第二次、匿名者被拒）；`test_rls_isolation`（用 `set local role authenticated` + `set local request.jwt.claims` 模擬 B，查不到 A 的 accounts／ledger）；`test_admin_only_deposit`；`test_concurrent_reserve`（cash 100000，第一筆圈存 60000 成功，第二筆 60000 失敗）；`test_sell_exceeds_available`（持股 1000、已有 600 股賣單掛著，再賣 500 失敗）；`test_apply_fills_buy_sell`（買 1000 股 @100、手續費 143 → cash 99857 − 100000 …；再賣出：手續費與稅、cost 歸零、ledger 有 6 筆）；`test_fee_delta`（同一張單分兩次成交，第一次收最低 20 元，累計超過才補差額）。
- [ ] **Step 2: 寫 `01_sim_schema.sql`、`02_sim_ledger.sql`**
- [ ] **Step 3: 套用到 Supabase，並跑測試。** 優先用 `npx supabase db query --linked -f <file>`（使用者執行 `npx supabase login` 與 `npx supabase link --project-ref cvpcgqgpwelokwqltktd` 之後）。CLI 沒有這個指令的話，就請使用者貼到 Dashboard → SQL Editor 執行。預期輸出 `ALL PASS`。
- [ ] **Step 4:** commit `"sim: schema, RLS and ledger functions"`

---

### Task 6: Edge Functions：下單與管理

**Files:**
- Create: `supabase/functions/_shared/db.ts`（service-role client；從 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 建立，`db: { schema: 'sim' }`）
- Create: `supabase/functions/_shared/order.js`（純流程，不碰網路：吃 `QuoteSource` 與一個 `Db` 介面，可用假物件測）
- Test: `supabase/functions/_shared/order.test.js`
- Create: `supabase/functions/sim-order/index.ts`、`supabase/functions/sim-admin/index.ts`
- Create: `supabase/README.md`（部署步驟）

**Interfaces:**
- Consumes: `rules.js`、`QuoteSource`、`sim.place_order`、`sim.apply_fills`、`sim.close_order`
- Produces:
  - `interface OrderRequest { accountId: string; symbol: string; session: Session; side: Side; priceType: 'market' | 'limit'; limit: number | null; qty: number }`
  - `interface Db { security(symbol): Promise<Security | null>; isTradingDay(date): Promise<boolean>; feeConfig(accountId): Promise<FeeConfig>; placeOrder(...): Promise<string>; applyFills(orderId, fills, feeTotal, tax, explain): Promise<void>; closeOrder(orderId, status): Promise<void> }`
  - `submitOrder(req: OrderRequest, now: Date, db: Db, quotes: QuoteSource): Promise<{ orderId: string; status: string; fills: Fill[]; message: string }>`：依序檢查 security 存在、時段開放（`odd_after` 只收限價）、數量、限價合法、報價不過舊；圈存用限價（市價用 limitUp）；建單；能立刻成交就成交；市價單沒吃完的剩餘量立刻 `close_order(..., 'cancelled')`
  - HTTP：`POST /sim-order` body `OrderRequest`（accountId 由 JWT 的 user 反查，不信任前端傳的）→ `{ orderId, status, fills, message }`；錯誤回 400 `{ error: '中文原因' }`
  - HTTP：`POST /sim-admin` body `{ action: 'deposit', accountId, amount, note } | { action: 'invite' }` → 轉呼叫對應 plpgsql（以使用者 JWT 呼叫，讓函式自己檢查 is_admin）

- [ ] **Step 1: 寫 `order.test.js`**（假 Db + `FakeQuoteSource`）：收盤後市價單被拒且不建單；報價過舊被拒；整股 1500 股被拒；市價買 2000 股吃兩檔，`applyFills` 收到兩筆 fills、feeTotal = `commission(2420×1000+2425×1000)`；盤後零股市價單被拒；限價沒碰到 → status `open`、沒有 fills。
- [ ] **Step 2:** FAIL → **Step 3:** 實作 `order.js`、`db.ts`、兩個 `index.ts` → **Step 4:** PASS
- [ ] **Step 5: 部署**（需要使用者先在 PowerShell 執行一次 `npx supabase login`）：`npx supabase functions deploy sim-order sim-admin --project-ref cvpcgqgpwelokwqltktd`；用 curl 帶使用者 JWT 打 `sim-admin` 的 invite，確認回傳 8 碼。
- [ ] **Step 6:** commit `"sim: order and admin edge functions"`

---

### Task 7: 撮合排程

**Files:**
- Create: `supabase/functions/_shared/match.js`、Test: `match.test.js`
- Create: `supabase/functions/sim-match/index.ts`
- Create: `supabase/sql/03_sim_cron.sql`（cron 本體）與 `supabase/sql/03_sim_cron_secret.local.sql`（`.gitignore` 加 `*.local.sql`；存 `SIM_CRON_SECRET`，作法照 LifeMaster 的 `config.sql.local`）

**Interfaces:**
- Consumes: `matchLimit`、`sessionState`、`isStale`、`Db.applyFills`
- Produces:
  - `matchOpenOrders(orders: OpenOrder[], books: Map<string, Book>, now: Date, state: SessionState, fees: (accountId) => FeeConfig): { orderId: string; fills: Fill[]; feeTotal: number; tax: number }[]`，其中 `OpenOrder = { id; accountId; symbol; session; side; limit: number; remaining: number; feeCharged: number; filledAmount: number; kind: Kind }`
  - `sim-match`：驗證 header `x-cron-secret`；在一次呼叫內跑 6 輪、每輪間隔 10 秒（約 55 秒）；每輪只抓有 open／partial 單的股票，整股與零股分開請求；`state.lot` 或 `state.oddMatch` 為 false 就不撮合該時段
  - cron：`'* 1-5 * * 1-5'`（UTC，台北 09:00–13:59 每分鐘）以 `net.http_post` 呼叫 `sim-match`

- [ ] **Step 1: 寫 `match.test.js`**：限價買單碰到 → 成交；`test_no_fill_after_close`（13:30:05 時 state.lot = false → 不產生任何成交）；報價過舊 → 跳過；同一檔兩張買單，第一張吃掉的量不會再給第二張（依建單時間先後分配同一份五檔量）。
- [ ] **Step 2:** FAIL → **Step 3:** 實作 → **Step 4:** PASS
- [ ] **Step 5:** 部署 `sim-match`，套用 cron SQL；在交易時段用 `select * from cron.job_run_details order by start_time desc limit 5` 確認成功執行
- [ ] **Step 6:** commit `"sim: limit order matching job"`

---

### Task 8: 參考資料更新與收盤結算

**Files:**
- Create: `supabase/functions/_shared/settle.js`、Test: `settle.test.js`
- Create: `supabase/functions/sim-refdata/index.ts`、`supabase/functions/sim-settle/index.ts`
- Modify: `supabase/sql/02_sim_ledger.sql`（新增 `sim.snapshot_entitlements(p_ex_date date)`、`sim.pay_entitlement(p_account, p_symbol, p_ex_date, p_cash bigint, p_nhi bigint, p_shares int, p_cash_in_lieu bigint, p_explain jsonb)`，皆只給 service role）
- Modify: `supabase/sql/03_sim_cron.sql`

**Interfaces:**
- Consumes: Task 4 解析器、`matchAfterHours`、`estimatePayDate`
- Produces:
  - `dividendPayout(shares: number, a: CorpAction, fees: FeeConfig): { cash: number; nhi: number; newShares: number; cashInLieu: number }`：cash = floor(shares × cashPerShare)；cash ≥ 20000 時 nhi = round(cash × 2.11%)；newShares = floor(shares × stockPerShare ÷ 10)；不足一股的部分 × 10 元折現
  - `sim-refdata`（cron 每個平日台北 08:00 = UTC `0 0 * * 1-5`）：upsert securities、holidays、corp_actions
  - `sim-settle`（cron 台北 14:31 與 14:45，UTC `31,45 6 * * 1-5`）：(1) 盤後零股：用 `getOddInfo` 14:30 後的成交價 `z`，依 `matchAfterHours` 撮合；(2) 所有當日 open／partial 單 → `close_order(…,'expired')`；(3) 下一個交易日是除權息日的 → `snapshot_entitlements`；(4) `pay_date = 今天` 且未發放的 → `pay_entitlement`。每步都要能重複執行而不重複入帳（以 `paid`、order status 判斷）

- [ ] **Step 1: 寫 `settle.test.js`**：1000 股、每股現金 7 元 → cash 7000、nhi 0；3000 股 × 7 元 = 21000 → nhi 443；150 股、配股率 0.5 元（每股配 0.05 股）→ newShares 7、cashInLieu 5；`estimatePayDate('2026-12-16', …)` 在 2027-01-15 遇週末時順延。
- [ ] **Step 2:** FAIL → **Step 3:** 實作 → **Step 4:** PASS
- [ ] **Step 5:** 部署兩個函式並套用 cron；手動觸發 `sim-refdata` 一次，確認 `select count(*) from sim.securities` 約 1,900、`sim.holidays` 有今年的休市日。
- [ ] **Step 6:** commit `"sim: reference data refresh and daily settlement"`

---

### Task 9: 前端

**Files:**
- Create: `web/sim.html`、`web/sim.js`、`web/sim.css`、`web/config.js`（`SUPABASE_URL`、`SUPABASE_ANON_KEY`，與 LifeMaster `.env` 相同的公開值）
- Modify: `build_site.py`（複製 `supabase/functions/_shared/rules.js` 到 `site/rules.js`）
- Modify: `web/index.html`（頁首加「模擬交易」連結；個股詳細頁加「模擬下單」按鈕 → `sim.html#order/<code>`）

**Interfaces:**
- Consumes: `sim-order`、`sim-admin`、`sim.cancel_my_order`、`sim.redeem_invite`、表的 select、`getStockInfo`／`getOddInfo` 的報價**只透過後端**（新增 `sim-order` 的 `GET ?quote=<symbol>&session=lot|odd` 回傳 `Book`，因為瀏覽器不能直接跨網域讀證交所）
- Produces：hash 路由 `#home`、`#order/<code>`、`#orders`、`#positions`、`#ledger`、`#settings`、`#admin`

畫面重點：
- 未登入 → email／密碼登入或註冊（supabase-js 預設 storageKey，和 LifeMaster 共用登入）；已登入但不是成員 → 輸入邀請碼。
- 總覽：現金、圈存、持股市值（用報價的 last，沒有就 ref）、未實現損益、總資產。
- 下單：搜尋代號或名稱（`sim.securities`）、整股／盤中零股／盤後零股切換、五檔（下單頁開著時每 5 秒更新）、買／賣、市價／限價、數量；送出前顯示試算（圈存、預估手續費、賣出預估稅），直接 import 同一份 `rules.js`（`build_site.py` 把 `supabase/functions/_shared/rules.js` 複製到 `site/rules.js`）。
- 委託（可取消）、持股、對帳單（每筆展開顯示 `explain`）、設定（費率覆寫，寫入 `accounts.fee_overrides`：新增 `sim.set_fee_overrides(jsonb)`，只接受 `FeeConfig` 的 key）、管理員頁（列出帳戶、入金、產生邀請碼）。

- [ ] **Step 1:** 實作頁面
- [ ] **Step 2: 驗證**：用 playwright-core + Edge（同 `scratchpad/shot.cjs` 作法）在 390×844 截圖淺色與深色的每個 hash 頁；`document.documentElement.scrollWidth === 390`；主控台沒有錯誤。
- [ ] **Step 3:** commit `"sim: web UI"` 並 push（GitHub Actions 自動部署）


---

### Task 10: 上線驗收

- [ ] **Step 1:** Supabase Dashboard → Authentication → URL Configuration 的 Redirect URLs 加上 `https://xu0903.github.io/tw-stock-signals/**`（使用者操作，或用 Management API）。
- [ ] **Step 2:** 把使用者設成管理員：`insert into sim.members (user_id, display_name, is_admin) …` 之後用 `redeem_invite` 開自己的帳戶。
- [ ] **Step 3: 交易時段實測**（台北 09:10–13:30）：市價買 1 股台積電零股 → 成交價等於當下零股最佳賣價、手續費 20 元；限價買整股一張較低價 → 掛單 → 收盤後狀態變 expired、圈存退回；對帳單每筆 explain 正確。
- [ ] **Step 4:** 把這次的實測結果寫進 `supabase/README.md` 的「已驗證」段落，commit、push。
