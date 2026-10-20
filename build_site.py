#!/usr/bin/env python3
"""每日流程：抓資料 → 檢查 → 算訊號與成績單 → 輸出 site/（index.html + signals.json）。

用法
  python build_site.py                       # 下載最新資料並輸出
  python build_site.py --cache               # 用 data/ 裡上次下載的資料（離線開發用）
  python build_site.py --prev URL或路徑       # 上一版 signals.json：沒新交易日就跳過；抓不到的股票沿用舊結果
結束碼：0 成功（或沒新資料而跳過），1 資料嚴重不足、這次不發布。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

import pandas as pd

import core
import data

ROOT = Path(__file__).parent
UNIVERSE_DATE = date(2026, 9, 30)   # universe.csv 對應的成分股日期；每季審核後更新
UNIVERSE_STALE_DAYS = 100
CHART_DAYS = 250


def r4(x):
    """JSON 只留 4 位有效數字，檔案小一點；NaN/None 輸出 null。"""
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return None
    return float(f"{x:.4g}")


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [clean(v) for v in o]
    if isinstance(o, float):
        return r4(o)
    return o


def chart(adj: pd.Series) -> dict:
    sma = adj.rolling(core.MA, min_periods=core.MA).mean()
    tail = adj.index[-CHART_DAYS:]
    return {"d": [d.strftime("%Y-%m-%d") for d in tail],
            "c": [r4(v) for v in adj.loc[tail]],
            "ma": [r4(v) for v in sma.loc[tail]]}


def analyze(adj: pd.Series) -> dict:
    sw, lt = core.swing(adj), core.long_term(adj)
    return {"swing": sw, "long": lt, "advice": core.advice(sw, lt), "score": core.scorecard(adj), "chart": chart(adj)}


def load_prev(src: str | None) -> dict | None:
    if not src:
        return None
    try:
        if src.startswith("http"):
            with urllib.request.urlopen(src, timeout=30) as f:
                return json.load(f)
        return json.loads(Path(src).read_text(encoding="utf-8"))
    except Exception as e:  # 第一次部署時還沒有舊版
        print(f"[提示] 讀不到上一版 {src}：{e}")
        return None


def build(taiex: pd.Series, adj: dict, raw: dict, prev: dict | None) -> dict:
    taiex = data.drop_partial_today(taiex)
    asof = taiex.index[-1]
    prev_stocks = {s["code"]: s for s in (prev or {}).get("stocks", [])}
    stocks, failed = [], []
    for rank, u in enumerate(data.load_universe(), 1):
        code = u["code"]
        base = {"code": code, "name": u["name"], "industry": u["industry"], "rank": rank}
        if code not in adj:
            failed.append(code)
            if code in prev_stocks:   # 沿用上一版，網頁會顯示它的日期
                stocks.append({**prev_stocks[code], **base, "carried": True})
            else:
                stocks.append({**base, "flag": "抓不到資料", "notes": [], "advice": "資料不足"})
            continue
        a = data.drop_partial_today(adj[code]).loc[:asof]
        r = raw[code].reindex(a.index)
        a, chk = data.check(code, a, taiex)
        info = analyze(a)
        if chk["flag"]:
            info["advice"] = chk["flag"]   # 資料有疑慮就不給建議，訊號仍列出供參考
        stocks.append({**base, **info, **chk, "asof": str(a.index[-1].date()),
                       "close": float(r.iloc[-1]), "chg": float(a.iloc[-1] / a.iloc[-2] - 1)})
    mkt = analyze(taiex)
    market = {"name": "加權指數", "close": float(taiex.iloc[-1]), "chg": float(taiex.iloc[-1] / taiex.iloc[-2] - 1), **mkt}
    return {
        "asof": str(asof.date()),
        "generated": datetime.now(data.TZ).isoformat(timespec="minutes"),
        "universe_date": str(UNIVERSE_DATE),
        "universe_stale": (asof.date() - UNIVERSE_DATE).days > UNIVERSE_STALE_DAYS,
        "params": {"ma": core.MA, "band": core.BAND, "confirm": core.CONFIRM, "long_ma": core.LONG_MA,
                   "lookback_years": core.LOOKBACK // 252, "cheap": core.CHEAP_PCT, "rich": core.RICH_PCT,
                   "near": core.NEAR, "score_start": str(core.SCORE_START.date())},
        "failed": failed,
        "market": market,
        "stocks": stocks,
    }


def set_output(**kw):
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            for k, v in kw.items():
                f.write(f"{k}={v}\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--prev")
    ap.add_argument("--force", action="store_true", help="沒有新交易日也照樣輸出")
    ap.add_argument("--out", default=str(ROOT / "site"))
    a = ap.parse_args()

    codes = [u["code"] for u in data.load_universe()]
    if a.cache:
        taiex, adj, raw = data.load_cache()
    else:
        taiex, adj, raw = data.download(codes)
        if len(taiex):
            data.save_cache(taiex, adj, raw)
    if len(taiex) < 300 or len(adj) < len(codes) / 2:
        print(f"[中止] 加權指數 {len(taiex)} 筆、股票 {len(adj)}/{len(codes)} 檔，資料不足，這次不發布")
        return 1

    prev = load_prev(a.prev)
    latest = str(data.drop_partial_today(taiex).index[-1].date())
    if prev and prev.get("asof") == latest and not a.force:
        print(f"[跳過] 沒有新交易日（仍是 {latest}），不更新")
        set_output(skip="true")
        return 0

    result = clean(build(taiex, adj, raw, prev))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "signals.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for f in (ROOT / "web").iterdir():
        shutil.copy(f, out / f.name)
    flagged = [s["code"] for s in result["stocks"] if s.get("flag")]
    print(f"[完成] 資料截至 {result['asof']}，{len(result['stocks'])} 檔；抓不到 {result['failed'] or '無'}；標記 {flagged or '無'}")
    set_output(skip="false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
