-- 模擬交易資料庫測試。整段在交易裡跑，最後 rollback，不會留下資料。
-- Supabase：SQL Editor 貼上執行（需先套用 01、02）。本機：先跑 00_local_supabase_stub.sql。
-- 成功會看到 NOTICE: ALL PASS；任何一項失敗會 raise exception 並中止。
begin;

insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test', false),
  ('00000000-0000-0000-0000-00000000000b', 'b@test', false),
  ('00000000-0000-0000-0000-00000000000c', null, true),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@test', false);
insert into sim.members (user_id, display_name, is_admin) values ('00000000-0000-0000-0000-0000000000ad', 'admin', true);
insert into sim.invites (code) values ('TESTAAAA'), ('TESTBBBB'), ('TESTCCCC');
create temp table t_acc (who text primary key, id uuid) on commit drop;
grant all on t_acc to authenticated;

-- 以某個使用者身分呼叫
create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true); end $$;

-- test_redeem_invite
do $$
declare v uuid; ok boolean;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  v := sim.redeem_invite('testaaaa', 'A');
  insert into t_acc values ('a', v);
  if (select cash from sim.accounts where id = v) <> 100000 then raise exception 'redeem: cash'; end if;
  if (select count(*) from sim.ledger where account_id = v and code = 'OPEN_GRANT') <> 1 then raise exception 'redeem: ledger'; end if;
  ok := false; begin perform sim.redeem_invite('TESTBBBB', 'A again'); exception when others then ok := true; end;
  if not ok then raise exception 'redeem: second account allowed'; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  ok := false; begin perform sim.redeem_invite('TESTAAAA', 'B'); exception when others then ok := sqlerrm like '%已經被使用%'; end;
  if not ok then raise exception 'redeem: invite reused'; end if;
  insert into t_acc values ('b', sim.redeem_invite('TESTBBBB', 'B'));

  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  ok := false; begin perform sim.redeem_invite('TESTCCCC', 'anon'); exception when others then ok := sqlerrm like '%匿名%'; end;
  if not ok then raise exception 'redeem: anonymous allowed'; end if;
  raise notice 'pass test_redeem_invite';
end $$;

-- test_admin_only_deposit + invite
do $$
declare ok boolean; v_code text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  ok := false; begin perform sim.admin_deposit((select id from t_acc where who = 'b'), 1000, 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'deposit: non-admin allowed'; end if;
  ok := false; begin perform sim.admin_create_invite(); exception when others then ok := true; end;
  if not ok then raise exception 'invite: non-admin allowed'; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000ad');
  perform sim.admin_deposit((select id from t_acc where who = 'b'), 5000, '測試入金');
  if (select cash from sim.accounts where id = (select id from t_acc where who = 'b')) <> 105000 then raise exception 'deposit: cash'; end if;
  v_code := sim.admin_create_invite();
  if v_code !~ '^[A-Z2-9]{8}$' then raise exception 'invite: format %', v_code; end if;
  if (select count(*) from sim.admin_list_accounts() l join t_acc t on t.id = l.account_id) <> 2 then raise exception 'admin_list_accounts'; end if;
  raise notice 'pass test_admin_only_deposit';
end $$;

-- test_rls_isolation：以 authenticated 角色、B 的身分查不到 A 的資料，也不能直接寫入
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
set local role authenticated;
do $$
declare ok boolean;
begin
  if (select count(*) from sim.accounts) <> 1 then raise exception 'rls: accounts visible %', (select count(*) from sim.accounts); end if;
  if exists (select 1 from sim.ledger where account_id = (select id from t_acc where who = 'a')) then raise exception 'rls: ledger leak'; end if;
  if (select count(*) from sim.ledger) <> 2 then raise exception 'rls: own ledger'; end if;
  ok := false; begin update sim.accounts set cash = 9999999; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'rls: direct update allowed'; end if;
  ok := false; begin perform sim.place_order((select id from t_acc where who = 'b'), '2330', 'lot', 'buy', 'limit', 100, 1000, 1, current_date); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'rls: place_order callable by authenticated'; end if;
  ok := false; begin perform sim.admin_deposit((select id from t_acc where who = 'b'), 1, 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'rls: deposit by user'; end if;
  raise notice 'pass test_rls_isolation';
end $$;
reset role;

-- test_concurrent_reserve：可用 100000，第一筆圈 60000 成功、第二筆 60000 失敗
do $$
declare a uuid := (select id from t_acc where who = 'a'); o1 uuid; ok boolean;
begin
  o1 := sim.place_order(a, '1101', 'lot', 'buy', 'limit', 50, 1000, 60000, current_date);
  ok := false; begin perform sim.place_order(a, '1101', 'lot', 'buy', 'limit', 50, 1000, 60000, current_date); exception when others then ok := sqlerrm like '%可用現金不足%'; end;
  if not ok then raise exception 'reserve: second order accepted'; end if;
  if (select reserved from sim.accounts where id = a) <> 60000 then raise exception 'reserve: reserved'; end if;
  -- 取消 → 圈存退回；再取消一次不會重複退
  perform sim.close_order(o1, 'cancelled');
  if sim.close_order(o1, 'cancelled') then raise exception 'close: not idempotent'; end if;
  if (select reserved from sim.accounts where id = a) <> 0 then raise exception 'reserve: release'; end if;
  raise notice 'pass test_concurrent_reserve';
end $$;

-- test_apply_fills_buy_sell：先入金到 200000；買 1000 股 @100（手續費 143），再以 110 全部賣出（手續費 157、稅 330）
select pg_temp.as_user('00000000-0000-0000-0000-0000000000ad');
select sim.admin_deposit((select id from t_acc where who = 'a'), 100000, '測試');
do $$
declare a uuid := (select id from t_acc where who = 'a'); o uuid; s uuid; c bigint; ok boolean;
begin
  o := sim.place_order(a, '1101', 'lot', 'buy', 'limit', 100, 1000, 100143, current_date);
  perform sim.apply_fills(o, '[{"price":100,"qty":1000}]', 143, 0, '{}');
  select cash into c from sim.accounts where id = a;
  if c <> 200000 - 100000 - 143 then raise exception 'buy: cash %', c; end if;
  if (select reserved from sim.accounts where id = a) <> 0 then raise exception 'buy: reserved'; end if;
  if (select qty || '/' || cost from sim.positions where account_id = a and symbol = '1101') <> '1000/100143' then raise exception 'buy: position'; end if;
  if (select status from sim.orders where id = o) <> 'filled' then raise exception 'buy: status'; end if;
  ok := false; begin perform sim.apply_fills(o, '[{"price":100,"qty":1}]', 143, 0, '{}'); exception when others then ok := true; end;
  if not ok then raise exception 'buy: fill after filled'; end if;

  s := sim.place_order(a, '1101', 'lot', 'sell', 'limit', 110, 1000, 0, current_date);
  perform sim.apply_fills(s, '[{"price":110,"qty":1000}]', 157, 330, '{}');
  select cash into c from sim.accounts where id = a;
  if c <> 99857 + 110000 - 157 - 330 then raise exception 'sell: cash %', c; end if;
  if exists (select 1 from sim.positions where account_id = a and symbol = '1101') then raise exception 'sell: position not cleared'; end if;
  if (select (explain->>'realized')::bigint from sim.ledger where account_id = a and code = 'SELL') <> 110000 - 157 - 330 - 100143 then raise exception 'sell: realized'; end if;
  -- OPEN_GRANT, ADMIN_DEPOSIT, BUY, FEE, SELL, FEE, TAX
  if (select count(*) from sim.ledger where account_id = a) <> 7 then raise exception 'ledger count %', (select count(*) from sim.ledger where account_id = a); end if;
  if (select cash_after from sim.ledger where account_id = a order by id desc limit 1) <> c then raise exception 'ledger cash_after'; end if;
  if exists (select 1 from sim.ledger where account_id = a and explain = '{}'::jsonb) then raise exception 'ledger explain empty'; end if;
  raise notice 'pass test_apply_fills_buy_sell';
end $$;

-- test_sell_exceeds_available：持股 1000、已有 600 股賣單掛著，再賣 500 失敗、賣 400 成功
do $$
declare a uuid := (select id from t_acc where who = 'a'); ok boolean;
begin
  insert into sim.positions values (a, '2330', 1000, 2000000);
  perform sim.place_order(a, '2330', 'odd', 'sell', 'limit', 2500, 600, 0, current_date);
  ok := false; begin perform sim.place_order(a, '2330', 'odd', 'sell', 'limit', 2500, 500, 0, current_date); exception when others then ok := sqlerrm like '%可賣股數不足%'; end;
  if not ok then raise exception 'sell: exceeds available accepted'; end if;
  perform sim.place_order(a, '2330', 'odd', 'sell', 'limit', 2500, 400, 0, current_date);
  raise notice 'pass test_sell_exceeds_available';
end $$;

-- test_fee_delta：同一張單分兩次成交；第一次 10 股 @100 收最低 20 元，累計到 300 股 @100 = 30000 → 43 元，只補 23
do $$
declare b uuid := (select id from t_acc where who = 'b'); o uuid; c0 bigint; r0 bigint;
begin
  select cash into c0 from sim.accounts where id = b;
  o := sim.place_order(b, '2884', 'odd', 'buy', 'limit', 100, 300, 30043, current_date);
  perform sim.apply_fills(o, '[{"price":100,"qty":10}]', 20, 0, '{}');
  if (select fee_charged || '/' || status from sim.orders where id = o) <> '20/partial' then raise exception 'fee_delta: first'; end if;
  select reserved into r0 from sim.accounts where id = b;
  if r0 <> 30043 - 1020 then raise exception 'fee_delta: release covers actual cost, got %', r0; end if;
  perform sim.apply_fills(o, '[{"price":99.5,"qty":290}]', 43, 0, '{}');
  if (select fee_charged || '/' || status || '/' || reserved from sim.orders where id = o) <> '43/filled/0' then raise exception 'fee_delta: second'; end if;
  if (select cash from sim.accounts where id = b) <> c0 - 1000 - 28855 - 43 then raise exception 'fee_delta: cash %', (select cash from sim.accounts where id = b); end if;
  if (select reserved from sim.accounts where id = b) <> 0 then raise exception 'fee_delta: reserved left'; end if;
  if (select avg_price from sim.orders where id = o) <> round((1000 + 28855)::numeric / 300, 4) then raise exception 'fee_delta: avg'; end if;
  raise notice 'pass test_fee_delta';
end $$;

-- test_cancel_my_order：B 不能取消 A 的單
do $$
declare a uuid := (select id from t_acc where who = 'a'); o uuid; ok boolean;
begin
  o := (select id from sim.orders where account_id = a and status = 'open' limit 1);
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  ok := false; begin perform sim.cancel_my_order(o); exception when others then ok := true; end;
  if not ok then raise exception 'cancel: other user allowed'; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  if not sim.cancel_my_order(o) then raise exception 'cancel: own failed'; end if;
  raise notice 'pass test_cancel_my_order';
end $$;

-- test_fee_overrides
do $$
declare a uuid := (select id from t_acc where who = 'a'); ok boolean;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  perform sim.set_fee_overrides(a, '{"discount":0.28}');
  if (select fee_overrides->>'discount' from sim.accounts where id = a) <> '0.28' then raise exception 'fees: set'; end if;
  ok := false; begin perform sim.set_fee_overrides(a, '{"hack":1}'); exception when others then ok := true; end;
  if not ok then raise exception 'fees: unknown key'; end if;
  ok := false; begin perform sim.set_fee_overrides((select id from t_acc where who = 'b'), '{"discount":0}'); exception when others then ok := true; end;
  if not ok then raise exception 'fees: other account'; end if;
  perform sim.set_fee_overrides(a, '{}');
  if (select fee_overrides from sim.accounts where id = a) is not null then raise exception 'fees: clear'; end if;
  raise notice 'pass test_fee_overrides';
end $$;

-- test_entitlements：除權息前一天持有 3000 股 → 快照；發放現金 21000、補充保費 443；配股 7 股、零股折現 5 元；不重複發放
do $$
declare b uuid := (select id from t_acc where who = 'b'); c0 bigint;
begin
  insert into sim.positions values (b, 'T9999', 3000, 360000);
  insert into sim.corp_actions (symbol, ex_date, cash_per_share, stock_per_share, pay_date) values ('T9999', '2026-12-16', 7, 0, '2027-01-15');
  if sim.snapshot_entitlements('2026-12-16') <> 1 then raise exception 'ent: snapshot'; end if;
  if sim.snapshot_entitlements('2026-12-16') <> 0 then raise exception 'ent: snapshot twice'; end if;
  select cash into c0 from sim.accounts where id = b;
  if not sim.pay_entitlement(b, 'T9999', '2026-12-16', 21000, 443, 7, 5, '{"pay_date_estimated":true}') then raise exception 'ent: pay'; end if;
  if sim.pay_entitlement(b, 'T9999', '2026-12-16', 21000, 443, 7, 5, '{}') then raise exception 'ent: paid twice'; end if;
  if (select cash from sim.accounts where id = b) <> c0 + 21000 - 443 + 5 then raise exception 'ent: cash'; end if;
  if (select qty from sim.positions where account_id = b and symbol = 'T9999') <> 3007 then raise exception 'ent: shares'; end if;
  raise notice 'pass test_entitlements';
end $$;

do $$ begin raise notice 'ALL PASS'; end $$;
rollback;
