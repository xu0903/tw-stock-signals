-- 模擬交易：schema、資料表、RLS。在 Supabase SQL Editor 依序執行 01 → 02 → 03。
-- 可以重複執行（create if not exists / drop policy if exists）。

create schema if not exists sim;
grant usage on schema sim to authenticated, service_role;

create table if not exists sim.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists sim.invites (
  code text primary key,
  created_by uuid references auth.users(id) on delete set null,
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists sim.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'normal' check (kind in ('normal', 'tutorial')),
  cash bigint not null default 0 check (cash >= 0),
  reserved bigint not null default 0 check (reserved >= 0),
  fee_overrides jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, kind),
  check (reserved <= cash)
);

create table if not exists sim.securities (
  symbol text primary key,
  name text not null,
  market text not null check (market in ('tse', 'otc')),
  kind text not null check (kind in ('stock', 'etf', 'bond_etf')),
  updated_at timestamptz not null default now()
);

create table if not exists sim.holidays (date date primary key, name text);

create table if not exists sim.corp_actions (
  symbol text not null,
  ex_date date not null,
  cash_per_share numeric not null default 0,
  stock_per_share numeric not null default 0,
  pay_date date not null,
  pay_date_estimated boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (symbol, ex_date)
);

create table if not exists sim.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references sim.accounts(id) on delete cascade,
  symbol text not null,
  session text not null check (session in ('lot', 'odd', 'odd_after')),
  side text not null check (side in ('buy', 'sell')),
  price_type text not null check (price_type in ('market', 'limit')),
  limit_price numeric,
  qty int not null check (qty > 0),
  filled_qty int not null default 0 check (filled_qty >= 0),
  avg_price numeric,
  fee_charged bigint not null default 0,
  tax_charged bigint not null default 0,
  reserved bigint not null default 0 check (reserved >= 0),
  status text not null default 'open' check (status in ('open', 'filled', 'partial', 'cancelled', 'expired', 'rejected')),
  reject_reason text,
  trade_date date not null,
  created_at timestamptz not null default now(),
  check (filled_qty <= qty),
  check (price_type = 'market' or limit_price > 0)
);
create index if not exists orders_open_idx on sim.orders (status, trade_date) where status in ('open', 'partial');
create index if not exists orders_account_idx on sim.orders (account_id, created_at desc);

create table if not exists sim.fills (
  id bigserial primary key,
  order_id uuid not null references sim.orders(id) on delete cascade,
  price numeric not null check (price > 0),
  qty int not null check (qty > 0),
  at timestamptz not null default now()
);
create index if not exists fills_order_idx on sim.fills (order_id);

create table if not exists sim.positions (
  account_id uuid not null references sim.accounts(id) on delete cascade,
  symbol text not null,
  qty int not null check (qty >= 0),
  cost bigint not null check (cost >= 0),   -- 含買進手續費
  primary key (account_id, symbol)
);

create table if not exists sim.ledger (
  id bigserial primary key,
  account_id uuid not null references sim.accounts(id) on delete cascade,
  at timestamptz not null default now(),
  amount bigint not null,
  cash_after bigint not null,
  code text not null check (code in ('ADMIN_DEPOSIT', 'OPEN_GRANT', 'BUY', 'SELL', 'FEE', 'TAX', 'DIVIDEND',
    'NHI_PREMIUM', 'STOCK_DIVIDEND', 'STOCK_DIVIDEND_CASH_IN_LIEU')),
  ref text,
  explain jsonb not null default '{}'
);
create index if not exists ledger_account_idx on sim.ledger (account_id, id desc);

create table if not exists sim.entitlements (
  account_id uuid not null references sim.accounts(id) on delete cascade,
  symbol text not null,
  ex_date date not null,
  shares int not null check (shares > 0),
  paid boolean not null default false,
  primary key (account_id, symbol, ex_date)
);

-- ---------- 權限：前端只能讀自己的資料，所有寫入都走 02 的函式 ----------

revoke all on all tables in schema sim from public, anon, authenticated;
grant select on all tables in schema sim to authenticated;
grant all on all tables in schema sim to service_role;
grant usage, select on all sequences in schema sim to service_role;

alter table sim.members enable row level security;
alter table sim.invites enable row level security;
alter table sim.accounts enable row level security;
alter table sim.securities enable row level security;
alter table sim.holidays enable row level security;
alter table sim.corp_actions enable row level security;
alter table sim.orders enable row level security;
alter table sim.fills enable row level security;
alter table sim.positions enable row level security;
alter table sim.ledger enable row level security;
alter table sim.entitlements enable row level security;

drop policy if exists own on sim.members;
create policy own on sim.members for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists own on sim.accounts;
create policy own on sim.accounts for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists own on sim.orders;
create policy own on sim.orders for select to authenticated
  using (account_id in (select id from sim.accounts where user_id = (select auth.uid())));
drop policy if exists own on sim.fills;
create policy own on sim.fills for select to authenticated
  using (order_id in (select o.id from sim.orders o join sim.accounts a on a.id = o.account_id where a.user_id = (select auth.uid())));
drop policy if exists own on sim.positions;
create policy own on sim.positions for select to authenticated
  using (account_id in (select id from sim.accounts where user_id = (select auth.uid())));
drop policy if exists own on sim.ledger;
create policy own on sim.ledger for select to authenticated
  using (account_id in (select id from sim.accounts where user_id = (select auth.uid())));
drop policy if exists own on sim.entitlements;
create policy own on sim.entitlements for select to authenticated
  using (account_id in (select id from sim.accounts where user_id = (select auth.uid())));
-- invites 不開放直接讀；參考資料登入者都能讀
drop policy if exists read on sim.securities;
create policy read on sim.securities for select to authenticated using (true);
drop policy if exists read on sim.holidays;
create policy read on sim.holidays for select to authenticated using (true);
drop policy if exists read on sim.corp_actions;
create policy read on sim.corp_actions for select to authenticated using (true);
