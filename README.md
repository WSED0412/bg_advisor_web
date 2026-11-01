# 英雄戰場復盤（網頁版）

**網址：<https://wsed0412.github.io/bg_advisor_web/>**

讀取爐石戰記的 `Power.log`，用 [TavernGym](https://github.com/MCG-NJU/AutoTavern) 模擬器重建每回合的戰鬥，
替英雄戰場的決策打分數。不用安裝任何東西，所有分析都在你的瀏覽器裡進行，紀錄檔不會上傳。

- **站位**：試過所有排法，和你的排法比勝率（怎麼排都很難贏時改比受到的傷害）
- **指向性目標**：法術、英雄技能、戰吼指定友方隨從時，每個目標都試一次
- **磁力**：單獨下場 vs 吸附到每一隻機械
- **出牌順序**：連續打出 2～5 張牌時，試過所有順序

分數：91 以上接近最佳、70–90 還可以更好、70 以下明顯失誤。

## 使用方式

1. 用 **Chrome 或 Edge** 打開網址，按「選擇 Logs 資料夾」，選爐石安裝資料夾裡的 `Logs`。
2. 開著這個分頁去打英雄戰場，每局結束後會自動分析，報告出現在列表裡。

瀏覽器不允許網頁讀取 `Program Files` 裡的資料夾；如果選不了，網頁上有一次性的設定說明
（把 Logs 搬到「文件」並在原處留一個連結）。也可以每局結束後手動選擇或拖曳 `Power.log`。
其他瀏覽器只能用手動選檔。

爐石的 `log.config` 需開啟 `[Power]` 紀錄（大多數牌組追蹤器都會幫你設定）。

## 架構

| 位置 | 內容 |
|---|---|
| `engine/` | TavernGym 的 WebAssembly 介面（純 C ABI，不需 wasm-bindgen） |
| `web/js/powerlog.js`、`bglog.js` | 解析 Power.log、擷取戰鬥陣容與出牌 |
| `web/js/scene.js`、`simcore.js`、`sim.js` | 重建局面、平行模擬（每個 Web Worker 一份模擬器） |
| `web/js/scoring.js`、`positioning.js`、`decisions.js`、`review.js` | 評分 |
| `web/js/watch.js`、`app.js`、`report.js`、`store.js` | 監看資料夾、介面、報告、IndexedDB |

推上 `main` 後，GitHub Actions 會編譯 WebAssembly 並部署到 GitHub Pages。

本機開發：

```sh
cd engine && cargo build --release          # 需要 rustup target add wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/taverngym_wasm.wasm ../web/engine/taverngym.wasm
python tools/test_server.py --port 8790     # http://127.0.0.1:8790/
```

評分邏輯移植自 Python 版 bg_advisor，兩者用同一個模擬器和同一組隨機種子，結果一致。

Hearthstone 與卡片資料為 Blizzard Entertainment 所有；本專案與 Blizzard 無關。
TavernGym 為 MIT 授權。
