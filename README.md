# 台股訊號

台灣 50 每一檔的「長期位置（貴不貴）」與「波段訊號（趨勢向上還向下）」，每個交易日收盤後自動更新。

網頁：https://xu0903.github.io/tw-stock-signals/

**這是規則訊號，不是投資建議。** 設計與規則細節見 [docs/specs/2026-10-20-tw-stock-signals-design.md](docs/specs/2026-10-20-tw-stock-signals-design.md)。

## 本機執行

```
pip install -r requirements.txt
python tests.py                 # 自動測試，不需要網路
python build_site.py --force    # 下載資料並輸出到 site/
cd site && python -m http.server 8765   # 打開 http://localhost:8765
```

## 每季更新成分股

臺灣 50 指數每年 3、6、9、12 月審核。名單變動後：

1. 改 `universe.csv`（代號、名稱、產業，依權重排序）。
2. 改 `build_site.py` 的 `UNIVERSE_DATE`。
3. push 到 main，就會自動重建網頁。

資料來源：Yahoo Finance（透過 yfinance）。
