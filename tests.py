#!/usr/bin/env python3
"""自動測試：python tests.py（不需要網路）。每日流程部署前會先跑，失敗就不發布。"""
from datetime import datetime

import numpy as np
import pandas as pd

import core
import data


def walk(n=2000, seed=0, start="2017-01-02"):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range(start, periods=n)
    return pd.Series(100 * np.exp(np.cumsum(rng.normal(0.0004, 0.015, n))), index=idx)


def test_signal_no_lookahead():
    c = walk()
    full = core.make_signal(c)
    for cut in (300, 900, 1500):
        part = core.make_signal(c.iloc[:cut])
        assert (full.iloc[:cut].to_numpy() == part.to_numpy()).all(), "截斷後訊號不同：偷看了未來"
        c2 = c.copy()
        c2.iloc[cut:] *= np.random.default_rng(cut).uniform(0.5, 1.5, len(c) - cut)
        r1, r2 = core.simulate(full, c), core.simulate(core.make_signal(c2), c2)
        assert np.allclose(r1.iloc[:cut], r2.iloc[:cut]), "改動未來價格影響了過去報酬"


def test_same_day_price_does_not_earn():
    # 只改 T 日價格：T 日賺報酬的部位（T-2 收盤決定）不能變
    c = walk(seed=3)
    t = 1200
    c2 = c.copy()
    c2.iloc[t] *= 1.08
    p1 = core.make_signal(c).shift(2).iloc[t]
    p2 = core.make_signal(c2).shift(2).iloc[t]
    assert p1 == p2


def test_long_term_and_swing_use_only_past():
    c = walk(seed=5)
    for cut in (800, 1700):
        a = core.long_term(c.iloc[:cut])
        c2 = c.copy()
        c2.iloc[cut:] *= 3
        assert a == core.long_term(c2.iloc[:cut])
        assert core.swing(c.iloc[:cut]) == core.swing(c2.iloc[:cut])


def test_long_term_levels():
    idx = pd.bdate_range("2015-01-01", periods=1800)
    flat = pd.Series(100.0 + np.sin(np.arange(1800) / 30), index=idx)
    spike = flat.copy()
    spike.iloc[-1] *= 1.3
    dip = flat.copy()
    dip.iloc[-1] *= 0.7
    assert core.long_term(spike)["level"] == "偏貴"
    assert core.long_term(dip)["level"] == "偏便宜"
    assert core.long_term(flat.iloc[:600])["level"] == "歷史不足"


def test_swing_states():
    idx = pd.bdate_range("2020-01-01", periods=100)
    c = pd.Series(np.r_[np.full(97, 100.0), [110, 111, 112]], index=idx)
    s = core.swing(c)
    assert s["state"] == "今天轉買進" and s["holding"]
    c = pd.Series(np.r_[np.full(97, 100.0), [104.5, 104.6, 104.7]], index=idx)
    s = core.swing(c)
    assert s["state"] == "空手中" and s["near"], s


def test_advice_matrix():
    for h in (True, False):
        for lv in ("偏便宜", "合理", "偏貴"):
            assert core.advice({"holding": h}, {"level": lv}) in core.MATRIX.values()
    assert core.advice({"holding": None}, {"level": "合理"}) == "資料不足"


def test_scorecard_verdict():
    c = walk(seed=7)
    s = core.scorecard(c, start=c.index[800])
    assert s["verdict"] in ("有幫助", "少跌但少賺", "沒幫助")
    assert s["since"] == str(c.index[800].date())


def test_fix_split():
    tx = walk(seed=1)
    c = walk(seed=2)
    c.iloc[:1000] *= 4          # Yahoo 把 1 拆 4 放錯日期：第 1000 天價格掉成 1/4
    tx.iloc[1000] = tx.iloc[999]
    fixed, notes = data.fix_split(c, tx)
    assert notes and abs(fixed.iloc[1000] / fixed.iloc[999] - 1) < 0.1


def test_check_flags():
    tx = walk(seed=1)
    c = walk(seed=2)
    c.iloc[-10:] *= 1.2         # 最近有超過漲跌幅的跳動 → 不給建議
    _, chk = data.check("x", c, tx)
    assert chk["flag"] == "資料待確認"
    c = walk(seed=2)
    c.iloc[-500:] *= 1.2        # 很久以前的跳動 → 只列出
    _, chk = data.check("x", c, tx)
    assert chk["flag"] is None and chk["notes"]
    _, chk = data.check("x", walk(seed=2).iloc[:-5], tx)
    assert chk["flag"] == "資料過期"


def test_drop_partial_today():
    idx = pd.to_datetime(["2026-10-19", "2026-10-20"])
    s = pd.Series([1.0, 2.0], index=idx)
    assert len(data.drop_partial_today(s, datetime(2026, 10, 20, 11, 0, tzinfo=data.TZ))) == 1
    assert len(data.drop_partial_today(s, datetime(2026, 10, 20, 14, 40, tzinfo=data.TZ))) == 2


if __name__ == "__main__":
    tests = [(k, v) for k, v in dict(globals()).items() if k.startswith("test_")]
    for name, fn in tests:
        fn()
        print("通過", name)
    print(f"全部 {len(tests)} 項通過")
