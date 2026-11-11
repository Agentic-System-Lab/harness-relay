[English](SECURITY.md) | **繁體中文**

# 安全性政策

Harness Relay 會啟動可以修改你的檔案、執行指令的 coding agent，所以只要有辦法繞過它的防護，就可能造成真正的傷害。謝謝你幫忙保護它的使用者。

## 回報漏洞

請**不要**為此開公開的 issue 或 pull request，也不要把細節放進分享出去的對話。

請在 GitHub 上用 **[Report a vulnerability](https://github.com/Agentic-System-Lab/harness-relay/security/advisories/new)** 私下回報（repository 的 **Security** 分頁 → **Report a vulnerability**）。只有你和維護者看得到這份回報，我們也可以在那裡一起修正。如果你無法使用 GitHub，請寄信到 [chihyu.jimmy.yeh@gmail.com](mailto:chihyu.jimmy.yeh@gmail.com)，主旨裡寫上「Security」。

用中文或英文寫都可以，並請附上：

- 攻擊者能做到什麼，以及他們事先需要什麼（同一個瀏覽器裡開著的某個網站、同一台電腦上的某個程式、agent 執行的程式碼、tailnet 裡的某台裝置……）；
- 重現的步驟，或概念驗證（proof of concept）；
- Harness Relay 的版本（**設定與登入 → 版本**，或在 clone 下來的專案裡執行 `git rev-parse --short HEAD`）、你怎麼執行它（桌面 app、`npm start` 或 `npm run dev`）、作業系統，以及用到的 agent CLI 與版本；
- 如果有關係，也請附上對話的模式與權限。

請不要附上真的 API key、token 或私人檔案：用編造的值一樣可以說明問題。

## 接下來會怎麼處理

1. 維護者會在一週內回覆，確認收到回報，並在調查期間讓你知道進度。
2. 確認問題之後，我們會在 `main` 上修正，並發佈包含修正的版本。桌面 app 會自己向使用者提供新版本。
3. 接著我們會發佈 GitHub security advisory，並列出你的名字作為致謝，除非你不希望被具名。

在我們發佈修正之前，請先不要公開談論這個問題；公開的日期我們會和你一起決定。

## 支援的版本

版本以日期命名（例如 `2026-11-11.1`）。修正會放進下一個版本；較舊的版本與候選版本（release candidate）不會另外修正。

| 版本 | 支援 |
| --- | --- |
| 最新的正式版本 | ✅ |
| `main` | ✅ |
| 較舊的版本與候選版本 | ❌ |

桌面 app 會自己更新到最新的正式版本（**設定與登入 → 版本**）。從 clone 下來的專案執行時，請 pull `main`。

## 算是漏洞的情況

只有使用者登入過的瀏覽器可以使用伺服器，而權限低於完全存取的 agent 只能待在它的 CLI 沙箱裡，這個沙箱由 Harness Relay 設定。[架構 → 安全性](docs/architecture.zh-TW.md#安全性)列出了這些防護。能繞過它們就是漏洞，例如：

- 某個網站，或同一台電腦上的某個程式（包括 agent 執行的程式碼），不需要已登入瀏覽器的 cookie 與金鑰，就能操作 API 或 agent；
- agent 的回覆讓瀏覽器載入其他網站的內容，或在 app 的頁面裡執行 script；
- 透過 app 讀取或下載工作目錄、agent 的 worktree 與附件以外的檔案，或 `.git` 裡的任何東西；
- API key 或 MCP 伺服器的機密值出現在瀏覽器、資料庫、記錄檔或命令列上；
- 權限低於完全存取的 agent，因為 Harness Relay 設定它的 CLI 的方式，碰到了 Harness Relay 不讓它碰的東西（瀏覽器的資料夾、Harness Relay 的資料庫、可編輯模式下的 Harness Relay 本身）；
- 分享出去的對話公開了使用者沒有選擇分享的內容；
- 桌面 app 的視窗載入其他網站，或碰到 Node。

## 不算是漏洞的情況

下列情況是已知、且已寫在文件裡的，所以不算漏洞：

- agent 在你給的權限內所做的事：**完全存取**時它們可以執行任何指令，**可編輯**模式下它們可以修改工作目錄裡的任何檔案，即使是它們讀到的檔案或網頁叫它們這麼做；
- [各平台的作業系統沙箱](docs/sandboxing.zh-TW.md)與[已知限制](docs/architecture.zh-TW.md#已知限制)列出的 CLI 沙箱缺口：Grok 執行的專案程式碼可以連上網路，而在原生 Windows 上 Claude Code 與 Grok 完全沒有沙箱；
- 沙箱外、本來就能讀取你瀏覽器設定檔或寫入 Harness Relay `data/` 資料夾的程式；
- 不是透過 `tailscale serve`，而是用其他方式連到伺服器（綁定到 `0.0.0.0`、公開的通道），[用手機連線](docs/remote-access.zh-TW.md#安全性)已經警告過不要這麼做；
- `claude`、`codex` 與 `grok` CLI 本身或它們沙箱的問題：請回報給 Anthropic、OpenAI 與 xAI。如果 Harness Relay 讓問題變得更嚴重，也請在這裡回報。

不確定算不算？還是請回報，我們一起釐清。
