#!/bin/sh
# 本機跑資料庫測試：建一個全新的測試資料庫 → 模擬 Supabase → 套用 01、02 → 跑測試
set -e
cd "$(dirname "$0")/.."
DB=${SIM_TEST_DB:-sim_test}
dropdb --if-exists "$DB" && createdb "$DB"
for f in tests/00_local_supabase_stub.sql 01_sim_schema.sql 02_sim_ledger.sql 01_sim_schema.sql 02_sim_ledger.sql tests/sim_test.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
