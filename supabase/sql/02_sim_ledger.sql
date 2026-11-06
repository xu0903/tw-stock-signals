-- 模擬交易：所有會改動現金、持股、對帳單的函式。
-- 規則：每個函式先 `for update` 鎖帳戶列，再改資料；現金永不為負（資料表也有 check）。
-- 標「service role」的只給 Edge Function 呼叫；其他由登入者呼叫，函式內自己驗證 auth.uid()。

-- ---------- 內部工具 ----------

-- 記一筆對帳單並同步改現金（呼叫者必須已鎖住帳戶列）
create or replace function sim._post(p_account uuid, p_amount bigint, p_code text, p_ref text, p_explain jsonb)
returns bigint language plpgsql security definer set search_path = sim, public as $$
declare v_cash bigint;
begin
  update sim.accounts set cash = cash + p_amount where id = p_account returning cash into v_cash;
  if v_cash is null then raise exception '查無帳戶'; end if;
  if v_cash < 0 then raise exception '現金不足'; end if;
  insert into sim.ledger (account_id, amount, cash_after, code, ref, explain)
  values (p_account, p_amount, v_cash, p_code, p_ref, coalesce(p_explain, '{}'));
  return v_cash;
end $$;

create or replace function sim._is_admin() returns boolean
language sql stable security definer set search_path = sim, public as $$
  select coalesce((select is_admin from sim.members where user_id = auth.uid()), false) $$;

-- ---------- 開戶、管理員 ----------

create or replace function sim.redeem_invite(p_code text, p_name text)
returns uuid language plpgsql security definer set search_path = sim, public as $$
declare
  v_uid uuid := auth.uid();
  v_inv sim.invites;
  v_acc uuid;
begin
  if v_uid is null then raise exception '請先登入'; end if;
  if coalesce((select is_anonymous from auth.users where id = v_uid), true) then
    raise exception '匿名帳號不能開戶，請用 email 登入';
  end if;
  if exists (select 1 from sim.accounts where user_id = v_uid and kind = 'normal') then
    raise exception '你已經有模擬帳戶了';
  end if;
  select * into v_inv from sim.invites where code = upper(trim(p_code)) for update;
  if not found then raise exception '邀請碼不存在'; end if;
  if v_inv.used_by is not null then raise exception '邀請碼已經被使用過了'; end if;

  insert into sim.members (user_id, display_name) values (v_uid, left(coalesce(trim(p_name), ''), 30))
  on conflict (user_id) do update set display_name = coalesce(nullif(excluded.display_name, ''), sim.members.display_name);
  insert into sim.accounts (user_id, kind, cash) values (v_uid, 'normal', 0) returning id into v_acc;
  perform 1 from sim.accounts where id = v_acc for update;
  perform sim._post(v_acc, 100000, 'OPEN_GRANT', v_inv.code, jsonb_build_object('note', '開戶贈送', 'invite', v_inv.code));
  update sim.invites set used_by = v_uid, used_at = now() where code = v_inv.code;
  return v_acc;
end $$;

create or replace function sim.admin_create_invite()
returns text language plpgsql security definer set search_path = sim, public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- 去掉容易看錯的 0 O 1 I
  v_code text;
  b bytea;
begin
  if not sim._is_admin() then raise exception '只有管理員可以發邀請碼'; end if;
  loop
    b := uuid_send(gen_random_uuid());
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from sim.invites where code = v_code);
  end loop;
  insert into sim.invites (code, created_by) values (v_code, auth.uid());
  return v_code;
end $$;

create or replace function sim.admin_deposit(p_account uuid, p_amount bigint, p_note text)
returns bigint language plpgsql security definer set search_path = sim, public as $$
begin
  if not sim._is_admin() then raise exception '只有管理員可以入金'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '入金金額要大於 0'; end if;
  perform 1 from sim.accounts where id = p_account for update;
  if not found then raise exception '查無帳戶'; end if;
  return sim._post(p_account, p_amount, 'ADMIN_DEPOSIT', null,
    jsonb_build_object('note', coalesce(p_note, ''), 'by', auth.uid()));
end $$;

create or replace function sim.admin_list_accounts()
returns table (account_id uuid, user_id uuid, display_name text, email text, kind text, cash bigint, reserved bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = sim, public as $$
begin
  if not sim._is_admin() then raise exception '只有管理員可以查看所有帳戶'; end if;
  return query
    select a.id, a.user_id, coalesce(m.display_name, ''), u.email::text, a.kind, a.cash, a.reserved, a.created_at
    from sim.accounts a left join sim.members m on m.user_id = a.user_id left join auth.users u on u.id = a.user_id
    order by a.created_at;
end $$;

create or replace function sim.set_fee_overrides(p_account uuid, p_overrides jsonb)
returns void language plpgsql security definer set search_path = sim, public as $$
declare
  allowed constant text[] := array['commissionRate', 'discount', 'minFee', 'minFeeOdd', 'marginRate',
    'shortFeeRate', 'shortRebateRate', 'borrowDailyRate', 'nhiRate', 'nhiThreshold'];
  k text; v jsonb;
begin
  if not exists (select 1 from sim.accounts where id = p_account and user_id = auth.uid()) then
    raise exception '只能修改自己的帳戶';
  end if;
  if p_overrides is not null and p_overrides <> '{}'::jsonb then
    if jsonb_typeof(p_overrides) <> 'object' then raise exception '費率設定格式錯誤'; end if;
    for k, v in select * from jsonb_each(p_overrides) loop
      if not (k = any (allowed)) then raise exception '不認得的費率項目：%', k; end if;
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 then raise exception '% 必須是不小於 0 的數字', k; end if;
    end loop;
  end if;
  update sim.accounts set fee_overrides = nullif(p_overrides, '{}'::jsonb) where id = p_account;
end $$;

-- ---------- 下單、成交、取消（service role） ----------

create or replace function sim.place_order(p_account uuid, p_symbol text, p_session text, p_side text,
  p_price_type text, p_limit numeric, p_qty int, p_reserve bigint, p_trade_date date)
returns uuid language plpgsql security definer set search_path = sim, public as $$
declare
  a sim.accounts;
  v_hold int;
  v_pending int;
  v_id uuid;
begin
  select * into a from sim.accounts where id = p_account for update;
  if not found then raise exception '查無帳戶'; end if;
  if p_qty is null or p_qty <= 0 then raise exception '數量要大於 0'; end if;
  if p_side = 'buy' then
    if p_reserve is null or p_reserve <= 0 then raise exception '圈存金額錯誤'; end if;
    if a.cash - a.reserved < p_reserve then
      raise exception '可用現金不足：需要圈存 % 元，可用 % 元', p_reserve, a.cash - a.reserved;
    end if;
  elsif p_side = 'sell' then
    select coalesce((select qty from sim.positions where account_id = p_account and symbol = p_symbol), 0) into v_hold;
    select coalesce(sum(qty - filled_qty), 0) into v_pending from sim.orders
      where account_id = p_account and symbol = p_symbol and side = 'sell' and status in ('open', 'partial');
    if v_hold - v_pending < p_qty then
      raise exception '可賣股數不足：持股 % 股，掛單中 % 股，可賣 % 股', v_hold, v_pending, v_hold - v_pending;
    end if;
  else
    raise exception '買賣別錯誤';
  end if;

  insert into sim.orders (account_id, symbol, session, side, price_type, limit_price, qty, reserved, trade_date)
  values (p_account, p_symbol, p_session, p_side, p_price_type,
          case when p_price_type = 'limit' then p_limit end, p_qty,
          case when p_side = 'buy' then p_reserve else 0 end, p_trade_date)
  returning id into v_id;
  if p_side = 'buy' then
    update sim.accounts set reserved = reserved + p_reserve where id = p_account;
  end if;
  return v_id;
end $$;

-- p_fills: [{price, qty}]；p_fee_total：這張單「累計」應收手續費；p_tax：這批成交的證交稅
create or replace function sim.apply_fills(p_order uuid, p_fills jsonb, p_fee_total bigint, p_tax bigint, p_explain jsonb)
returns void language plpgsql security definer set search_path = sim, public as $$
declare
  o sim.orders;
  a sim.accounts;
  p sim.positions;
  v_qty int;
  v_exact numeric;
  v_amount bigint;
  v_fee bigint;
  v_tax bigint := coalesce(p_tax, 0);
  v_remaining int;
  v_release bigint;
  v_cost bigint;
  v_base jsonb;
begin
  select account_id into a.id from sim.orders where id = p_order;
  if a.id is null then raise exception '查無委託'; end if;
  select * into a from sim.accounts where id = a.id for update;
  select * into o from sim.orders where id = p_order for update;
  if o.status not in ('open', 'partial') then raise exception '委託已結束（%），不能再成交', o.status; end if;
  if jsonb_typeof(p_fills) <> 'array' then raise exception 'fills 格式錯誤'; end if;
  if exists (select 1 from jsonb_array_elements(p_fills) x
             where coalesce((x->>'qty')::int, 0) <= 0 or coalesce((x->>'price')::numeric, 0) <= 0) then
    raise exception '成交價量錯誤';
  end if;
  select coalesce(sum((x->>'qty')::int), 0), coalesce(sum((x->>'price')::numeric * (x->>'qty')::int), 0)
    into v_qty, v_exact from jsonb_array_elements(p_fills) x;
  if v_qty = 0 then return; end if;
  v_amount := round(v_exact);
  v_remaining := o.qty - o.filled_qty;
  if v_qty > v_remaining then raise exception '成交股數超過委託剩餘股數'; end if;
  v_fee := greatest(coalesce(p_fee_total, 0) - o.fee_charged, 0);
  v_base := coalesce(p_explain, '{}') || jsonb_build_object('order', o.id, 'symbol', o.symbol, 'session', o.session,
    'qty', v_qty, 'fills', p_fills, 'amount', v_amount);

  if o.side = 'buy' then
    -- 依比例釋放圈存；實際花費比比例多（例如最低手續費）就多釋放，全部成交時全部釋放
    v_release := case when v_qty = v_remaining then o.reserved
                      else least(o.reserved, greatest((o.reserved * v_qty) / v_remaining, v_amount + v_fee)) end;
    if a.cash - (v_amount + v_fee) < a.reserved - v_release then raise exception '可用現金不足'; end if;
    update sim.accounts set reserved = reserved - v_release where id = a.id;
    perform sim._post(a.id, -v_amount, 'BUY', o.id::text, v_base);
    if v_fee > 0 then
      perform sim._post(a.id, -v_fee, 'FEE', o.id::text, v_base || jsonb_build_object('fee_total', p_fee_total, 'fee_before', o.fee_charged));
    end if;
    insert into sim.positions (account_id, symbol, qty, cost) values (a.id, o.symbol, v_qty, v_amount + v_fee)
    on conflict (account_id, symbol) do update set qty = sim.positions.qty + excluded.qty, cost = sim.positions.cost + excluded.cost;
  else
    select * into p from sim.positions where account_id = a.id and symbol = o.symbol for update;
    if not found or p.qty < v_qty then raise exception '持股不足'; end if;
    v_release := 0;
    v_cost := case when p.qty = v_qty then p.cost else round(p.cost::numeric * v_qty / p.qty) end;
    perform sim._post(a.id, v_amount, 'SELL', o.id::text,
      v_base || jsonb_build_object('cost', v_cost, 'realized', v_amount - v_fee - v_tax - v_cost));
    if v_fee > 0 then
      perform sim._post(a.id, -v_fee, 'FEE', o.id::text, v_base || jsonb_build_object('fee_total', p_fee_total, 'fee_before', o.fee_charged));
    end if;
    if v_tax > 0 then
      perform sim._post(a.id, -v_tax, 'TAX', o.id::text, v_base);
    end if;
    if p.qty = v_qty then
      delete from sim.positions where account_id = a.id and symbol = o.symbol;
    else
      update sim.positions set qty = qty - v_qty, cost = cost - v_cost where account_id = a.id and symbol = o.symbol;
    end if;
  end if;

  insert into sim.fills (order_id, price, qty) select o.id, (x->>'price')::numeric, (x->>'qty')::int from jsonb_array_elements(p_fills) x;
  update sim.orders set
    filled_qty = filled_qty + v_qty,
    avg_price = round((coalesce(avg_price, 0) * filled_qty + v_exact) / (filled_qty + v_qty), 4),
    fee_charged = fee_charged + v_fee,
    tax_charged = tax_charged + v_tax,
    reserved = reserved - v_release,
    status = case when filled_qty + v_qty = qty then 'filled' else 'partial' end
  where id = o.id;
end $$;

-- 取消或過期：釋放剩餘圈存。已結束的單直接忽略（可重複執行）
create or replace function sim.close_order(p_order uuid, p_status text)
returns boolean language plpgsql security definer set search_path = sim, public as $$
declare o sim.orders; v_acc uuid;
begin
  if p_status not in ('cancelled', 'expired', 'rejected') then raise exception '狀態錯誤'; end if;
  select account_id into v_acc from sim.orders where id = p_order;
  if v_acc is null then raise exception '查無委託'; end if;
  perform 1 from sim.accounts where id = v_acc for update;
  select * into o from sim.orders where id = p_order for update;
  if o.status not in ('open', 'partial') then return false; end if;
  update sim.accounts set reserved = reserved - o.reserved where id = v_acc;
  update sim.orders set status = p_status, reserved = 0 where id = p_order;
  return true;
end $$;

create or replace function sim.cancel_my_order(p_order uuid)
returns boolean language plpgsql security definer set search_path = sim, public as $$
begin
  if not exists (select 1 from sim.orders o join sim.accounts a on a.id = o.account_id
                 where o.id = p_order and a.user_id = auth.uid()) then
    raise exception '查無這筆委託';
  end if;
  if not exists (select 1 from sim.orders where id = p_order and status in ('open', 'partial')) then
    raise exception '這筆委託已經結束，不能取消';
  end if;
  return sim.close_order(p_order, 'cancelled');
end $$;

-- ---------- 除權息（service role） ----------

-- 在除權息日前一個交易日收盤後執行：記下當時的持股
create or replace function sim.snapshot_entitlements(p_ex_date date)
returns int language plpgsql security definer set search_path = sim, public as $$
declare n int;
begin
  insert into sim.entitlements (account_id, symbol, ex_date, shares)
  select p.account_id, p.symbol, c.ex_date, p.qty
  from sim.positions p join sim.corp_actions c on c.symbol = p.symbol and c.ex_date = p_ex_date
  where p.qty > 0
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function sim.pay_entitlement(p_account uuid, p_symbol text, p_ex_date date,
  p_cash bigint, p_nhi bigint, p_shares int, p_cash_in_lieu bigint, p_explain jsonb)
returns boolean language plpgsql security definer set search_path = sim, public as $$
declare e sim.entitlements; v_ex jsonb := coalesce(p_explain, '{}') || jsonb_build_object('symbol', p_symbol, 'ex_date', p_ex_date);
begin
  perform 1 from sim.accounts where id = p_account for update;
  if not found then raise exception '查無帳戶'; end if;
  select * into e from sim.entitlements where account_id = p_account and symbol = p_symbol and ex_date = p_ex_date for update;
  if not found then raise exception '查無配發資格'; end if;
  if e.paid then return false; end if;
  if coalesce(p_cash, 0) > 0 then perform sim._post(p_account, p_cash, 'DIVIDEND', p_symbol, v_ex); end if;
  if coalesce(p_nhi, 0) > 0 then perform sim._post(p_account, -p_nhi, 'NHI_PREMIUM', p_symbol, v_ex); end if;
  if coalesce(p_shares, 0) > 0 then
    perform sim._post(p_account, 0, 'STOCK_DIVIDEND', p_symbol, v_ex || jsonb_build_object('new_shares', p_shares));
    insert into sim.positions (account_id, symbol, qty, cost) values (p_account, p_symbol, p_shares, 0)
    on conflict (account_id, symbol) do update set qty = sim.positions.qty + excluded.qty;
  end if;
  if coalesce(p_cash_in_lieu, 0) > 0 then perform sim._post(p_account, p_cash_in_lieu, 'STOCK_DIVIDEND_CASH_IN_LIEU', p_symbol, v_ex); end if;
  update sim.entitlements set paid = true where account_id = p_account and symbol = p_symbol and ex_date = p_ex_date;
  return true;
end $$;

-- ---------- 執行權限 ----------

revoke all on all functions in schema sim from public, anon, authenticated;
grant execute on function sim.redeem_invite(text, text), sim.admin_create_invite(), sim.admin_deposit(uuid, bigint, text),
  sim.admin_list_accounts(), sim.set_fee_overrides(uuid, jsonb), sim.cancel_my_order(uuid) to authenticated;
grant execute on all functions in schema sim to service_role;
