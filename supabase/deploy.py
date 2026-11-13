#!/usr/bin/env python3
"""模擬交易自動部署（GitHub Actions 用，也可以在本機跑）。只需要 SUPABASE_ACCESS_TOKEN。

步驟（每一步都可以重複執行）：
  sql        依序執行 01、02、tests/sim_test.sql（失敗就中止）、03
  schema     Data API 開放 sim schema
  auth       登入 Redirect URLs 加上網站網址
  admin      SIM_ADMIN_EMAIL 有設、且那個 email 已經註冊 → 設成管理員並開戶
  refdata    觸發一次參考資料更新（股票清單、休市日、除權息）
  anon-key   把 anon key 寫進 web/sim-config.js（建置網站時用，不會 commit）

用法：python supabase/deploy.py sql schema auth admin refdata
Edge Functions 的部署用 supabase CLI（見 .github/workflows/deploy-sim.yml）。
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "supabase" / "sql"
REF = os.environ.get("SUPABASE_PROJECT_REF", "cvpcgqgpwelokwqltktd")
API = os.environ.get("SUPABASE_API", "https://api.supabase.com")
SITE = "https://xu0903.github.io/tw-stock-signals/**"


def call(method: str, path: str, body=None):
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        sys.exit("[中止] 沒有 SUPABASE_ACCESS_TOKEN")
    req = urllib.request.Request(
        f"{API}/v1/projects/{REF}{path}", method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": "tw-stock-signals-deploy"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode() or "null"
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} → HTTP {e.code}: {e.read().decode()[:2000]}") from None
    return json.loads(raw)


def query(sql: str):
    return call("POST", "/database/query", {"query": sql})


def step_sql():
    for f in ["01_sim_schema.sql", "02_sim_ledger.sql", "tests/sim_test.sql", "03_sim_cron.sql"]:
        print(f"[sql] {f}")
        query((SQL / f).read_text(encoding="utf-8"))
    print("[sql] 完成（sim_test.sql 沒有報錯 = ALL PASS）")


def step_schema():
    cfg = call("GET", "/postgrest")
    schemas = [s.strip() for s in (cfg.get("db_schema") or "public").split(",") if s.strip()]
    if "sim" in schemas:
        print(f"[schema] 已開放：{','.join(schemas)}")
        return
    schemas.append("sim")
    call("PATCH", "/postgrest", {"db_schema": ",".join(schemas)})
    print(f"[schema] 改成：{','.join(schemas)}")


def step_auth():
    cfg = call("GET", "/config/auth")
    urls = [u.strip() for u in (cfg.get("uri_allow_list") or "").split(",") if u.strip()]
    if SITE in urls:
        print("[auth] Redirect URL 已存在")
        return
    urls.append(SITE)
    call("PATCH", "/config/auth", {"uri_allow_list": ",".join(urls)})
    print(f"[auth] 加上 {SITE}")


def sql_literal(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def step_admin():
    email = (os.environ.get("SIM_ADMIN_EMAIL") or "").strip().lower()
    if not email:
        print("[admin] 沒設 SIM_ADMIN_EMAIL，跳過")
        return
    rows = query(f"""
      do $$
      declare v_uid uuid; v_acc uuid;
      begin
        select id into v_uid from auth.users where lower(email) = {sql_literal(email)} and not coalesce(is_anonymous, false);
        if v_uid is null then return; end if;
        -- 管理員自己指定的 email：內建寄信可能收不到，直接標成已確認
        update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = v_uid;
        insert into sim.members (user_id, display_name, is_admin) values (v_uid, '管理員', true)
        on conflict (user_id) do update set is_admin = true;
        if not exists (select 1 from sim.accounts where user_id = v_uid and kind = 'normal') then
          insert into sim.accounts (user_id, kind, cash) values (v_uid, 'normal', 0) returning id into v_acc;
          perform sim._post(v_acc, 100000, 'OPEN_GRANT', null, '{{"note":"管理員開戶"}}'::jsonb);
        end if;
      end $$;
      select count(*) as n from sim.members m join auth.users u on u.id = m.user_id
      where lower(u.email) = {sql_literal(email)} and m.is_admin;""")
    ok = bool(rows) and int(rows[-1].get("n", 0)) > 0
    print("[admin] 已設成管理員並開戶" if ok else "[admin] 這個 email 還沒在模擬交易頁註冊；註冊後重跑這個 workflow 即可")


def step_refdata():
    query("select private.sim_call('sim-refdata');")
    print("[refdata] 已觸發，約一分鐘後完成")


def anon_key() -> str:
    keys = call("GET", "/api-keys")
    for k in keys:
        if k.get("name") == "anon" and k.get("api_key"):
            return k["api_key"]
    for k in keys:
        if k.get("type") == "publishable" and k.get("api_key"):
            return k["api_key"]
    raise RuntimeError("找不到 anon / publishable key")


def step_anon_key():
    p = ROOT / "web" / "sim-config.js"
    key = anon_key()
    if not re.fullmatch(r"[A-Za-z0-9._\-]+", key):
        raise RuntimeError("anon key 格式不對")
    s = re.sub(r"export const SUPABASE_ANON_KEY = '[^']*'", f"export const SUPABASE_ANON_KEY = '{key}'", p.read_text(encoding="utf-8"))
    p.write_text(s, encoding="utf-8")
    print("[anon-key] 已寫入 web/sim-config.js")


STEPS = {"sql": step_sql, "schema": step_schema, "auth": step_auth, "admin": step_admin,
         "refdata": step_refdata, "anon-key": step_anon_key}

if __name__ == "__main__":
    names = sys.argv[1:] or ["sql", "schema", "auth", "admin", "refdata"]
    for n in names:
        if n not in STEPS:
            sys.exit(f"不認得的步驟：{n}（可用：{', '.join(STEPS)}）")
    for n in names:
        STEPS[n]()
