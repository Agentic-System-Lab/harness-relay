[English](README.md) | **繁體中文**

# 桌面 app

Harness Relay 的桌面 app（Electron），適用於 macOS、Windows 與 Linux：在背景啟動和 `npm start` 相同的伺服器，在自己的視窗中顯示聊天，並有系統匣選單。使用者從[網站](https://agentic-system-lab.github.io/harness-relay/zh-TW/)或 [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases) 安裝；用法見[使用者說明](../docs/user-guide.zh-TW.md#桌面-app)。

這一頁寫給開發桌面 app 的人。細節在開發者說明的[桌面 app](../docs/developer-guide.zh-TW.md#桌面-app)，設計在架構文件的[桌面 app](../docs/architecture.zh-TW.md#桌面-app)。

## 獨立的套件

`desktop/` 有自己的 `package.json` 與 lockfile，所以在根目錄執行 `npm install` 時不會替只用 `npm start` 的人下載 Electron（約 100 MB）。它使用根目錄的 `tsx` 與 `typescript`，所以要先安裝根目錄：

```bash
npm install                      # 根目錄，一次即可
npm install --prefix desktop     # Electron、electron-builder 與 esbuild，一次即可
```

## 指令

都在 repository 的根目錄執行。

| 指令 | 作用 |
| --- | --- |
| `npm run desktop` | 建置 UI 與 app（`desktop/build/`），不安裝直接執行 |
| `npm run desktop:dist` | 同上，再於 `desktop/release/` 產生這個系統的安裝檔（`.dmg`、`.exe`、`.AppImage`；沒有為發佈簽署）；加上 `-- --output <資料夾>` 可放到別處 |
| `npm run desktop:typecheck` | 檢查 app 的型別（`desktop/tsconfig.json`） |
| `npx tsx desktop/scripts/smoke.ts` | 用 app 的方式執行打包好的伺服器（以一般的 Node 代替 Electron），檢查 app 需要它做到的事，包括由 e2e 的假 CLI 回答一個問題 |
| `npx tsx desktop/scripts/check-package.ts` | 照發佈時的方式檢查 `desktop/release/` 裡打包好的 app：它的 fuse、資源、伺服器的檔案裡沒有 `github_pat_` token、app 的檔案裡也沒有 token 的文字，以及它自己的 `--smoke-test`（其中 e2e 的假 CLI 會回答一個問題；Linux 上要在 `xvfb-run` 下執行） |

有 Harness Relay 從 `desktop/release/` 執行時，`npm run desktop:dist` 會拒絕開始：請先結束它，或用 `-- --output <資料夾>` 建置。要和自己的資料分開試用建置結果，見[開發者說明](../docs/developer-guide.zh-TW.md#桌面-app)中「和自己的資料分開試用」的說明。

## 檔案在哪裡

```
src/main.ts          視窗、系統匣選單、更新、它自己的檢查（--smoke-test）與 app 的生命週期；
                     唯一匯入 electron 的檔案
src/supervisor.ts    啟動、看顧與停止伺服器；登入連結，以及有幾個對話的 agent 正在工作
src/env.ts           登入 shell 的環境（Windows 則是重新啟動時讀取的環境），以及伺服器的環境
src/selftest.ts      app 需要伺服器透過 HTTP 做到的事（smoke.ts 與 --smoke-test）
src/update.ts        更新到 GitHub 上最新的版本，等沒有對話的 agent 在工作時才切換
src/updateSource.ts  app 從哪裡下載更新（建置時的 RELAY_UPDATES_REPO、RELAY_UPDATES_TOKEN），
                     以及發佈 workflow 檢查安裝檔是用它們建置的、app 能下載副本
src/traymenu.ts      系統匣選單開著時的處理
src/lifecycle.ts     不需要 Electron 的決定，以及視窗的防護
src/tailscale.ts     分享到 tailnet（tailscale serve）
src/autostart.ts     Linux 上的登入時開啟
src/prefs.ts         desktop.json：port、視窗大小、tailnet 名稱
src/profile.ts       視窗的瀏覽器資料夾，不讓 agent 讀取
src/log.ts           伺服器的紀錄
src/manifest.ts      app 資料夾的 package.json
src/i18n.ts          選單與對話框的文字，兩種語言
src/icons.ts         系統匣圖示
scripts/build.ts     把伺服器與 app 打包到 build/（發佈時用 RELAY_VERSION，否則是 -dev 建置；
                     下載更新的地方用 RELAY_UPDATES_REPO 與 RELAY_UPDATES_TOKEN；它會寫出
                     build/update-source.txt，也就是它們的指紋，給發佈 workflow 用）
scripts/dist.ts      npm run desktop:dist（electron-builder）
scripts/smoke.ts     以 app 的方式執行打包好的伺服器；parent-port.mjs 代替 Electron 的 parentPort
scripts/check-package.ts、scripts/packaged.ts   打包好的 app 的檢查
electron-builder.yml 安裝檔；entitlements.mac.plist 與 macos/（各語言的麥克風使用說明）
```

伺服器這一端是 `src/server/parent.ts`（透過 Electron 的 `parentPort` 傳的訊息：開始監聽、登入連結、忙碌狀態、關閉、更新）與 `src/server/updates.ts`（聊天中的更新）。

## 測試與檢查

- **單元測試。**除了 `main.ts`，這裡的程式都不需要 Electron，和其他程式一樣在根目錄的 `test/` 測試（`npm test`）：`desktop-app.test.ts`、`desktop-env.test.ts`、`desktop-supervisor.test.ts`、`desktop-tailscale.test.ts`、`desktop-traymenu.test.ts`、`desktop-update.test.ts`，以及測試伺服器這一端的 `parent.test.ts`。`electron` 只在 `main.ts` 匯入，其他檔案才能這樣測試。
- **打包好的伺服器**（`scripts/smoke.ts`）與**打包好的 app**（`scripts/check-package.ts`，會執行 app 自己的 `--smoke-test`）。兩者都會讓端對端測試的假 `claude`、`codex` 與 `grok`（[`e2e/fake-cli/`](../e2e/fake-cli/)）組成的團隊回答一個問題，確認伺服器找得到每個 CLI、說得通它的協定並把回答串流進對話；不會啟動真正的 CLI。CI（[`ci.yml`](../.github/workflows/ci.yml)）會檢查 app 的型別、建置它、執行 `smoke.ts`，並為 Linux 與 Windows 打包（更新用的 token 是編造的）、執行 `check-package.ts`；[發佈 workflow](../.github/workflows/release.yml) 在發佈前會在每個系統上執行這兩者。發佈 workflow 也會檢查 app 的更新：建置任何東西之前，讀取用的 token 不是寫入用的；發佈副本之前，每個安裝檔都是用這次執行的 repository 與 token 建置的（它們的指紋）；發佈之後，app 能下載副本。各自檢查哪些項目，見[開發者說明](../docs/developer-guide.zh-TW.md#桌面-app)。
- 修改這裡之後、commit 之前，請執行 `npm run desktop:typecheck`（見 [AGENTS.md](../AGENTS.md)）。

## 發佈與更新

只能由手動執行的發佈 workflow 發佈：它為 macOS（Apple Silicon）、Windows 與 Linux（x64 與 Arm64）建置安裝檔、檢查後發佈，並在每個安裝檔旁附上一份給 app 更新用的副本。見[發佈](../docs/developer-guide.zh-TW.md#發佈)。app 會自己更新到最新的版本（[使用者說明](../docs/user-guide.zh-TW.md#版本)），從 `Agentic-System-Lab/harness-relay-updates`、或建置時 `RELAY_UPDATES_REPO` 指定的 repository 下載它的副本，private 的再用 `RELAY_UPDATES_TOKEN` 給的 token（它會放進 app 裡，任何人都讀得到），拿不到副本時則下載安裝檔本身；見[桌面 app](../docs/developer-guide.zh-TW.md#桌面-app)，workflow 的 `UPDATES_REPO` 變數與 `UPDATES_READ_TOKEN` secret 見[發佈](../docs/developer-guide.zh-TW.md#發佈)。安裝檔的名稱必須和 `site/assets/downloads.js`（`INSTALLERS`、`UPDATE_INSTALLERS`）一致。

## 相關文件

- [使用者說明 → 桌面 app](../docs/user-guide.zh-TW.md#桌面-app)：安裝、視窗、系統匣選單、更新與疑難排解。
- [開發者說明 → 桌面 app](../docs/developer-guide.zh-TW.md#桌面-app)：它如何執行、建置、檢查、fuse、簽署與安裝檔。
- [架構 → 桌面 app](../docs/architecture.zh-TW.md#桌面-app)：程序、登入、環境、tailnet、視窗與更新。
- [開發者說明 → 發佈](../docs/developer-guide.zh-TW.md#發佈)：發佈 workflow 與版本規則。
- [用手機連線 → 用桌面 app](../docs/remote-access.zh-TW.md#用桌面-app)：從系統匣選單分享到 tailnet。
- [各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md)與[架構 → 安全性](../docs/architecture.zh-TW.md#安全性)：agent 不能讀取的地方，包括視窗的登入資料。
- [參與開發](../CONTRIBUTING.zh-TW.md)與 [AGENTS.md](../AGENTS.md)：每個修改都要遵守的規則。
