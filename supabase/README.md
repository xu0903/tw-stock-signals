# 模擬交易後端（Supabase）

部署到 LifeMaster 的 Supabase 專案 `cvpcgqgpwelokwqltktd`，所有資料在 `sim` schema，不碰 `public`。
規格：`docs/specs/2026-10-21-paper-trading-design.md`；計畫：`docs/superpowers/plans/2026-10-21-paper-trading-phase1.md`。

## 檔案

| 路徑 | 內容 |
|---|---|
| `functions/_shared/*.js` | 規則、報價、參考資料、下單、撮合、結算的純邏輯。Node 測試、Deno、瀏覽器共用 |
| `functions/_shared/db.ts` | Supabase 連線與 `Db` 介面實作 |
| `functions/sim-order` | 下單（POST）、即時五檔（GET `?quote=2330&session=lot`） |
| `functions/sim-admin` | 管理員入金、發邀請碼、列出帳戶 |
| `functions/sim-signup` | 用邀請碼註冊（不寄驗證信；Supabase 內建寄信只寄給專案成員） |
| `functions/sim-match` | 交易時段每分鐘撮合掛著的限價單（每次 6 輪、間隔 10 秒） |
| `functions/sim-settle` | 收盤結算：盤後零股、過期、除權息資格、發放股利 |
| `functions/sim-refdata` | 每天更新股票清單、休市日、除權息 |
| `sql/01_sim_schema.sql` | 資料表與 RLS |
| `sql/02_sim_ledger.sql` | 所有改錢的 plpgsql 函式 |
| `sql/03_sim_cron.sql` | pg_cron 排程 |
| `sql/tests/sim_test.sql` | 資料庫測試（`begin … rollback`，不留資料） |

## 測試

```bash
npm test                                   # JS 規則與流程（repo 根目錄）
sh supabase/sql/tests/run_local.sh         # 本機 PostgreSQL：模擬 Supabase 角色後跑 sim_test.sql
```

## 自動部署（建議）

`.github/workflows/deploy-sim.yml` 在合併到 main（改到 `supabase/`）時自動執行，也可以在 Actions → Deploy paper trading → Run workflow 手動跑。
它用 Supabase Management API 完成：執行 SQL 01→02→測試→03、Data API 開放 `sim` schema、登入 Redirect URL 加上網站、
部署 5 個 Edge Functions、設定管理員並開戶、觸發一次參考資料更新。每日建置（`daily.yml`）會自動把 anon key 寫進 `web/sim-config.js`。

只要設定 repo secrets（Settings → Secrets and variables → Actions → New repository secret）：

| Secret | 必填 | 值 |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | 是 | supabase.com/dashboard/account/tokens → Generate new token |
| `SIM_ADMIN_EMAIL` | 否 | 管理員的 email。這個帳號要先存在（在模擬交易頁註冊過，或 LifeMaster 用 email 登入過）；重跑 workflow 會把它標成已確認、設成管理員並開戶 100,000 元 |

本機也能跑同一支腳本：`SUPABASE_ACCESS_TOKEN=... python supabase/deploy.py sql schema auth admin refdata`。

## 手動部署步驟（不用 Actions 時）

1. **SQL**：Dashboard → SQL Editor 依序貼上執行 `01_sim_schema.sql`、`02_sim_ledger.sql`、`tests/sim_test.sql`（要看到 `ALL PASS`）、`03_sim_cron.sql`。
2. **開放 schema**：Dashboard → Project Settings → Data API → Exposed schemas 加上 `sim`（前端與 Edge Function 都靠 PostgREST 讀寫）。
3. **Edge Functions**（PowerShell，在 repo 根目錄）：
   ```
   npx supabase login
   npx supabase functions deploy sim-order sim-admin sim-match sim-settle sim-refdata --project-ref cvpcgqgpwelokwqltktd
   ```
   函式沿用 LifeMaster 已經設定的 `CRON_SECRET`，不用另外設 secrets。
4. **第一次更新參考資料**：Dashboard → SQL Editor 執行 `select private.sim_call('sim-refdata');`，過一分鐘確認
   `select count(*) from sim.securities` 約 1,900、`select count(*) from sim.holidays` 有今年的休市日。
5. **登入網址**：Authentication → URL Configuration → Redirect URLs 加上 `https://xu0903.github.io/tw-stock-signals/**`。
6. **設自己為管理員並開戶**（把 email 換成你的）：
   ```sql
   insert into sim.members (user_id, display_name, is_admin)
   select id, '管理員', true from auth.users where email = '你的 email'
   on conflict (user_id) do update set is_admin = true;
   insert into sim.invites (code) values ('ADMIN001');
   ```
   然後在網站「模擬交易」頁登入，輸入邀請碼 `ADMIN001`。
7. **前端設定**：`web/sim-config.js` 填入 anon key（和 LifeMaster `.env` 的 `VITE_SUPABASE_ANON_KEY` 相同，本來就是公開值）；有設 `SUPABASE_ACCESS_TOKEN` 的話每日建置會自動填。

## 待驗證（還沒連到真實資料測過）

- 測試用的 mis 與 OpenAPI 回應（`functions/_shared/fixtures/`）是依已知欄位格式手寫的。部署後請用真實回應比對：
  `TWT48U_ALL` 的 `StockDividendRatio` 程式當作「每股配幾股」（×10 換成每股配股金額）；櫃買 `tpex_exright_prepost` 的欄位名稱是猜的候選清單。
- 盤後零股在 14:30 後 `getOddInfo` 回傳的 `z` 是否為盤後成交價；程式會檢查報價時間要在 14:30 之後才拿來撮合，否則 14:45 那次就讓委託過期。
- 有報導說盤中零股首次撮合時間會在 2026-12-07 調整，改 `rules.js` 的 `SESSION_TIMES.ODD_MATCH_START`。

## 已驗證

（上線實測後補上）
