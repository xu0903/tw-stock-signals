"""下載台灣 50 與加權指數的日收盤，並做自動資料檢查。

價格一律用還原收盤價（含除權息）：未還原價在除息、拆股那天會假跌，波段訊號會被騙。
代價是還原價用了「之後」才公布的股息去回推過去價格，比例很小，在 README 裡註明。
"""
from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = Path(__file__).parent
START = "2015-01-01"        # 五年百分位 + 240 日均線需要約六年，再留緩衝
LIMIT = 0.105               # 台股漲跌幅上限 10%，留一點還原誤差
STALE_DAYS = 3
RECENT = 60                 # 和波段訊號的 60 日均線同長
TZ = ZoneInfo("Asia/Taipei")


def load_universe() -> list[dict]:
    with open(ROOT / "universe.csv", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def download(codes: list[str]) -> tuple[pd.Series, dict[str, pd.Series], dict[str, pd.Series]]:
    """回傳 (加權指數收盤, {代號: 還原收盤}, {代號: 未還原收盤})。抓不到的代號不會出現在 dict 裡。"""
    import yfinance as yf

    tickers = ["^TWII"] + [c + ".TW" for c in codes]
    df = yf.download(tickers, start=START, auto_adjust=False, progress=False, threads=True, group_by="ticker")
    taiex = df["^TWII"]["Close"].dropna()
    adj, raw = {}, {}
    for c in codes:
        try:
            d = df[c + ".TW"]
        except KeyError:
            continue
        a, r = d["Adj Close"].dropna(), d["Close"].dropna()
        if len(a):
            adj[c], raw[c] = a, r.reindex(a.index)
    return taiex, adj, raw


def drop_partial_today(s: pd.Series, now: datetime | None = None) -> pd.Series:
    """台股 13:30 收盤，14:00 前今天那根 K 棒可能還是盤中價，丟掉。"""
    now = now or datetime.now(TZ)
    today = pd.Timestamp(now.date())
    if len(s) and s.index[-1] >= today and now.hour * 60 + now.minute < 14 * 60:
        return s[s.index < today]
    return s


def fix_split(close: pd.Series, taiex: pd.Series) -> tuple[pd.Series, list[str]]:
    """拆股/合股被 Yahoo 放錯日期：單日價格變成約 1/k 或 k 倍，大盤卻沒怎麼動 → 把之前的價格乘回去。"""
    notes = []
    close = close.copy()
    r = close.pct_change()
    tr = taiex.pct_change().reindex(close.index)
    for d in r.index[((r < -0.45) | (r > 0.9)) & (tr.abs() < 0.03)]:
        ratio = 1 + r[d]
        k = round(1 / ratio) if ratio < 1 else 1 / round(ratio)
        if k in (0, 1):
            continue
        close[close.index < d] /= k
        notes.append(f"{d.date()} 價格錯位已修正（×{1 / k:g}）")
    return close, notes


def check(code: str, close: pd.Series, taiex: pd.Series) -> tuple[pd.Series, dict]:
    """回傳修正後價格與檢查結果 {"flag": None|"資料待確認"|"資料過期", "notes": [...]}。"""
    close, notes = fix_split(close, taiex)
    flag = None
    # 只檢查訊號真的會用到的期間（約六年）；新上市前 5 天無漲跌幅限制，跳過
    r = close.pct_change().iloc[5:]
    r = r[r.index >= close.index[-1] - pd.Timedelta(days=365 * 6)]
    bad = r[r.abs() > LIMIT]
    # 最近 RECENT 個交易日內的異常會直接影響波段訊號 → 不給建議；更早的只列出來
    recent = bad[bad.index >= close.index[-min(RECENT, len(close))]]
    if len(recent):
        flag = "資料待確認"
    notes += [f"{d.date()} 單日 {v:+.1%} 超過漲跌幅限制" + ("" if d in recent.index else "（較早，影響小）")
              for d, v in bad.tail(3).items()]
    # 和大盤最後一天比，落後太多交易日就算過期
    lag = int((taiex.index > close.index[-1]).sum())
    if lag >= STALE_DAYS:
        flag = flag or "資料過期"
        notes.append(f"最後資料 {close.index[-1].date()}，落後大盤 {lag} 個交易日")
    return close, {"flag": flag, "notes": notes}


def cache_dir() -> Path:
    p = ROOT / "data"
    p.mkdir(exist_ok=True)
    return p


def save_cache(taiex: pd.Series, adj: dict[str, pd.Series], raw: dict[str, pd.Series]) -> None:
    d = cache_dir()
    taiex.rename("TAIEX").to_csv(d / "taiex.csv")
    pd.DataFrame(adj).to_csv(d / "adj.csv")
    pd.DataFrame(raw).to_csv(d / "raw.csv")


def load_cache() -> tuple[pd.Series, dict[str, pd.Series], dict[str, pd.Series]]:
    d = cache_dir()
    taiex = pd.read_csv(d / "taiex.csv", index_col=0, parse_dates=True).iloc[:, 0]
    a = pd.read_csv(d / "adj.csv", index_col=0, parse_dates=True)
    r = pd.read_csv(d / "raw.csv", index_col=0, parse_dates=True)
    adj = {c: a[c].dropna() for c in a.columns}
    raw = {c: r[c].reindex(adj[c].index) for c in r.columns}
    return taiex, adj, raw

