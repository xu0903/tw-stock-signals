"""訊號與回測的核心計算。只吃價格序列，不碰網路與檔案，方便測試。

所有計算都只用「t 日收盤以前」的資料：rolling 不置中、不用整段統計量。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# 波段訊號參數（沿用 backtest.py 在加權指數訓練期選出的組合，50 檔一律相同，不各自調參）
MA, BAND, CONFIRM = 60, 0.05, 3
# 長期位置
LONG_MA = 240            # 約一年
LOOKBACK = 1260          # 約五年，跟自己的歷史比
MIN_HISTORY = 500        # 距離序列少於這麼多天就不評貴不貴
CHEAP_PCT, RICH_PCT = 20, 80
NEAR = 0.02              # 距觸發線 2% 以內算「接近觸發」
# 成績單
SCORE_START = pd.Timestamp("2022-01-01")
BUY_COST = 0.001425 + 0.0005               # 手續費 + 滑價
SELL_COST = 0.001425 + 0.003 + 0.0005      # 手續費 + 股票證交稅 0.3% + 滑價
DAYS = 252


def make_signal(close: pd.Series, ma: int = MA, band: float = BAND, confirm: int = CONFIRM) -> pd.Series:
    """t 日收盤後才知道的 0/1 目標部位（遲滯：站上上緣連 confirm 天才進，跌破下緣連 confirm 天才出）。"""
    sma = close.rolling(ma, min_periods=ma).mean()
    up = (close > sma * (1 + band)).to_numpy()
    dn = (close < sma * (1 - band)).to_numpy()
    valid = sma.notna().to_numpy()
    sig = np.zeros(len(close), dtype=np.int8)
    state = up_run = dn_run = 0
    for i in range(len(close)):
        if not valid[i]:
            continue
        up_run = up_run + 1 if up[i] else 0
        dn_run = dn_run + 1 if dn[i] else 0
        if state == 0 and up_run >= confirm:
            state = 1
        elif state == 1 and dn_run >= confirm:
            state = 0
        sig[i] = state
    return pd.Series(sig, index=close.index)


def simulate(sig: pd.Series, close: pd.Series) -> pd.Series:
    """t 日收盤出訊號、t+1 日收盤成交（只有收盤價時最保守的做法）。回傳每日淨報酬。"""
    pos_now = sig.shift(1).fillna(0.0)    # t 日交易後的部位
    pos_prev = sig.shift(2).fillna(0.0)   # t 日賺報酬的部位
    gross = pos_prev * close.pct_change().fillna(0.0)
    chg = pos_now - pos_prev
    return gross - (chg > 0) * BUY_COST - (chg < 0) * SELL_COST


def _stats(ret: pd.Series) -> dict:
    eq = (1 + ret).cumprod()
    years = max((ret.index[-1] - ret.index[0]).days / 365.25, 1e-9)
    sd = ret.std(ddof=1)
    return {
        "ann": float(eq.iloc[-1] ** (1 / years) - 1),
        "mdd": float((eq / eq.cummax() - 1).min()),
        "sharpe": float(ret.mean() / sd * np.sqrt(DAYS)) if sd > 0 else None,
    }


def scorecard(close: pd.Series, start: pd.Timestamp = SCORE_START) -> dict | None:
    """這套規則在這檔股票上（start 之後）vs 一直持有。訊號暖機可用 start 以前的資料，績效從 start 起算。"""
    sig = make_signal(close)
    ret = simulate(sig, close).loc[start:]
    bh = close.pct_change().fillna(0.0).loc[start:].copy()
    if len(ret) < 120:
        return None
    bh.iloc[0] -= BUY_COST
    s, b = _stats(ret), _stats(bh)
    trades = int(((sig.shift(1).fillna(0) - sig.shift(2).fillna(0)).loc[start:] > 0).sum())
    excess = s["ann"] - b["ann"]
    if excess >= 0:
        verdict = "有幫助"
    elif s["mdd"] - b["mdd"] >= 0.05:
        verdict = "少跌但少賺"
    else:
        verdict = "沒幫助"
    return {"since": str(ret.index[0].date()), "strategy": s, "hold": b, "excess": excess,
            "trades": trades, "exposure": float(sig.shift(1).fillna(0).loc[start:].mean()), "verdict": verdict}


def long_term(close: pd.Series) -> dict:
    """股價離 240 日均線多遠，放在自己過去五年的分布裡比。"""
    dist = (close / close.rolling(LONG_MA, min_periods=LONG_MA).mean() - 1).dropna()
    hi = close.iloc[-DAYS:].max()
    out = {"from_high": float(close.iloc[-1] / hi - 1)}
    if len(dist) < MIN_HISTORY:
        return {**out, "level": "歷史不足", "pct": None, "dist": float(dist.iloc[-1]) if len(dist) else None}
    win = dist.iloc[-LOOKBACK:]
    pct = float((win < win.iloc[-1]).mean() * 100)
    level = "偏便宜" if pct < CHEAP_PCT else "偏貴" if pct > RICH_PCT else "合理"
    return {**out, "level": level, "pct": pct, "dist": float(dist.iloc[-1])}


def swing(close: pd.Series) -> dict:
    sig = make_signal(close)
    sma = close.rolling(MA, min_periods=MA).mean()
    if sma.isna().iloc[-1]:
        return {"state": "歷史不足", "holding": None}
    now, prev = int(sig.iloc[-1]), int(sig.iloc[-2])
    c, m = float(close.iloc[-1]), float(sma.iloc[-1])
    upper, lower = m * (1 + BAND), m * (1 - BAND)
    if now and not prev:
        state = "今天轉買進"
    elif prev and not now:
        state = "今天轉賣出"
    else:
        state = "持有中" if now else "空手中"
    # 持有時注意下緣（可能轉賣出），空手時注意上緣（可能轉買進）
    gap = (c - lower) / c if now else (upper - c) / c
    since = sig[sig != now].index
    days = int((sig.index > since[-1]).sum()) if len(since) else len(sig)
    return {"state": state, "holding": bool(now), "ma": m, "upper": upper, "lower": lower,
            "trigger_gap": float(gap), "near": bool(0 <= gap <= NEAR), "days_in_state": days}


MATRIX = {
    (True, "偏便宜"): "可考慮進場",
    (True, "合理"): "可考慮進場",
    (True, "偏貴"): "趨勢向上但偏貴，宜分批",
    (False, "偏便宜"): "便宜但還在跌，等轉強",
    (False, "合理"): "觀望",
    (False, "偏貴"): "觀望",
}


def advice(sw: dict, lt: dict) -> str:
    if sw["holding"] is None:
        return "資料不足"
    if lt["level"] == "歷史不足":
        return "趨勢向上（無長期比較）" if sw["holding"] else "觀望"
    return MATRIX[(sw["holding"], lt["level"])]
