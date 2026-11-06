-- 模擬交易排程。沿用 LifeMaster 已經設定好的 private.config（functions_url、cron_secret），
-- Edge Functions 也用同一個 CRON_SECRET 驗證，所以不需要新的密鑰。
-- 需要 pg_cron 與 pg_net（LifeMaster 已啟用）。可重複執行。

create schema if not exists private;

create or replace function private.sim_call(p_fn text)
returns void language plpgsql security definer set search_path = '' as $$
declare base_url text; secret text;
begin
  select value into base_url from private.config where key = 'functions_url';
  select value into secret from private.config where key = 'cron_secret';
  if base_url is null or secret is null then raise warning 'private.config 缺 functions_url 或 cron_secret'; return; end if;
  perform net.http_post(
    url := base_url || '/' || p_fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end $$;
revoke all on function private.sim_call(text) from public;

select cron.unschedule(jobid) from cron.job where jobname in ('sim-match', 'sim-settle', 'sim-refdata');
-- 撮合：UTC 01:00–05:59 = 台北 09:00–13:59，平日每分鐘（函式內再依交易時段與休市日判斷）
select cron.schedule('sim-match', '* 1-5 * * 1-5', $$select private.sim_call('sim-match')$$);
-- 收盤結算：台北 14:31、14:45
select cron.schedule('sim-settle', '31,45 6 * * 1-5', $$select private.sim_call('sim-settle')$$);
-- 參考資料：台北 08:00
select cron.schedule('sim-refdata', '0 0 * * 1-5', $$select private.sim_call('sim-refdata')$$);
