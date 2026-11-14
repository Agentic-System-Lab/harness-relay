[English](user-guide.md) | **繁體中文**

# 使用者說明

這份說明介紹如何安裝 Harness Relay、登入各個 agent（或替開源 agent 設定模型來源）、開始對話（首席 agent 會從你的範本出發，為每個問題組隊），以及跟團隊對話。

## 1. 安裝與啟動

需要 Node.js 22.13 以上，以及至少一個 agent CLI：`claude`、`codex`、`grok`、`cursor-agent`、`agy`（[Antigravity](https://antigravity.google/download)）、`copilot`（[GitHub Copilot CLI](https://github.com/features/copilot/cli)，npm `@github/copilot`）、`muse`（[Muse Code](https://dev.meta.ai/products/muse-code/)），或五個開源 agent 之一（`opencode`、`goose`、`cline`、`openhands`、`pi`；各自的安裝方式與驗證過的版本見 [README](../README.zh-TW.md#需求)）。Muse Code 在 macOS 與 Linux 上用 `curl -fsSL https://dev.meta.ai/install.sh | bash` 安裝，在 Windows PowerShell 用 `irm https://dev.meta.ai/install.ps1 | iex`；它的安裝程式會透過你 shell 的設定檔把一個啟動器放上 `PATH`，啟動器會自己把 Muse 保持在最新版（在 Windows 上是 `muse.cmd`，Harness Relay 會啟動它指名的版本）。在 Windows 上，Muse Code 1.4.18 在 Harness Relay 裡完全存取以外的權限不執行任何指令，完成 Muse 自己的沙箱設定（`muse sandbox windows setup`）後也一樣：Harness Relay 驅動它的那個模式在那裡不用沙箱，所以它的指令會失敗，而不會在沙箱外執行；它的檔案工具能用，完全存取時也能執行指令。編輯與平行模式還需要 [Git](https://git-scm.com/downloads)，Harness Relay 用它做快照與 worktree。

```bash
npm install
npm run build
npm start
```

手邊沒有能安裝它的電腦？可以[在 GitHub Codespaces 試用](codespaces.zh-TW.md)：GitHub 雲端上一台屬於你的 Linux 機器，已經裝好七個非開源的 agent 並啟動 Harness Relay。

打開 `npm start` 在終端機印出的登入連結（`http://127.0.0.1:8787/#code=…`）：Harness Relay 只接受登入過的瀏覽器，所以你電腦上的其他程式，包括 agent 執行的程式碼，都無法操作它。這個連結只能用一次，一小時內有效；之後要讓另一個瀏覽器登入，請執行 `npm run login`，或使用「**設定 → 已登入的瀏覽器 → 讓另一個裝置登入**」，那裡也會列出已登入的瀏覽器，讓你登出。`git pull` 之後，請重新執行 `npm install` 和 `npm run build`，再執行 `npm start`。（要開發 Harness Relay 本身，改用 `npm run dev` 並打開 <http://localhost:5173>；詳見[開發者說明](developer-guide.zh-TW.md)。）

側邊欄底部的圓點代表各 agent 的狀態：綠色＝可以使用、橘色＝尚未登入（開源 agent 則是還沒有模型來源）、紅色＝找不到 CLI。開源 agent 要等它的 CLI 安裝好才會出現圓點。這些圓點排成一行，後面是可用的數目（*4/11 可用*）；把滑鼠移到圓點上可以看到它的名稱與狀態，點它會打開那個 agent 的設定。旁邊的箭頭可以顯示名稱，再按一次就收起來；這個瀏覽器會記住你的選擇。

要用手機、平板或另一台電腦使用 Harness Relay，用 `tailscale serve` 把它分享到你的 tailnet，也可以加到手機主畫面：詳見[用手機連線（Tailscale）](remote-access.zh-TW.md)。在電腦上，Chrome 與 Edge 也能把它安裝成 App（網址列的安裝按鈕），macOS 的 Safari 則能把它加到 Dock（**檔案 → 加入 Dock**）。

### 桌面 app

除了在終端機執行 `npm start`，也可以把 Harness Relay 安裝成桌面 app，支援 macOS（13 Ventura 以上，Apple Silicon）、Windows 10 以上（x64 或 Arm64），以及有桌面環境的 Linux（x64 或 Arm64）。它在背景執行同一個伺服器，並在它自己的視窗裡顯示已登入的對話，沒有網址列。關掉視窗後，伺服器會繼續執行，選單列或系統匣留著一個圖示，所以手機照常能用。跟 `npm start` 一樣，它需要 agent 的 CLI，編輯與平行模式也需要 Git；但不需要 Node.js，只有開源 agent 在完全存取以外執行時例外：它們所在的 Harness Relay 自己的沙箱，需要登入 shell 的 `PATH` 上有 Node.js 22.12 以上（沒有的話，它們只能以完全存取執行）。

**安裝。** 從[網站](https://agentic-system-lab.github.io/harness-relay/zh-TW/)（提供最新的正式版本，不提供候選版本：版本結尾是 `-rc` 的，見[版本](#版本)）或 [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases)（也有候選版本）下載你系統的安裝檔。安裝之後，app 會自己更新：正式版本只更新到下一個正式版本，候選版本則會更新到之後的候選版本或正式版本（見下方 **更新**）。

- **macOS**：`Harness-Relay-<版本>-mac-arm64.dmg`，給 Apple Silicon 的 Mac。打開後把 Harness Relay 拖到「應用程式」。Intel Mac 沒有 app：請在那裡從原始碼執行 Harness Relay（`npm start`，見[快速開始](../README.zh-TW.md#快速開始)）。2026-11-11 與它的候選版本的 Mac app 是兩種 Mac 通用的，它們的選單找不到之後的版本：請從網站重新下載一次新版。
- **Windows**：`Harness-Relay-<版本>-win-x64.exe`，Windows on Arm 用 `Harness-Relay-<版本>-win-arm64.exe`。只安裝給你的帳號，不需要系統管理員權限。Windows 11 on Arm 也能執行 x64 版（透過模擬），Windows 10 on Arm 則不行；Arm64 版在兩者上都是原生執行。
- **Linux**：`Harness-Relay-<版本>-linux-x86_64.AppImage`，64 位元 Arm（aarch64）用 `Harness-Relay-<版本>-linux-arm64.AppImage`。加上執行權限（`chmod +x`）後執行。

網站的下載按鈕會寫出你的系統；瀏覽器有提供處理器時也會分辨（Windows on Arm 上的 Chrome 與 Edge，以及 Linux on Arm 上的任何瀏覽器）。所有安裝檔都列在 **快速開始**。

也可以在 clone 下來的資料夾執行 `npm install` 之後自己建置。建置所在系統的安裝檔會放在 `desktop/release/`；`npm run desktop` 則是不安裝、直接執行：

```bash
npm install --prefix desktop
npm run desktop:dist
```

有 Harness Relay 正從 `desktop/release/` 執行時，`npm run desktop:dist` 會拒絕開始，因為它會替換那些檔案：請先結束那一個，或用 `npm run desktop:dist -- --output <資料夾>` 建置到其他地方。打開新建置的 app 之前，也要先結束正在執行的 Harness Relay，否則 macOS 只會把正在執行的那一個帶到前面（同時只會有一個 Harness Relay 在執行）。之後可以用 `npx tsx desktop/scripts/check-package.ts` 像檢查正式版本一樣檢查剛建置的 app。

安裝檔還沒有為發佈簽章（macOS 上是 ad hoc 簽章），所以第一次開啟時系統會警告：

- **macOS**：「Apple 無法驗證 "Harness Relay"」。打開 **系統設定 → 隱私權與安全性**，在 Harness Relay 旁按 **強制打開**。
- **Windows**：SmartScreen 顯示「Windows 已保護您的電腦」。按 **其他資訊**，再按 **仍要執行**。
- **Linux**：在 Ubuntu 24.04 這類限制非特權 user namespace 的系統上，AppImage 可能一啟動就結束，並提到 *SUID sandbox helper*。請加上 `--no-sandbox` 啟動（`./Harness-Relay-….AppImage --no-sandbox`）；之後 **登入時自動啟動** 也會這樣啟動它。

**登入。** App 會向它的伺服器拿一個一次性的登入連結來打開對話，所以視窗不用輸入代碼就已登入；**在瀏覽器打開** 則在預設瀏覽器做同樣的事。這個連結不會印出，也不會寫進記錄檔，而且只在一分鐘內有效。視窗本身就是一個獨立的瀏覽器：它會列在 **設定 → 已登入的瀏覽器** 裡，使用導覽與介面語言也是它自己的。要讓手機登入，就跟 `npm start` 一樣，打開 **設定 → 已登入的瀏覽器 → 讓另一個裝置登入**。如果視窗出現登入頁（它的登入被撤銷，或登入連結沒有及時使用），從 app 的選單選 **打開 Harness Relay**：視窗會用新的連結重新登入。如果是瀏覽器出現登入頁，就選 **在瀏覽器打開**。視窗的登入資訊放在 app 資料夾裡的 `browser` 資料夾，權限低於完全存取的 agent 讀不到它（在 macOS 與 Linux 上，由它們的沙箱強制執行）。

**視窗。** 關掉視窗後，Harness Relay 會繼續在選單列或系統匣執行（macOS 上它的 Dock 圖示會消失，直到視窗再次打開）；選 **結束**（macOS 上是 ⌘Q）才會停止。連到其他網站的連結會在預設瀏覽器打開，從對話下載的檔案則透過一般的儲存對話框儲存。第一次使用語音輸入時會詢問麥克風權限；影片本身的全螢幕按鈕也能用。在 Windows 與 Linux 上，按 Alt 會顯示視窗的選單列，裡面也有 **結束**。

**選單。** App 的圖示是 Harness Relay 的三個圓點，在 macOS 的選單列，或 Windows 與 Linux 的系統匣。在 Windows 上，點一下圖示會打開對話，選單在右鍵。選單有：

| 項目 | 作用 |
| --- | --- |
| 「執行中：<http://127.0.0.1:8787>」 | 伺服器的狀態：啟動中、執行中、停止中或已停止。 |
| **打開 Harness Relay** | 顯示對話視窗。再次打開 app（從 Dock、啟動台或「開始」選單）也一樣。 |
| **在瀏覽器打開** | 改用預設瀏覽器打開已登入的對話。 |
| **分享到手機（Tailscale）…** | 把伺服器分享到你的 tailnet，也就是[用手機連線](remote-access.zh-TW.md#用桌面-app)的第 1、2 步，並顯示手機要打開的網址。分享之後，**複製手機網址** 會複製它。 |
| **登入時自動啟動** | 登入電腦時啟動 app，但不打開視窗。 |
| **執行時不讓電腦睡著** | App 執行時，電腦不會自己進入睡眠，手機才連得到。MacBook 闔上蓋子還是會睡眠。 |
| **打開資料夾**、**查看記錄檔** | App 的資料夾（見下方）與伺服器的記錄檔。 |
| **重新啟動伺服器…**、**啟動伺服器** | 重新啟動伺服器（正在回覆的對話會中斷），或在它停止後再啟動。 |
| 「版本」 | App 的版本（見[版本](#版本)）。 |
| **更新到 2026-11-12…** | 有更新的版本時出現（正式版本只看正式版本；候選版本看正式版本與候選版本）：更新 app（見下方 **更新**）。更新進行中，這一項會顯示下載進度（選單開著時也會即時更新）；還有對話在回覆時，則顯示「更新已就緒，等回答結束後切換」。 |
| **立即切換到新版…** | 更新在等回覆結束時出現：詢問後立即切換，正在回覆的對話會被中斷。 |
| **結束 Harness Relay** | 停止伺服器（它會先停止所有 agent），然後結束。 |

有些 Linux 桌面會隱藏系統匣圖示（例如沒有 AppIndicator 擴充套件的 GNOME）。在那裡，再次打開 app 會顯示視窗（或啟動已停止的伺服器），視窗的選單列（Alt）除了編輯、縮放與視窗之外，還有 **在瀏覽器打開** 與 **結束**。選單的其他項目（**分享到手機**、**登入時自動啟動**、**執行時不讓電腦睡著**、**重新啟動伺服器…**、記錄檔、資料夾與更新）在那裡都用不到：請安裝 AppIndicator 擴充套件，或改用終端機（`tailscale serve`，見[用手機連線](remote-access.zh-TW.md)）。

**跟 `npm start` 不同的地方：**

- **它有自己的資料夾。** App 把檔案放在 macOS 的 `~/Library/Application Support/Harness Relay`、Windows 的 `%APPDATA%\Harness Relay`、Linux 的 `~/.config/Harness Relay`：對話與設定在其中的 `data` 資料夾，app 自己的設定在 `desktop.json`。它不使用 clone 資料夾裡的 `data/`。要沿用原本的對話，先把兩者都結束，再把 clone 資料夾裡 `data/` 的內容複製到 app 的 `data` 資料夾，並在設定中重新輸入 API key 與 MCP 伺服器的祕密值（它們在金鑰儲存區裡另一個名稱下：見下一點）。或者在 shell 設定檔裡設定 `RELAY_DATA_DIR`，app 也會讀取。絕對不要讓兩者同時使用同一份資料。
- **它有自己的 API key。** 使用自己的資料夾時，app 把 API key 存在金鑰儲存區的 `harness-relay-desktop` 名下，跟 `npm start` 的（`harness-relay`）分開，所以在其中一邊儲存或移除 key，不會影響另一邊。設定了 `RELAY_DATA_DIR` 時，兩者共用資料，也都使用 `harness-relay`。
- **你的 shell 環境。** 在 macOS 與 Linux 上，app 會讀取登入 shell 設定好的環境（`~/.zshrc`、`~/.bashrc` 等檔案裡的 PATH、API key 與其他變數），所以會像終端機一樣找到 CLI。**重新啟動伺服器…** 與 **啟動伺服器** 時會再讀一次：安裝新的 CLI 或修改設定檔之後，選其中一個。在 Windows 上，app 在打開時從系統取得 PATH，並在 **重新啟動伺服器…** 與 **啟動伺服器** 時，從 Windows 重新讀取 PATH 與你的使用者變數。
- **一律使用 127.0.0.1、port 8787。** Shell 設定檔裡的 `PORT` 或 `HOST` 是給其他程式用的，app 不會採用。要改用其他 port，先結束 app，再修改它的 `desktop.json` 裡的 `"port"`（檔案不存在時就建立它：`{ "port": 8790 }`）。`npm start` 也使用 port 8787，所以除非其中一個改用其他 port，兩者不能同時執行（`npm run dev` 使用 8789，所以能和 app 同時執行；和 `npm start` 同時執行則要在另一個 checkout，因為一個資料夾只能有一個伺服器）。如果 port 已被佔用（例如被用 `npm start` 啟動的 Harness Relay），app 會告訴你，並讓你再試一次。
- **上限、回合逾時與語音下載。** 有些設定是環境變數，在伺服器啟動時讀取：每個 CLI 能有幾個帳號（`RELAY_MAX_ACCOUNTS`）、一個隊伍能有幾位成員（`RELAY_MAX_TEAM_AGENTS`）、一個 agent 回合最久多長（`RELAY_TURN_TIMEOUT_MIN`），以及語音輸入從哪裡下載、檔案放在哪裡（`RELAY_VOICE_MODEL_BASE_URL`、`RELAY_VOICE_ENGINE_BASE_URL`、`RELAY_VOICE_DIR`）；[開發者指南](developer-guide.zh-TW.md#環境變數)列出了它們的預設值與範圍。在 macOS 與 Linux 上，把它們 `export` 在 shell 設定檔裡（`~/.zprofile`、`~/.bashrc` 等）。在 Windows 上，請設成*使用者*變數：在 PowerShell 執行 `setx RELAY_MAX_TEAM_AGENTS 16`，或到 **系統內容 → 環境變數 → 使用者變數**；系統變數中，app 只會重新讀取 PATH。接著選 **重新啟動伺服器…**（進行中的回覆會停止）。在 Windows 上，刪掉的變數或系統變數，要結束 app 再重新打開才會生效。值不合法時伺服器不會啟動，app 的訊息會說明是哪一個。
- **預設工作目錄**是你的家目錄，直到你在設定中修改。編輯模式不接受家目錄本身（agent 會在不詢問的情況下修改你的 shell 與工具設定）：編輯模式的對話請選一個專案資料夾。
- **伺服器的記錄檔**在 macOS 是 `~/Library/Logs/Harness Relay/server.log`，在 Windows 與 Linux 是 app 資料夾裡的 `logs/server.log`。
- **macOS 可能會詢問** Harness Relay 能否存取「文件」或「桌面」等資料夾（agent 第一次在那裡工作時）、能否使用麥克風（第一次使用語音輸入時），以及更新後能否使用鑰匙圈裡它的金鑰。詢問的對象是這個 app，因為 agent 在它裡面執行。請選 **允許**（或 **永遠允許**）。
- **結束 app** 時會先停止所有 agent。強制結束 app（或 app 當機）時，正在回覆的 agent 可能會繼續執行，就像用 `kill -9` 停止 `npm start` 一樣。伺服器還在啟動時（例如在等鑰匙圈）結束 app，會立刻停止它：那時它還沒有執行任何 agent。

**更新。** App 啟動約 30 秒後，以及之後每小時，會向 GitHub（`api.github.com`）查詢它的版本，取版本最新的那一個。正式版本的 app 只取正式版本（`2026-11-11` 之後是 `2026-11-12`，絕不會是 `2026-11-12-rc`）；候選版本的 app 也取候選版本（`2026-11-12-rc.1` 之後可以是 `2026-11-13-rc`，也可以是 `2026-11-12`，更新到正式版本後就回到只取正式版本）。當那個版本比 app 新、並且有你系統的安裝檔時（在 Windows 與 Linux 上，是你執行的 app 所屬處理器的安裝檔），選單會出現 **更新到** 加上它的版本（例如 **更新到 2026-11-12…**），聊天介面也會提供：在 app 的視窗裡每個版本跳出一次對話框（按「稍後再說」就不再為那個版本跳出；用 Esc 或 × 關掉的，下次打開 app 時會再跳出；有其他對話框開著、或你正在打字或錄音時會先等），以及「設定與登入 → 版本」這張最前面的卡片，它也會顯示你目前的版本與上次檢查的時間。設定頁上方的「重新檢查狀態」會立刻再檢查一次 GitHub（最多每 5 分鐘一次）。對話框或卡片裡的「更新」和選單裡的效果一樣。不論你的版本之後出了幾個版本，它都只提供最新的那一個，一次更新到它。選了之後會先詢問；**查看變更內容**（對話框和卡片裡的「變更內容」也是）會打開 GitHub 上你的版本與新版本的比較頁，列出你的版本之後的每一個變更，不論中間出了幾個版本（每個正式版本自己的版本說明只列出它前一個正式版本之後的變更）；自己建置的版本在 GitHub 上沒有對應的版本，打開的是該版本的頁面。接著 app 會下載安裝檔、用 GitHub 公布的 SHA-256 檢查碼檢查它，選單會顯示進度（選單開著時，大約每秒重新打開一次來顯示）。切換之前，它會等到沒有任何對話有 agent 在工作：正在回覆、正在組隊、在等你核准工具、正在修改隊伍、正在把對話分組、正在套用平行模式的回覆或建立分支。在等你回答 agent 問題的對話不算：換成新版後，它一樣會等你回答。這段期間選單會顯示「更新已就緒，等回答結束後切換」，選 **立即切換到新版…** 則會在詢問後立即切換，並中斷正在回覆的對話。接著 app 會結束，再以新版重新打開：

- **macOS**：新的 app 會就地取代「應用程式」（或你放它的地方）裡的 app。這需要一個 app 能寫入的資料夾（系統管理員的「應用程式」資料夾即可），而且 app 不能直接從 `.dmg` 執行。如果 macOS 不讓 app 取代自己（可能會要求你允許 **App 管理**），會打開新版的 `.dmg`：把 Harness Relay 拖到「應用程式」、取代舊版即可。
- **Windows**：app 結束後，安裝檔會在背景安裝，並打開新版。
- **Linux**：新的 AppImage 會取代你執行的那一個。如果那一個是以版本命名的（下載時的名稱），新的會用它自己的版本命名，並刪除舊的；**登入時自動啟動** 也會跟著改。只有 AppImage 能自己更新。

切換之前，你執行的 app 都不會被改動：更新在等待時結束 app（或重新啟動伺服器、關機），會保留目前的版本，下次啟動時會刪掉更新下載的檔案（選單會再提供這次更新）。Windows on Arm 上的 x64 版會繼續更新成 x64 版；要改用 Arm64 版，請從網站或版本頁面安裝它。

Harness Relay 更新時開著的聊天頁面，會在一分鐘內（或你回到它的視窗時）自己重新載入，改用新版本的程式。

無法自己更新的 Harness Relay（用 `npm run desktop` 從原始碼執行的、放在不能寫入的資料夾裡的、安裝檔沒有檢查碼的）會說明原因，並改為提供該版本的頁面：照第一次的方式安裝新版即可。要關掉這些查詢，在 shell 設定檔（或 app 的環境）設定 `RELAY_UPDATES=off`。

**它把東西放在哪裡，以及解除安裝。** App 的資料夾在 macOS 是 `~/Library/Application Support/Harness Relay`，Windows 是 `%APPDATA%\Harness Relay`，Linux 是 `~/.config/Harness Relay`（有設定 `$XDG_CONFIG_HOME` 時是 `$XDG_CONFIG_HOME/Harness Relay`）。裡面有：`data`（對話與設定）、`browser`（視窗自己的瀏覽器資料，包括它的登入資訊）、`desktop.json`（app 的設定），在 Windows 與 Linux 上還有 `logs`。解除安裝的步驟：

1. 關掉 **登入時自動啟動**；如果分享過到手機，停止分享（`tailscale serve --https=443 off`，或 app 說它用的那個 HTTPS port：見[用手機連線](remote-access.zh-TW.md#安全性)），再結束 app。
2. 移除 app：把 Harness Relay 從「應用程式」拖到垃圾桶（macOS）；**設定 → 應用程式**（**已安裝的應用程式**，Windows 10 是 **應用程式與功能**）→ Harness Relay → **解除安裝**（Windows）；刪除 AppImage（Linux）。
3. 要連資料一起移除：刪除 app 的資料夾，在 macOS 上還有 `~/Library/Logs/Harness Relay`。API key 與 MCP 伺服器的祕密值在金鑰儲存區的 `harness-relay-desktop` 名下（macOS 的「鑰匙圈存取」、Windows 的認證管理員，或 Linux 的 keyring）：刪除這些項目。在 Linux 上，關掉 **登入時自動啟動** 後，`~/.config/autostart/harness-relay.desktop` 就會被刪除。

### 版本

版本就是發佈當天的日期（台灣時區）：`2026-11-10` 是正式版本，`2026-11-10-rc` 是候選版本，在正式版本之前先給大家試用。同一天再發佈的修正會加上編號：`2026-11-10.1`、`2026-11-10-rc.2`。當天的正式版本發佈之後，當天的修正就是它的修正版，修正版也可以先有自己的候選版本：先是 `2026-11-10.1-rc`、再來 `2026-11-10.1-rc.1`，然後才是 `2026-11-10.1`。選單會顯示 app 的版本，[Releases](https://github.com/Agentic-System-Lab/harness-relay/releases) 則把候選版本標成 pre-release。你自己建置的 app 會顯示建置的日期加上 `-dev` 與 commit，例如 `2026-11-10-dev (30f3d4f)`：當天或之後的任何版本（包括候選版本）都算比較新，會被提供為更新。

### 介面語言與使用導覽

介面提供 **English** 與 **繁體中文**。第一次開啟時會依瀏覽器的語言決定（任何中文 → 繁體中文，其他 → English），並記在這個瀏覽器；之後隨時可以在 **設定與登入 → 介面語言** 切換。伺服器傳來的錯誤訊息與系統訊息也會使用同一種語言。

介面的顏色會跟隨電腦或手機的淺色／深色模式。想不管系統怎麼設定都固定用其中一種，就在 **設定與登入 → 外觀** 選 **淺色** 或 **深色**（選 **跟隨系統** 則回到跟隨系統）。這個選擇記在這個瀏覽器，所以電腦和手機可以各用各的；它會立刻生效，同一個瀏覽器的其他分頁也會跟著換，回覆裡的圖表也會用它重新繪製。你分享出去的頁面則跟隨讀者自己的模式。

第一次開啟時也會出現簡短的 **使用導覽**，一步一步介紹主要功能（← / → 切換步驟，Esc 跳過）。更新後導覽內容有調整時（例如加入新功能），下次開啟會再出現一次。隨時可以在 **設定與登入 → 使用導覽** 按 **重新觀看導覽** 再看一次。

## 2. 分別登入各個 agent：設定與登入

點側邊欄的 **⚙ 設定與登入**。**模型來源** 排在最前面，在所有 CLI 之前：五個開源 agent 用它執行，Claude Code、Codex、Grok 與 Copilot 也能用它的自訂端點執行（見[開源 agent 與模型來源](#開源-agent-與模型來源)）。每個 CLI 有一張卡片，顯示版本，並把它的每個帳號放在自己的框裡（只有預設帳號時也一樣），顯示帳號名稱、登入狀態，以及 CLI 回報的 email。帳號框裡的一切都屬於那個帳號：登入、API key、[預設模型與推理強度](#預設模型與推理強度)，以及 CLI 在那裡[自己載入的內容](#各-cli-自己載入的內容)。只有 CLI 的 **執行檔** 是所有帳號共用一個設定。五個開源 agent 沒有登入流程，所以也沒有其他帳號。

### 登入

選擇登入方式後按 **登入**。Harness Relay 會執行該 CLI 自己的登入指令，並顯示你需要的資訊：

| Agent | 方式 | 操作 |
| --- | --- | --- |
| Claude Code | Claude 訂閱帳號 / Anthropic Console | 開啟連結並授權，把頁面顯示的授權碼貼到輸入框，按 **送出**。 |
| Codex | ChatGPT 裝置碼 | 開啟連結、登入 ChatGPT，輸入畫面上的一次性代碼（點一下即可複製）。 |
| Codex | ChatGPT 瀏覽器登入 | 會在這台電腦開啟瀏覽器，在瀏覽器完成登入。 |
| Grok | xAI 裝置碼 / xAI 瀏覽器登入 | 開啟連結並確認代碼。 |
| Cursor | Cursor 帳號 | 在任何一台裝置的瀏覽器開啟連結（不會在這台電腦開瀏覽器），登入 Cursor 並允許 CLI。 |
| Antigravity | Google 帳號 | 在任何一台裝置的瀏覽器開啟連結（不會在這台電腦開瀏覽器）並登入 Google，再把頁面顯示的授權碼（或整個網址）貼到輸入框，按 **送出**。 |
| Copilot | GitHub 帳號（裝置代碼） | 在任何一台裝置的瀏覽器開啟 GitHub 連結（`https://github.com/login/device`），輸入畫面上的代碼（點一下即可複製）並授權。 |
| Muse Code | Meta 帳號 | 在任何一台裝置的瀏覽器開啟連結（不會在這台電腦開瀏覽器）並登入你的 Meta 帳號，確認頁面上的代碼和連結下方顯示的一樣。 |

CLI 完成後，面板會變成綠色的 **登入成功 ✓**。若出了問題，展開 **CLI 輸出** 可以看到原始輸出。

> **Codex：**開始新的 Codex 登入時，會先登出目前的 Codex 帳號，頁面會先請你確認。

> **Cursor：**不管用哪個資料夾執行，Cursor 在每個電腦使用者只保留一個登入（macOS 上存在登入鑰匙圈）。只有 Cursor 的預設帳號用這種方式登入；Cursor 的[其他帳號](#多個帳號)使用 API key。

> **Antigravity：**它把 Google 登入存在系統的 keyring（macOS 鑰匙圈、Linux 的 Secret Service、Windows 認證管理員）。只有 Antigravity 的預設帳號用這種方式登入；Antigravity 的[其他帳號](#多個帳號)使用 Gemini API key。

> **Copilot：**它把 GitHub token 存在系統的金鑰儲存區（macOS 上是鑰匙圈），依你的 GitHub 帳號名稱存放，而不是依它的資料夾；登入的是誰則記在它的資料夾裡。它的每個[帳號](#多個帳號)都用這種方式登入。登入在 macOS 上確認過，也在一台沒有桌面環境的 Linux 上試過（裝置碼可以用，token 則如下所述沒有存下來）；Windows 與 GitHub Enterprise 都沒有確認。在沒有桌面金鑰圈的 Linux 上（例如沒有桌面環境的伺服器），`copilot login` 最後會說 *Login succeeded, but the token was not saved…*，Harness Relay 會把它顯示為登入失敗，因為下一次執行找不到 token：在帳號的 Copilot `settings.json`（`~/.copilot/settings.json`，或帳號資料夾裡的那一個）設定 `"storeTokenPlaintext": true`，讓 Copilot 可以用明文保存 token，再登入一次；或把 GitHub token 存成帳號的 API key（見下方「API key（選用）」）。

> **Muse Code：**在 macOS 上它把 Meta 登入存在登入鑰匙圈，名稱不隨它的資料夾改變。只有 Muse Code 的預設帳號用這種方式登入；Muse Code 的[其他帳號](#多個帳號)使用 Meta API key。Harness Relay 只以 Muse 的登入指令與它印出的內容驗證過，沒有用真正的 Meta 帳號試過，所以登入本身尚未確認。

**登出** 會讓這台電腦上的該 CLI 登出，也會影響你在其他地方使用這個 CLI。

### API key（選用）

每張卡片的 **API key** 區塊：

- **Claude Code**：以 `ANTHROPIC_API_KEY` 傳入（改為 API 計費，優先於訂閱登入）。
- **Grok**：以 `XAI_API_KEY` 傳入。
- **Codex**：交給 `codex login --with-api-key`，由 Codex 自己保存，會取代 ChatGPT 登入。
- **Cursor**：以 `CURSOR_API_KEY` 傳入，只用在 Harness Relay 的執行：Cursor 不會把它存進去蓋掉你自己的 Cursor 登入，你的登入維持原樣。Cursor 只在每次執行時用金鑰登入，`cursor-agent status` 看不到，所以有金鑰的帳號（包括從啟動 Harness Relay 時環境中的 `CURSOR_API_KEY` 或 `CURSOR_AUTH_TOKEN` 拿到金鑰的）會顯示為以 *API key* 登入。
- **Antigravity**：Gemini API key，以 `GEMINI_API_KEY` 傳入；這次執行自己的設定也會加上 `modelProvider: "gemini"`，讓 Antigravity 改用 Gemini API（依用量計費），而不是你的 Google 登入。你自己的 Antigravity 設定檔不會被改動。有金鑰的帳號（預設帳號也包括從啟動 Harness Relay 時環境中的 `GEMINI_API_KEY` 拿到金鑰的）會顯示為以 *API key* 登入。
- **Copilot**：GitHub token，以 `COPILOT_GITHUB_TOKEN` 傳入，Copilot 會優先用它，而不是它保存的 GitHub 登入：請用有「Copilot Requests」權限的 fine-grained personal access token（Copilot 不接受 classic 的 `ghp_` token）。有 token 的帳號（預設帳號也包括從啟動 Harness Relay 時環境中的 `COPILOT_GITHUB_TOKEN`、`GH_TOKEN` 或 `GITHUB_TOKEN` 拿到的，依 Copilot 自己的順序）在 Copilot 接受它時，會顯示為以 *GitHub token* 登入：Harness Relay 會直接問 Copilot（在它自己的資料夾開一個 session，不送 prompt），所以 Copilot 不接受的 token（例如 classic 的）會顯示為未登入。
- **Muse Code**：Meta API key，以 `META_API_KEY` 傳入，Muse 會優先用它，先於它自己存的金鑰與你的 Meta 帳號登入（依 Meta API 計費）。你自己的 Muse 設定不會被改動。有金鑰的帳號（預設帳號也包括從啟動 Harness Relay 時環境中的 `META_API_KEY` 拿到金鑰的）會顯示為以 *API key* 登入。**登出** 會執行 `muse logout`，移除 Muse 自己存的金鑰與它的 Meta 登入，不包括 `META_API_KEY`。在 Windows 上，Muse 自己保存的金鑰（`muse auth set`）以純文字存在 `%USERPROFILE%\.config\muse\auth.json`；在這裡儲存的則和其他金鑰一樣放在金鑰儲存區。

Claude Code、Grok、Cursor、Antigravity 與 Muse Code 的金鑰，以及 Copilot 的 token，由 Harness Relay 存放在系統的金鑰儲存區，名稱為 `harness-relay`（[桌面 app](#桌面-app) 則是 `harness-relay-desktop`）：macOS 鑰匙圈、Windows 認證管理員，或 Linux 的 Secret Service（GNOME Keyring、KWallet）。卡片上會寫出存放位置。在沒有這類儲存區的系統（例如沒有桌面環境的 Linux 伺服器）上，金鑰會改存在資料庫，並以 Harness Relay 為此產生、存在 `data/secrets.key`（[桌面 app](#桌面-app) 則在它自己的資料夾）的金鑰加密，這個檔案只有你的帳號能讀取（設定 `RELAY_SECRETS_KEY_FILE` 可以把這把金鑰放在別處，例如 systemd credential；可用 `openssl rand -base64 32` 產生）。只拿到資料庫、沒有這個檔案，就得不到任何金鑰；這個檔案遺失的話，金鑰得重新設定。若完全不想存在磁碟上，可以不填這個欄位，改在啟動 Harness Relay 前設定環境變數 `ANTHROPIC_API_KEY` / `XAI_API_KEY` / `CURSOR_API_KEY` / `GEMINI_API_KEY` / `COPILOT_GITHUB_TOKEN` / `META_API_KEY`。如果你在 macOS 上使用開源 agent，請不要這樣做：在那裡，它們執行的指令讀得到上層每個程序啟動時的環境變數，包括 Harness Relay 的伺服器與啟動它的 shell（見[檔案權限](#對話規則)）。舊版以原文存在資料庫裡的金鑰，會在伺服器下次啟動時搬進金鑰儲存區，或改為加密。macOS 可能會詢問是否允許 `node` 使用這把金鑰（例如更新 Node.js 之後），請選 **永遠允許**。

### 開源 agent 與模型來源

OpenCode、Goose、Cline、OpenHands 與 Pi 使用你在 **設定 → 模型來源** 設定的模型來源執行，從不使用它們自己的登入。Claude 訂閱帳號與 Grok 的登入不能用在這些 CLI（Anthropic 不允許在第三方 agent 中使用它的訂閱）：請給它們 API key 或你自己的端點。Claude Code 與 Grok 本身的模型照常使用它們的登入。

**Claude Code、Codex、Grok 與 Copilot 在你自己的端點上執行。** 它們的模型選單會在自己的模型後面列出每個自訂端點的模型，例如 `homelab/gemma4:e4b`：給成員選其中一個（或在「設定」裡那個 CLI 卡片上、某個帳號區塊的[預設模型與推理強度](#預設模型與推理強度)選一個當作那個帳號的預設，它沒有指定模型的成員就用它；選單會把它們列在「**你自己的端點**」底下），那個 CLI 就在你的伺服器上執行，帶著端點的金鑰（有的話），絕不帶你的 Claude、ChatGPT、Grok 或 GitHub 登入或它們的 API key。伺服器也要提供那個 CLI 用的 API：Claude Code 用 Anthropic Messages API（`/v1/messages`），Codex 用 Responses API（`/v1/responses`），Grok 與 Copilot 用 Chat Completions（`/v1/chat/completions`）；vLLM、Ollama、LM Studio 與 llama.cpp 三種都提供。這時 Claude Code、Codex 與 Copilot 不需要登入；Grok 啟動時仍需要它自己的登入。這些模型只提供這類伺服器都接受的推理強度：Claude Code 是 low 到 high，Codex 是 none 到 high（原本會用的其他值，例如你的 Codex 設定裡的 `xhigh`，改成 medium），Grok 不送，Copilot 是 low 到 high（以 `reasoning_effort` 送出）。Copilot 是用它自己那組「你自己的模型供應商」變數（`COPILOT_PROVIDER_BASE_URL` 等）指向伺服器；以這類伺服器的替身與 Ollama 確認過。Grok 的部分，Harness Relay 會在 Grok 成員第一次用到端點的模型時，把端點的模型加進 Grok 自己的 `config.toml`，放在一段有標記的區塊裡，不出現在 Grok 自己的模型選單（Grok 重寫自己的設定時會丟掉區塊的標記、卻留下這些模型，Harness Relay 寫入區塊前會先把這些殘留拿掉，所以 Grok 不會讀到重複定義的模型）。成員的模型在 CLI 自己的模型與端點的模型之間切換，或換到另一個端點時，會帶著完整的對話開始新的 session。Cursor、Antigravity 與 Muse Code 的模型只透過它們自己的服務執行，所以都不能在端點上執行。（Antigravity 自己的自訂模型只能是 Google 託管的，在 Gemini API 或 Vertex AI 上；它唯一能改的位址 `GOOGLE_GEMINI_BASE_URL` 必須提供 Gemini API（`/v1beta/models/<模型>:streamGenerateContent`），這些伺服器都沒有提供，而且它送過去的只會是它自己清單裡的模型名稱。以 agy 1.5.6 確認。Muse Code 用的是 Responses API，位址也能改，但它每次啟動都會先向那個位址要 Meta API 自己的模型目錄（`/muse-code/models`），而 OpenAI 相容伺服器不提供（Ollama 回 404），這一輪就不會執行；要提供那份清單得在中間架一個代理，而 Harness Relay 從不自己和模型 API 溝通。它的其他模型供應商不在公開版本裡，它的 `local` 只執行 Meta 自己的裝置端模型。以 muse 1.4.18 確認。）

- **API key**：**OpenAI**、**Anthropic**、**xAI** 各一把：貼上後按 **儲存**，**移除** 則刪掉它。金鑰和各 CLI 的 API key 一樣存在系統的金鑰儲存區（卡片上會註明存在哪裡），畫面上只會顯示遮蔽過的內容。Harness Relay 環境變數裡的金鑰（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`XAI_API_KEY`，其他模型供應商的，例如 `GEMINI_API_KEY` 或 `OPENROUTER_API_KEY`，Cursor 的 `CURSOR_API_KEY` 與 `CURSOR_AUTH_TOKEN`、Antigravity 的 `AGY_ADC_AUTH`，以及 Muse Code 的 `META_API_KEY`）不會被使用，也不會傳給這些 agent：每次執行只拿到它的模型所屬來源的那一把金鑰（也就是這裡儲存的），絕不會拿到其他來源的。Copilot 的 `COPILOT_GITHUB_TOKEN`，以及 Copilot 自己的模型供應商的位址與金鑰（`COPILOT_PROVIDER_BASE_URL`、`COPILOT_PROVIDER_API_KEY`、`COPILOT_PROVIDER_BEARER_TOKEN`）也一樣不會傳給它們。那個環境裡的其他憑證，例如 `GITHUB_TOKEN` 或 AWS 的變數，仍會傳給這些 agent 與它們執行的指令，和其他 CLI 一樣。金鑰顯示成 `••••` 加最後四個字元，短的金鑰只顯示 `••••`。
- **自訂端點**：你自己的 OpenAI 相容伺服器，例如 vLLM、Ollama、LM Studio 或 llama.cpp。**＋ 新增端點** 要填：
  - **名稱**：設定頁上顯示的名字，例如 *Homelab vLLM*。
  - **id**：它的模型 id 的開頭，例如 `homelab`：只能有小寫字母、數字與 `-`（不能在開頭或結尾），最多 32 個字元，也不能是 `openai`、`anthropic` 或 `xai`。在你自己輸入之前，它會跟著名稱產生；建立後不能修改（端點改名時 id 不變）。
  - **網址（base URL）**：`http://` 或 `https://`，不含帳號、密碼、查詢字串或 `#`，例如 `http://10.0.0.5:8000/v1`。在這台電腦上的伺服器，網址必須寫出埠號（Ollama 是 `http://localhost:11434/v1`），也不能是 Harness Relay 自己的位址，不論怎麼寫（`localhost`、`127.0.0.1`、`[::1]`、這台電腦的網路位址）：那裡的 `PORT`、8787、8789 與 5173 埠（`npm start` 與桌面 app 的，以及 `npm run dev` 的 API 與 Vite）都會被拒絕，所以本機的模型伺服器請用其他埠。
  - **模型名稱**：一行一個，寫成伺服器認得的名稱（不能有空白）。Harness Relay 不會向伺服器查詢模型清單，所以請自己輸入。
  - **API key（選填）**：給需要金鑰的伺服器；修改時留空則保留目前的金鑰。

  **修改** 可以改端點，**刪除** 會連同它的金鑰一起刪除；使用它的模型的成員，要改選其他模型才能執行。Claude Code、Codex、Grok 與 Copilot 的成員也一樣：它們的這一輪會說端點已被刪除，也不會改送到那個 CLI 自己的服務。重新新增同 id 的端點後，它們就能再在上面執行。端點被刪除期間跑過一輪的 Claude Code、Codex、Grok 或 Copilot 成員，會在那裡開始新的 session；其他成員則接續它的 session，和修改端點之後一樣。刪除的 id 會列在 **已刪除的端點**，直到你再新增同 id 的端點或按 **忘掉**：如果某個 CLI 自己的模型剛好以同樣的名稱開頭（例如刪掉端點 `qwen` 之後，你 Codex 設定裡的 `qwen/…`），忘掉它，那個模型就能再交給那個 CLI。

成員的模型寫成「模型來源/模型」：`openai/…`、`anthropic/…`、`xai/…`，或端點的 id 加上模型名稱，例如 `homelab/muse-glimmer-30b-nvfp4`。第一個 `/` 之前是模型來源，所以模型名稱本身也可以含 `/`。

CLI 已安裝、且至少設定了一個模型來源時，開源 agent 的卡片會顯示 **可使用**（否則是 **尚未就緒**），並說明它特別的地方。它沒有自己的登入或 API key。在 **預設模型與推理強度** 可以設定它的預設模型（寫成「模型來源/模型」）與推理強度，以及它的 **執行檔**。它的模型選單會先列出 CLI 自己的模型中、模型來源已設定的那些，再列出每個端點的模型；**自訂…** 可以輸入任何 id。維持「預設」的成員，會用它選單上顯示的預設模型：它卡片上的預設模型，沒有的話，用 CLI 自己的預設模型（那個模型的來源已設定時）；兩者都沒有時，選單會說明需要指定模型，這一輪也會請你挑一個。推理強度的選項是各 CLI 自己的，端點的模型通常沒有。它的卡片也能用 **查詢** 列出它自己載入的內容（見[各 CLI 自己載入的內容](#各-cli-自己載入的內容)）。

Harness Relay 讓這些 agent 在它自己的家目錄中執行，絕不使用你的（不會讀你的 `~/.config/opencode`、`~/.config/goose`、`~/.cline`、`~/.openhands` 或 `~/.pi`），並在每次執行前寫入它們的設定：設定了[各 CLI 自己的資料夾](#agent-的-session各-cli-自己的資料夾與-agentsview)時放在那裡，否則放在 `data/agent-homes/`。

#### 各 agent 要注意的地方

| | 核准 | 你拒絕時，模型會收到你的留言 | 值得知道的事 |
| --- | --- | --- | --- |
| **OpenCode** | 依權限詢問修改、指令與 MCP 工具 | 會 | 完全存取以外，Harness Relay 會監看 OpenCode 自己的伺服器，有任何其他東西操作它（核准請求、開啟或驅動另一個 session、改變它的權限），或監看本身中斷時，就結束這次執行，並在對話中顯示安全性錯誤：在 macOS 上，它的指令讀得到 OpenCode 啟動時環境變數裡那個伺服器的密碼。不論哪種權限，它的 LSP 伺服器與 formatter 都關閉（它們光是讀檔就會執行專案的程式）。完全存取以外，它的 subagent 會關閉。它不讀專案的 `opencode.json` 與 `.opencode/`，但會拿到專案的 `AGENTS.md`（或 `CLAUDE.md`）。沒有安裝 `rg` 時，它會從 GitHub 下載 ripgrep，沙箱會為此詢問你。詢問 MCP 工具時，卡片無法顯示工具的參數。 |
| **Goose** | 每個工具呼叫都詢問；唯讀時，單純讀取的指令（`cat`、`ls`、`rg`…）不詢問，因為 Goose 用 shell 讀檔，但只限單純的指令行：沒有要 shell 展開的 `$`、萬用字元、大括號或 `~`，沒有 `xargs` 之類的包裝，選項只能來自每個程式的允許清單（不會寫檔或執行其他程式的），git 一律詢問；唯讀時，交給 recipe 或 agent 的 `delegate` 也會詢問，因為它可能啟動指令 | 會，在 Goose 自己的「已拒絕」之後以一則訊息傳入 | 它的 skill（專案的 `.goose/skills`、`.claude/skills`、`.agents/skills`）與專案的 recipe 和 agent 無法排除。每次執行前，它的設定資料夾裡不是 Harness Relay 寫的東西都會清掉，所以先前的執行埋不下 plugin 或 recipe。系統層級的 `/etc/goose/config.yaml` 仍然有效。 |
| **Cline** | 每個工具呼叫都詢問，讀取也是 | 不會：它的模型只看到 Cline 固定的「已拒絕」訊息；你的留言只顯示在對話中 | 沒有 plan 模式，也沒有待辦清單。推理強度是每次執行設定的（`--thinking`）。圖片以路徑傳入。它在這次執行自己的暫存資料夾裡啟動，所以從不讀專案的 `.env` 與 `bunfig.toml`（它的工具照樣在專案裡運作）。它會載入專案的 `AGENTS.md`、`.clinerules`、`.cline/rules`、skill、hook 與 plugin（hook 與 plugin 會執行程式；hook 與規則沒有開關，plugin 可以逐項排除），以及你 `~/.agents` 裡的 skill。 |
| **OpenHands** | 每個動作都詢問；它一起發出的呼叫會合成一張列出全部的卡片（好幾個修改時列出每個檔案），一次回答就涵蓋全部；唯讀時，叫用 skill 也會詢問，因為 skill 可能執行指令；完全存取以外，不提供它會不經詢問執行指令的 subagent | 不會：只有 OpenHands 自己固定的話 | 在 macOS 上，要等你在「設定」打開它的開關（**讓 OpenHands 在沙箱裡使用終端機**，預設關閉），它才會在完全存取以外執行：它的終端機這時會讓它的指令能在你其他的終端機視窗印出文字、讀取內容。啟動較慢（約 2.5 秒）。**停止** 會暫停它，但不會中止正在執行的指令：它的程序在兩秒後結束。被停止或當掉的回合留下、還在等待的動作，會在下一輪接續前被拒絕，所以絕不會沒經過你同意就執行。沒有 tmux 時，它的終端機偶爾會顯示一個沒有發生的失敗。很長的 session 會用同一個模型額外呼叫幾次來做摘要。專案的 `AGENTS.md`、`.agents/skills` 與 `.openhands/hooks.json` 一定會載入，它也可能把 `AGENTS.md` 當作記憶來修改。 |
| **Pi** | Pi 自己不會詢問：完全存取以外，Harness Relay 的 gate 擴充功能在每個工具呼叫前詢問，MCP 工具也是；唯讀時它只有讀取的工具 | 會 | 沒有計畫或待辦清單。只有 session 檔寫明屬於這個工作目錄時才會接續。它會載入從工作目錄往上直到 `/` 的每個 `AGENTS.md` / `CLAUDE.md`，只能全部一起排除。它的 `find` 需要 fd，`grep` 需要 ripgrep。 |

五個都一樣：每位對話成員的 session、記錄與快取都是它自己的，其他對話或其他成員的開源 agent 執行都無法讀取或修改（完全存取以外的 Claude Code、Codex、Grok、Cursor、Antigravity 與 Muse Code 讀得到，就像它們讀得到彼此的；Copilot 的沙箱讓它的指令讀不到你的家目錄，而這些資料夾通常就在那裡）；token 與成本來自各 CLI 的回報（端點的模型沒有成本）；在原生 Windows 上只能以完全存取執行，Linux 上的 OpenCode 也一樣；在 Linux 上，完全存取以外需要 bubblewrap、socat 與 ripgrep（見[檔案權限](#對話規則)）。細節見[開源 agent](open-agents.zh-TW.md)。

### 多個帳號

每個 CLI 都能同時登入多個帳號，例如兩個 Claude 訂閱（公司和個人）、Codex 的三個 ChatGPT 帳號、Grok 的三個 xAI 帳號：每個 CLI 最多 10 個，含預設帳號（可用 `RELAY_MAX_ACCOUNTS` 調整）。打開 CLI 各帳號下方的 **新增帳號**，取個名稱（或用建議的名稱），按 **新增帳號**。它會和預設帳號一樣有自己的框；每個帳號都各自登入、登出、設定 API key，也有自己的預設模型與推理強度、自己決定不載入哪些項目，做法和上面相同。

- **預設帳號** 就是你原本的帳號：CLI 平常的家目錄（或[各 CLI 自己的資料夾](#agent-的-session各-cli-自己的資料夾與-agentsview)），以及啟動 Harness Relay 時環境變數裡的 API key。按 **重新命名** 也能幫它取名。
- **其他每個帳號** 都有自己的 CLI 資料夾（登入、設定與 session 紀錄），路徑顯示在名稱下方：設定了各 CLI 自己的資料夾時放在裡面，否則放在 Harness Relay 的資料夾（`data/accounts/<cli>-<id>`）。這個帳號只用自己的 API key：啟動 Harness Relay 的環境變數裡的憑證都不會傳給它（Claude Code 的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`，Codex 的 `CODEX_API_KEY`、`OPENAI_API_KEY`，Grok 的 `XAI_API_KEY`，Cursor 的 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`，Antigravity 的 `GEMINI_API_KEY`，Copilot 的 `COPILOT_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`，Muse Code 的 `META_API_KEY`），所以它的成員執行的指令也看不到它們。在某個帳號開始 Codex 登入，只會登出那個帳號。CLI 自己的資料夾會隨帳號移動，但有些 CLI 仍會自己讀你家目錄的部分內容（例如 Cursor、Grok 與 Codex：Cursor 讀 `~/.cursor`，Grok 與 Codex 讀 `~/.agents/skills` 的 skill）；「設定 → 該 CLI」列出每個帳號會載入的 skill、MCP 伺服器與 hook（各 CLI 會讀什麼，見 [Agent 的 session](#agent-的-session各-cli-自己的資料夾與-agentsview)）。[工具庫](#工具庫mcp-伺服器skill-與記憶)照常提供。新帳號使用 CLI 自己的預設模型與推理強度，也不略過任何項目。
- **選擇帳號**：在團隊設定裡用每位成員的 **帳號** 選擇，[首席 agent](#首席-agent) 則在它的卡片上選。CLI 有不只一個帳號時才會出現這個選單；選單會標出尚未登入的帳號，成員的帳號尚未登入時卡片也會提醒。沒有選帳號的成員使用預設帳號。新成員、以及首席 agent 設計的團隊中的成員，預設帳號已登入時用預設帳號，否則用第一個已登入的帳號；留任的成員保留原本的帳號。
- 成員換到另一個帳號時，會開始新的 CLI session（並收到目前為止的對話），因為原本的 session 存在另一個帳號的資料夾。
- **移除** 會登出這個帳號，刪除它的 API key 和資料夾（包括 CLI 在裡面的 session 紀錄）；原本用它的成員之後改用預設帳號。有對話正在執行時不能移除。預設帳號不能移除。
- Grok 的資料夾信任會一次記錄到每個 Grok 帳號；之後新增的 Grok 帳號，一開始就信任預設帳號信任的資料夾。
- **Cursor 的其他帳號只能用 API key 登入。** Cursor 在每個電腦使用者只保留一個登入（macOS 上存在登入鑰匙圈；Linux 與 Windows 上存在一個不會跟著它的資料夾移動的檔案），所以再登入一個帳號就會蓋掉預設帳號的登入。額外的 Cursor 帳號框裡會說明這一點，不提供 **登入**，並直接展開它的 **API key**；這把金鑰只用在這個帳號的執行。它的資料夾只放 Cursor 的設定與 session，沒有登入，所以 **移除** 不會在 Cursor 登出任何東西。預設帳號的 **登出** 會登出這台電腦上 Cursor 自己的登入，即使這個帳號設了 API key 也一樣。
- **Antigravity 的其他帳號只能用 Gemini API key 登入。** Antigravity 把 Google 登入存在系統的 keyring 裡，而 Harness Relay 無法確認另一個資料夾會把另一個登入分開保存，所以額外的 Antigravity 帳號框裡不提供 Google 登入，而是直接展開它的 **API key**；這把金鑰只用在這個帳號的執行，這個帳號也只用它執行：沒有自己的金鑰時，它顯示為未登入，而且絕不會用預設帳號的 Google 登入執行，也不會用啟動 Harness Relay 時環境中的 `GEMINI_API_KEY` 或 `AGY_ADC_AUTH`。它的資料夾放的是 Antigravity 的 `.gemini` 資料夾（設定、對話紀錄、skill、MCP 伺服器與 hook），沒有登入，所以登出它或 **移除** 都不會在 Antigravity 登出任何東西。
- **Copilot 的其他帳號各自登入**，每個帳號有自己的 Copilot 家目錄，用 GitHub 裝置代碼或 GitHub token 登入。Copilot 把 token 依 GitHub 帳號名稱存在系統的金鑰儲存區，而不是依資料夾，所以兩個以同一個 GitHub 使用者登入的帳號會共用它，登出其中一個也會讓另一個登出（沒有確認過）。
- **Muse Code 的其他帳號只能用 Meta API key 登入。** 在 macOS 上，Muse Code 把 Meta 登入存在登入鑰匙圈裡，名稱不隨它的資料夾改變（另一個資料夾裡的登入檔只是指向那裡），所以登入第二個帳號可能取代預設帳號的登入。額外的 Muse Code 帳號框裡不提供 Meta 登入，而是直接展開它的 **API key**；這把金鑰只用在這個帳號的執行，這個帳號也只用它執行：沒有自己的金鑰時，它顯示為未登入，而且絕不會用預設帳號的 Meta 登入執行，也不會用啟動 Harness Relay 時環境中的 `META_API_KEY`。它的資料夾放的是 Muse Code 的設定與資料資料夾（設定、MCP 伺服器、hook 與 session），沒有登入，所以登出它或 **移除** 都不會在 Muse Code 登出任何東西。

### 方案用量

帳號登入或設了 API key 後，它的區塊會顯示**方案用量**：它的 CLI 回報的方案還剩多少，每個額度一條長條，以及剩下多少、用了多少、何時重置。Claude Code 顯示 5 小時與每週額度（以及某個模型自己的每週額度），Codex 顯示它的時段（例如 5 小時與一週）與點數，Grok 顯示這週用掉的點數比例，Muse Code 顯示它的訂閱額度，Copilot 顯示這個月的 premium 請求（以次數計，例如 300 次用了 126 次），Antigravity 顯示每組模型的額度，以及它的方案與點數。Harness Relay 在那個帳號的資料夾向 CLI 詢問，不送 prompt，所以不會用掉額度，每個帳號顯示自己的；帳號的區塊出現在畫面上時才問，登入或金鑰改變時再問（包括在終端機改的，在設定頁重新檢查 CLI 之後）。回答保留兩分鐘；按**重新查詢**立即再問。

- **用 API key 的帳號**（Claude Code、Codex、Grok、Antigravity、Muse Code）沒有方案額度：供應商按用量向金鑰計費，一般的 API key 也查不到剩餘餘額，所以區塊會這樣說明。餘額請到供應商的主控台查看。
- **Cursor** 只在它自己的終端畫面（`/usage`）顯示用量，所以預設帳號的區塊只列出方案；其他的在 Cursor 的 Dashboard。用 Cursor API key 的帳號與 Cursor 的其他帳號兩者都不顯示。
- 用 GitHub token 的 **Copilot** 顯示那個 GitHub 帳號自己的方案：token 屬於它。用 `claude setup-token` 產生的 token 登入，或在 Bedrock、Vertex 上執行的 Claude Code 不回報方案額度，區塊會這樣說明。Antigravity 的數字是對照 agy 使用的格式檢查的，沒有用真正的 Google 帳號試過。
- 沒有訂閱額度（按用量計費）的 Muse Code 帳號會說明它沒有額度。

### 預設模型與推理強度

在帳號框裡的 **預設模型與推理強度** 區塊，設定使用這個帳號的成員（以及首席 agent 用這個帳號時）模型 / 推理強度選「預設」時要用什麼。每個帳號各自設定；模型清單與 CLI 的預設值是在這個帳號的資料夾裡查詢的。若這裡也維持 **CLI 預設**，就交給 CLI 在這個帳號資料夾裡的設定（例如預設帳號的 `~/.codex/config.toml`）；Cursor 則是它自己設定裡的模型，沒有另外選過就是 Auto。Cursor 會列出每個模型各自能用的推理強度：Auto（由它自己挑模型）和只有思考開關的模型沒有推理強度，以它們自己的強度執行；模型不支援的推理強度不會傳給它。Antigravity 的模型清單來自在這個帳號資料夾裡執行的 `agy models`，每個 Gemini 模型一項（例如 `gemini-3.8-flash` 或 `gemini-3.1-pro`），它提供的思考等級就是它的推理強度（low、medium 與 high，或只有 low 與 high）；它的 **CLI 預設** 是它自己設定裡指定的模型（與等級），前提是指定的是其中之一。Copilot 列出這個帳號方案中的模型，是在它自己的資料夾裡開啟一個不送 prompt 的 session 來查詢的（所以不會執行任何專案的 hook，也不會留下 session）；它的 **CLI 預設** 是帳號自己的預設模型，列出的推理強度是那個模型的（沒有的話是 low 到 max）。不接受推理強度的模型（例如 Claude Haiku 4.5）會不帶推理強度執行。Muse Code 只在 session 裡列出它的模型，所以 Harness Relay 提供一份固定的清單（Muse Spark 1.3 與 1.2，各自也有 *contributor* 版本，以讓 session 的資料被使用換取較低的價格，以及 Muse Ember 1.0；**自訂…** 可以輸入其他 id），推理強度是 minimal、low、medium、high、xhigh 與 max；它的 **CLI 預設** 是它自己 `settings.json` 裡的 `model` 與 `reasoning_effort`（沒指定推理強度時是 `high`）。開源 agent 只有一組設定、沒有其他帳號，它的 **CLI 預設** 是 CLI 自己的預設模型（那個模型的來源已設定時）。在團隊設定裡，成員的模型選單會顯示它所用帳號的模型與預設值。各帳號下方的 **執行檔** 可以指定路徑，用於 CLI 不在 `PATH` 中的情況，這個 CLI 的所有帳號都會使用。找不到 CLI 時，該卡片會說明，並附上到官網安裝的連結（[Claude Code](https://claude.com/product/claude-code)、[Codex](https://openai.com/codex/)、[Grok](https://x.ai/build)、[Cursor](https://cursor.com/cli)、[Antigravity](https://antigravity.google/download)、[Copilot](https://github.com/features/copilot/cli)、[Muse Code](https://dev.meta.ai/products/muse-code/)、[OpenCode](https://www.npmjs.com/package/opencode-ai)、[Goose](https://formulae.brew.sh/formula/block-goose-cli)、[Cline](https://www.npmjs.com/package/cline)、[OpenHands](https://pypi.org/project/openhands/)、[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）。

### 首席 agent

**✦ 首席 agent** 決定在[自動組隊](#自動組隊)的對話中，由哪個 CLI（以及選填的模型與推理強度）來設計團隊，也由它把新對話分到你的[群組](#群組)。請選一個已登入的 CLI，或已有模型來源（與模型）的開源 agent；通常小而快的模型就夠用。首席 agent 不能問你任何事：工作目錄裡有專案替 Copilot 準備的 hook 時，Copilot 不會啟動；有專案自己的設定時，Antigravity 也一樣，因為這些都要先問過你（見[核准](#核准)）；設計團隊時會像首席 agent 失敗時那樣改用替代方案。這種專案請選其他 CLI。

**預設工作目錄** 決定新對話預設在哪些資料夾工作（agent 從第一個開始；見下方的 **工作目錄**）。有資料夾還不存在時，Harness Relay 會列出不存在的資料夾，詢問是否要建立（新對話的工作目錄、在團隊設定裡修改的工作目錄也一樣）。

### 各 CLI 自己載入的內容

每個帳號的框裡都有 **這個 CLI 自己載入的 skill、MCP、hook 與記憶等**：展開後按 **查詢**，就能看這個 CLI 在這個帳號的資料夾、預設工作目錄下自己的設定（Claude Code 也包含預設工作目錄之後的那些，它也會載入其中的 skill），和工具庫分開，每類一個分頁：它的 **Skills**（附來源）、**MCP 工具**（每個 MCP 伺服器，CLI 有回報時附狀態，以及它提供的工具）、**內建工具**（Claude Code）、**Hooks**（何時執行、在哪裡設定，不顯示指令）、**Subagents**（Claude Code、Grok 與 Cursor，以及 Antigravity 與 Copilot 的自訂 agent）、**Plugins**，以及它會讀的 **指示** 和 **記憶** 檔。Harness Relay 查詢時不會送 prompt，所以不會呼叫模型：Claude Code 與 Codex 回答時會啟動它們的 MCP 伺服器，Claude Code 也會執行你設定的 hooks。Cursor 沒有這種查詢，它的清單來自它已知會讀的檔案，不會啟動它。Antigravity 用 `agy -p /skills`、`/hooks` 與 `/agents` 列出它的 skill、hook 與自訂 agent，這些指令不必呼叫模型、不會開對話，也不耗用額度（未登入時會失敗，只顯示一則說明），再用 `agy plugin list` 列出 plugin；它的 MCP 伺服器與指示檔則來自它會讀的檔案。Copilot 用 `copilot mcp list`、`skill list`、`instruction list` 與 `plugin list` 列出它的 MCP 伺服器、skill、指示檔與 plugin，這些指令不會開啟 session；它的 hook 與自訂 agent 則來自它會讀的檔案。Muse Code 用 `muse skills list --json` 列出它的 skill，查詢時用一個和執行時一樣、它自己的設定資料夾，所以專案的 skill（Muse 只在它信任的工作區才載入）不會列出；它的 MCP 伺服器（只列名稱）與 hook（事件與 matcher，絕不列出指令）來自它的 `settings.json`。為了列出工具，會送給 Claude Code `/usage`，這是它自己回答的指令（不花費用量，也不會留下 session）；如果你有名為 `usage` 的 skill 或指令，就不送，內建工具也就不會列出。展開這一區不會查詢，所以你可以先改不載入的設定，不必啟動 CLI。Claude Code 和 Codex 沒有提供指示檔清單，所以列出的是依它們的讀檔規則找到、目前存在的檔案。點檔案或有路徑的 skill 就能閱讀內容（Markdown 可切換預覽與原始內容）。

每個分頁也能讓 Harness Relay 以這個帳號啟動這個 CLI 的每一次執行（使用這個帳號的成員的回合；首席 agent 用這個帳號時，它的執行與把對話分類到群組）不載入其中的項目。每個帳號各自設定，因為各有自己的 skill、MCP 伺服器與 hook。分頁最上方的 **全部不載入** 會關掉這一類的全部；查詢之後，每個項目前的勾選框可以只關掉那一項（CLI 能做到時）。每次變更都會立刻儲存，分頁上會標示不載入的情形，這一區的標題會顯示總共不載入幾項。開啟 **全部不載入** 時，這個分頁裡個別的勾選會保留，取消後恢復。CLI 自己的設定檔不會被修改，所以在終端機使用它不受影響，工具庫的項目也照常提供。有項目設為不載入時，**查詢** 也會依 Harness Relay 啟動它的方式再問一次，把那時不會載入的項目標示為 **不載入**，讓你看到執行時實際拿到什麼（例如拒絕 Claude Code 的 `Bash`，它的 `Monitor` 工具也會一起消失）；勾選了但 CLI 仍然載入的項目會標示為 **仍會載入**。查詢結果裡已經沒有的勾選項目（之後被刪掉，或屬於預設工作目錄以外的專案的檔案或 skill）會在清單下方列出數量，並可一鍵清除。查詢後若改了不載入的設定，請重新查詢；再問一次時若逾時，CLI 已回答的部分仍會標示，其餘會說明沒有標示。各 CLI 能不載入哪些：

- **Claude Code**：每一類都能全部不載入，也能逐項勾選：skill 依名稱（plugin 指令與自訂指令也列在一起）、MCP 伺服器與它的每個工具、內建工具、指示檔、subagent（內建的也可以）與 plugin。它的 hook 沒有名稱，自動記憶是一整份，所以這兩類只能全部不載入。各類的 **全部不載入**：skill 也包括 plugin 指令與自訂指令；MCP 是它自己的伺服器都不啟動，只保留工具庫的，而個別勾選的伺服器仍會啟動，只是它的工具不提供給成員（工具庫裡同名的伺服器工具照常提供）；內建工具全部不載入後，成員只能對話並使用 MCP 工具（Harness Relay 依權限關掉的工具不論這裡怎麼設都會關掉；沒有任何能讀檔工具的成員，簡報裡不會列出工具庫的 skill）；指示檔是各層的 `CLAUDE.md` 與規則檔；記憶是它的自動記憶；hook 是設定檔與 plugin 裡的 hook；subagent 是你自己的與 plugin 的（內建的照常提供，除非你或專案有同名的 subagent 取代了它：這時那個名稱在執行中就沒有 subagent）；plugin 會關掉每個已安裝的 plugin，連同它的 skill、subagent、hook 與 MCP 伺服器。Claude Code 無法列出它的 plugin，或無法不載入它的 subagent 時（舊版 Claude Code），這次執行會失敗並說明原因，而不是照常載入。
- **Codex**：每一類都能全部不載入，也能逐項勾選：skill、你設定檔裡的 MCP 伺服器與它的每個工具、hook 與 plugin。MCP 開關也會關掉 ChatGPT apps；plugin 帶來的伺服器在 Plugins 分頁設定。指示檔是專案裡的 `AGENTS.md`，只能全部不載入：Codex 仍會讀它自己的 `~/.codex/AGENTS.md`。Hook 也包括 plugin 的 hook；plugin 會連同它們的 skill、MCP 伺服器與 hook 一起關掉。設為不載入的 skill、hook 或 plugin 若仍被 Codex 載入（不認得這項設定的舊版 Codex），這次執行會失敗並說明原因。Codex 不列出 subagent，也沒有只略過它自己 subagent 的開關。Codex 會沿用對話開始時載入的 skill 清單（包括 plugin 帶來的 skill）、指示檔與記憶，所以這些變更從新對話開始生效；MCP 伺服器、它們的工具與 hook 的變更下一回合就生效。Codex 無法列出它的 MCP 伺服器時，這次執行會失敗並說明原因，而不是照常執行它們。
- **Grok**：只能全部不載入，而且 skill、MCP 伺服器與 hook 只有從 Claude Code、Cursor 匯入的（包括專案的 `.claude/skills` 與 Claude Code plugin 的 skill，但不包括它們的 hook）。Grok 自己找到的 skill 照常載入，包括 `~/.agents/skills`、`~/.grok/skills`、專案的 `.grok/skills` 與 `.agents/skills`，以及內建的：要關掉，請在 `~/.grok/config.toml` 的 `skills.disabled` 列出名稱，Grok 自己的 MCP 伺服器也在那裡關閉。這個檔案是 Grok 的全域設定：在那裡的變更也會影響你在終端機使用 Grok，Harness Relay 不會修改它。個別項目、指示檔與它的 plugin 都沒有單次執行的開關（plugin 要在 `~/.grok/config.toml` 的 `plugins.disabled` 關閉），也沒有只略過它自己 subagent 的開關（它的 subagent 開關會連內建的一起關掉）。
- **Cursor**：都不行。它沒有任何設定或變數能讓單次執行不載入這些項目，所以它的分頁（Skills、MCP 工具、Hooks、Subagents、指示）只顯示它會載入什麼：工作目錄與家目錄裡 `.cursor`、`.claude`、`.codex`、`.grok`、`.agents` 底下 `skills` 資料夾的 skill，以及它內建的；`~/.cursor/mcp.json` 的 MCP 伺服器（專案 `.cursor/mcp.json` 裡的會標示 `needs approval`：要先在 Cursor 裡核准才會載入，而 Harness Relay 的執行從不詢問，所以不會載入）；`~/.cursor/hooks.json` 與你組織的 hook，以及 `~/.claude/settings.json` 裡 Claude Code 的 hook（列為 *Claude Code*：Cursor 也會載入，一律從這個檔案，不論你讓 Claude Code 的執行不載入哪些），它們在 Harness Relay 的執行中也會在它的工具呼叫上執行；工作目錄 `.cursor/agents` 與 `.claude/agents` 裡的 subagent；以及工作目錄與它上層每個資料夾的 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md` 與 `.cursor/rules`。設在 Cursor 帳號上的規則不是檔案，所以不會列出。
- **Antigravity**：都不行。`agy acp` 沒有任何旗標或設定能讓單次執行不載入這些項目，所以它的分頁（Skills、MCP 工具、Hooks、Subagents、Plugins、指示）只顯示它會載入什麼：它的 skill（內建的、你在 `~/.gemini/config/skills` 的、專案 `.agents/skills` 的，以及 plugin 的）；`~/.gemini/config/mcp_config.json` 以及從工作目錄到 repository 根目錄之間、專案 `.agents/mcp_config.json`（或 `.agent`、`_agents`、`_agent`）的 MCP 伺服器，專案的優先（只列名稱，絕不列出它們的設定）；它的 hook，附事件、matcher 與檔案，絕不列出指令；它的自訂 agent 與 plugin；以及從工作目錄到 repository 根目錄之間的 `GEMINI.md`、`AGENTS.md` 與 `.agents/rules/*.md`。它的 hook 與 MCP 伺服器在 Harness Relay 的執行中也會執行，而且在任何沙箱之外；在完全存取以外的權限，專案自己的（以及它的 plugin）要在這一輪開始前經你允許才會執行（見[核准](#核准)）。
- **Copilot**：skill（它的 skill 工具與 skill 清單都不提供給這次執行）、MCP 伺服器（它自己的都不啟動：`~/.copilot/mcp-config.json` 裡的與內建的 GitHub MCP 伺服器；工具庫的照樣啟動，plugin 的則跟著 plugin 走，沒有略過 plugin 時仍會啟動）、記憶、hook（你在 `~/.copilot` 的：專案的 hook 照樣會執行，因為不管設定怎麼寫，Copilot 都會執行它們，所以在完全存取以外的權限，這一輪開始前會先問你）與 plugin（一個都不載入，也不載入它們帶來的東西）都能整類略過；skill 與 MCP 伺服器也能依名稱逐一略過。它的指示檔無法略過（Copilot 透過 ACP 執行時不套用 `--no-custom-instructions`：`AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md` 與你自己的 `copilot-instructions.md` 照常載入），它的自訂 agent 與內建工具也不行。專案自己的 MCP 伺服器（`.mcp.json`、`.github/mcp.json`）在 Harness Relay 的執行中從不載入，因為這些執行不信任任何資料夾，所以它們一律標為略過。它的分頁會列出它的 hook（你在 `~/.copilot/hooks` 與它的 `settings.json` 裡的，以及專案 `.github/hooks` 裡的），附事件與 matcher，以及它的自訂 agent（在 `~/.copilot/agents`，以及專案的 `.github/agents` 與 `.claude/agents`）。在完全存取以外的權限，專案的 hook 要在這一輪開始前經你允許才會執行（見[核准](#核准)）。
- **Muse Code**：它的 MCP 伺服器（全部，或依名稱；`muse mcp add` 寫入的也算）與它的 hook（只能全部一起，連同它的 managed hook；plugin 自己的 hook 會保留），Harness Relay 會把它們從這次執行自己的設定中拿掉；你自己的 `settings.json` 不會被改動。它的分頁是 Skills、MCP 工具與 Hooks。它的 skill（內建的、你在 `~/.config/muse/skills` 與 `~/.agents/skills` 的，以及你 Claude Code 與 Codex 的）與指示檔（它自己的規則，也就是它設定資料夾裡的 `AGENTS.md`，預設帳號是 `~/.config/muse`；沒有的話是你的 `~/.claude/CLAUDE.md`）沒有單次執行的開關。在完全存取以外的權限，Harness Relay 的執行不信任任何工作區，所以專案自己的 `AGENTS.md` 與 `CLAUDE.md`、skill 與 `.muse/hooks.json` 都不會載入；完全存取時工作區受信任，它們就會載入。
- **開源 agent** 在 Harness Relay 自己的家目錄中執行，所以只會列出專案的檔案與它們自己找到的東西。**OpenCode**：skill（全部，或依名稱）、Harness Relay 交給它的指示檔，以及 subagent（全部，或依名稱；完全存取以外本來就關閉）。**Goose**：它的 plugin（全部，或依資料夾）、plugin 啟動的 MCP 伺服器，以及指示檔（`.goosehints`、`AGENTS.md`），後兩者只能全部一起；它的 skill 無法排除。**Cline**：skill 只能全部一起，內建工具與 plugin 可以逐項；它的規則與 hook 無法排除。**OpenHands**：什麼都不能排除（會列出專案的指示、skill、subagent 與 hook）。**Pi**：它的指示檔，只能全部一起。

Grok 只有在你信任過的資料夾，才會讀專案自己的 `AGENTS.md` / `CLAUDE.md`、skill、MCP 伺服器與 hooks。資料夾尚未信任時，Grok 卡片會標示出來；團隊裡有 Grok 成員時，團隊編輯器的工作目錄下方也會提示。在這種資料夾開始一個有 Grok 成員的新對話時，會先問你：**信任並開始**、**不信任，直接開始**或 **取消**。Grok 是以整個專案決定信任：工作目錄在 git 儲存庫裡時，被信任的是儲存庫的根目錄（解析連結後），確認時也會這樣說明。按 **信任這個資料夾** 會先請你確認這個資料夾，再用和 `grok --trust` 相同的方式記錄（在 `~/.grok/trusted_folders.toml`，或 `$GROK_HOME`）。請只信任你信任的專案：信任後 Grok 也會執行專案的 hooks。工具庫的項目不管有沒有信任都會提供給 Grok。**重新查詢** 會更新結果（結果保留一分鐘）。

設定頁上方的區塊連結在任何語言下都排成一行（放不下時可以橫向捲動，滑鼠滾輪也可以），捲動時會固定在頂端，並標亮你正在看的卡片，點了會跳到對應的卡片；每張卡片的標題也連到自己（例如 `#/settings/tools`），可以加入書籤。app 其他地方的連結（尚未登入的 CLI、首席 agent、語音輸入、工具庫）也會直接打開對應的卡片。

### 工具庫：MCP 伺服器、skill 與記憶

**設定 → 工具庫** 讓你一次設定好工具，給每位成員使用，不管它跑在哪個 CLI。這些工具是加在各 CLI 自己的設定之外。有登入的 CLI 保有它自己資料夾裡的設定（預設帳號是你的 `~/.claude`、`~/.codex/config.toml`、`~/.grok`、`~/.cursor`、`~/.gemini`、`~/.copilot` 與 `~/.config/muse`），這個資料夾會隨 [設定 → Agent 的 session](#agent-的-session各-cli-自己的資料夾與-agentsview) 或帳號移動；但不論資料夾或帳號，有些 CLI 仍會自己讀你家目錄的部分內容（例如 Cursor、Grok 與 Codex：Cursor 讀 `~/.cursor`，Grok 與 Codex 讀 `~/.agents/skills` 的 skill）。「設定 → 該 CLI」列出每個帳號會載入的 skill、MCP 伺服器與 hook，也標出在那裡設成不載入的。開源 agent 則用 Harness Relay 自己的設定資料夾。變更從成員的下一回合開始生效。

- **MCP 伺服器**：按 **新增 MCP 伺服器**，取一個名稱（英文字母、數字、`_` 和 `-`），再選 **本機指令**（stdio：指令、每行一個參數、環境變數）或 **網址**（Streamable HTTP，可加 HTTP 標頭）。環境變數和標頭的值通常是 token，會跟 API key 一樣存進系統的金鑰儲存區，頁面上只顯示遮蔽後的值；編輯時把值留空就會保留原本的值。工具呼叫和其他動作一樣受對話權限限制：權限範圍以外的會在對話中詢問你（對話設成自動拒絕時則直接拒絕）。
- **Skills**：輸入有 `SKILL.md` 的資料夾，或包含多個 skill 的資料夾（例如 `~/.claude/skills`），按 **加入**。找到不只一個 skill 時，會列出裡面所有 skill（資料夾本身，以及往下兩層內的 skill 資料夾），勾選要加入的，也可以篩選後 **全選**。這些 skill 是加在各 CLI 自己的 skill 之外：CLI 本來就會讀的 skill（Grok、Cursor 與 Muse Code 會讀 `~/.claude/skills`，Claude Code 在它平常的家目錄時也會）不管有沒有加到這裡都能用；加到這裡則讓每種 CLI 都能用，並能選擇給誰。每位成員的說明會列出 skill 的名稱和用途（取自 `SKILL.md` 開頭的 front matter），需要時 agent 會自己讀那個 `SKILL.md`。`SKILL.md` 不見了、或名稱和另一個 skill 重複的會被標示出來，不會提供給 agent。
- **記憶**：放進每個對話成員說明裡的筆記，例如你的偏好和專案慣例。**所有成員** 每個人都收到；每個 CLI 的分頁（**Claude Code**、**Codex**、**Grok**、**Cursor**、**Antigravity**、**Copilot**、**Muse Code**、**OpenCode**…）只給該 CLI 的成員，接在共用記憶後面。

**預設提供給**：每個 MCP 伺服器和 skill 都可以選要給哪幾種 CLI 的成員：全部都給（預設）、只給其中幾種，或都不給（這時只給你在團隊設定裡勾選的成員）。Harness Relay 能執行 Cursor、Antigravity、Copilot、Muse Code 與開源 agent 之前就加入的項目，維持原本給的那幾種 CLI：勾選這些 CLI 才會也給它們的成員。要針對單一成員調整，見[團隊成員](#團隊成員)的 **工具**。

### Agent 的 session：各 CLI 自己的資料夾與 AgentsView

**設定 → Agent 的 session** 有兩個選用的設定。它們和其他設定一起存在 Harness Relay 裡，所以不論 macOS、Linux 或 Windows，都照常用 `npm start`（或 `npm run dev`）啟動。

**各 CLI 自己的資料夾**：預設各 CLI 用它們平常的家目錄（`~/.claude`、`~/.codex`、`~/.grok`、`~/.cursor`、`~/.copilot`、Antigravity 的 `~/.gemini`，以及 Muse Code 的 `~/.config/muse` 與 `~/.local/share/muse`），也就是你自己執行 CLI 時用的那一個。在這裡填入一個資料夾（完整路徑，或以 `~` 開頭的路徑），或按 **使用 ~/.relay-agents**，Harness Relay 就會在裡面替每個 CLI 準備自己的家目錄：`claude`、`codex`、`grok`、`cursor`、`antigravity`、`copilot` 與 `muse` 子資料夾（Antigravity 的 `.gemini` 資料夾放在 `antigravity` 裡，Muse Code 的設定與資料資料夾放在 `muse` 裡，分別是 `config/muse` 與 `data/muse`）。之後各 CLI 的登入、設定與 session 紀錄都放在那裡，和你平常直接使用 CLI 時分開。

- 各 CLI 要重新登入一次（在上方各 CLI 的卡片，或設定 API key）：新的家目錄一開始是空的。[每個帳號](#多個帳號)都是如此：其他帳號的資料夾也會改放在新的資料夾裡，舊的則連同登入資料留在原處，要自己刪除（**移除** 只會刪掉帳號目前的資料夾）。Cursor 例外：它的登入屬於你的電腦使用者，不在它的資料夾裡，所以仍然是登入狀態；移過去的只有它的設定與 session。Antigravity 把 Google 登入存在系統的 keyring，不在它的資料夾裡（之後是否仍算登入沒有驗證過：它的卡片顯示未登入時請重新登入）；移過去的是它的設定、skill、MCP 伺服器、hook 與對話紀錄。Copilot 把登入的是誰記在它的資料夾（`config.json`），token 則依你的 GitHub 帳號名稱存在系統的金鑰儲存區：它的卡片顯示未登入時請重新登入（沒有確認過）。
- 各 CLI 放在平常家目錄裡的內容不再載入，但有好幾個 CLI 不論給它哪個資料夾，仍會自己讀你家目錄的部分內容：
  - **Claude Code**：專案在你家目錄底下時，家目錄裡的指示檔（`~/CLAUDE.md`、`~/CLAUDE.local.md`、`~/.claude/CLAUDE.md` 與 `~/.claude/rules`，因為它會讀專案上面的每一層），以及 `~/.mcp.json` 的 MCP 伺服器。
  - **Codex**：`~/.agents/skills` 的 skill。
  - **Grok**：這些；`~/.claude/skills` 與 `~/.cursor/skills` 的 skill；Claude Code 的指令、subagent 與 plugin（plugin 的 hook 會執行）；`~/.claude.json` 與 `~/.cursor/mcp.json` 的 MCP 伺服器；以及 `~/.claude/CLAUDE.md` 與 `~/.claude/rules`。
  - **Muse Code**：`~/.agents/skills`、`~/.claude/skills` 與 `~/.codex/skills` 的 skill，以及它沒有自己的規則時的 `~/.claude/CLAUDE.md`。
  - **Cursor**：`~/.cursor` 裡它的 skill、MCP 伺服器與 hook（只有它的設定與 session 會移動，它的登入本來就屬於你的電腦使用者）；`~/.claude`、`~/.codex`、`~/.grok` 與 `~/.agents` 的 skill；`~/.claude/settings.json` 裡 Claude Code 的 hook；以及專案在你家目錄底下時的 `~/AGENTS.md`、`~/CLAUDE.md`、`~/CLAUDE.local.md` 與 `~/.cursor/rules`。
  - **Antigravity** 與 **Copilot** 都不讀，唯讀的對話除外，因為那時 Harness Relay 不會把工作目錄變成 git repository：工作目錄在你家目錄底下、又不在任何 repository 裡時，Copilot 會載入 `~/.agents/skills`、`~/.github/skills` 與 `~/.github/agents`；你的家目錄本身是 git repository（有些人這樣管理 dotfiles），而工作目錄在它裡面、自己又不是 repository 時，Antigravity 會載入專案放在那裡的東西：`~/GEMINI.md`、`~/AGENTS.md`，以及 `~/.agents`（或 `~/.agent`、`~/_agents`、`~/_agent`）裡的規則、skill、subagent、MCP 伺服器、hook 與外掛，其中的 MCP 伺服器、hook 與外掛會執行，低於完全存取時要等你在回合開始前允許（見[核准](#核准)）。所有 Antigravity 帳號也共用 agy 自己的使用者資料夾（Linux 上是 `~/.config/antigravity`）。
- 「設定 → 各 CLI」列出它會載入的 skill、MCP 伺服器與 hook，但不是每個指示檔都列。[工具庫](#工具庫mcp-伺服器skill-與記憶)裡的工具照常提供給每位成員。
- 成員在下一回合會開新的 session，並取得對話的完整紀錄：之前的 session 留在原本的家目錄。
- session 紀錄在那個資料夾的 `claude/projects/`、`codex/sessions/`、`grok/sessions/`、`cursor/acp-sessions/`、`antigravity/.gemini/antigravity-cli/conversations/`、`copilot/session-state/` 與 `muse/data/muse/sessions/`。
- 開源 agent 的家目錄也放在這裡（`opencode`、`goose`、`cline`、`openhands`、`pi`）；沒有設定資料夾時，它們的家目錄在 `data/agent-homes/`。

請選專案以外的資料夾：在 Harness Relay 自己的資料夾或預設工作目錄裡面的會被拒絕，因為那裡的快照會把各 CLI 的登入與 session 紀錄一起收進去。有對話正在執行時不能更改這個資料夾。把欄位清空，就會改回平常的家目錄。

**AgentsView**：[AgentsView](https://www.agentsview.io) 是在你電腦上瀏覽 agent session 的免費工具，看得到每則訊息、每個工具呼叫、token 與成本。在這裡填入它的網址，Harness Relay 會在每個回合結束後、以及你重新命名對話時，把對話送過去。每個對話在 AgentsView 中是一個以對話標題命名的 session，底下是各 agent 自己的 session（首席 agent 和分群用的 session 也在內），成本也會加總。Cursor 與開源 agent 自己的 session 所在之處 AgentsView 讀不到（Cursor 把 session 存在 AgentsView 不讀的資料庫裡；開源 agent 把每位成員的 session 存在 Harness Relay 家目錄中它自己的資料夾），所以這些成員改由 Harness Relay 送出它記下的 session：每次回覆前，上次回覆之後大家說了什麼；接著是它的思考、工具呼叫與輸出的結尾（指令、讀取或編輯的檔案、搜尋與擷取網頁，都像 Claude Code 自己的一樣顯示）、它請求的核准、它的回覆；最後是它的 token。AgentsView 認得模型時會依 token 算出成本；CLI 回報的成本不加到對話的成本，AgentsView 只在 `agentsview session usage` 中顯示它，網頁上看不到（你自己端點上的模型不回報成本）。在 AgentsView 刪掉這種 session 後，它會一直是刪掉的。這種 session 以成員名稱與它的 CLI 命名，AgentsView 會把它列為 Claude Code 的 session。用 Cursor 或開源 agent 的首席 agent 或分群在 AgentsView 中沒有 session：Harness Relay 沒有記下它做了什麼。Copilot 的 session 由 AgentsView 自己讀取，來自它家目錄裡的 `session-state`，每次執行都會連結到帳號的那一個。在 macOS 與 Linux 上，AgentsView 也會顯示它們的 token 數，從 Copilot 的 `session-store.db` 讀取：每次執行的家目錄也會把這個檔案連結到帳號的那一個。在 Windows 上則不會顯示：那裡要連結到檔案需要開發人員模式，所以執行的家目錄只把 `session-state` 資料夾連結過去（用 junction），`session-store.db` 是它自己的，會跟著它一起刪除；Copilot 另外寫在 session 本身的總量（它的 `session.shutdown` 紀錄），AgentsView 不會算進去（用 AgentsView 0.46.1 讀 Copilot 1.0.109 在 Windows 11 上寫的 session 確認過）。成員若用的是 AgentsView 自己讀取 session 的 CLI 的[其他帳號](#多個帳號)，它的 session 會存在那個帳號自己的資料夾（`data/accounts/<cli>-<id>`，或各 CLI 自己的資料夾中的 `<cli>-<id>`），AgentsView 不會自己去讀：要把那個資料夾加進 AgentsView 的設定，它的 session 才會出現在對話底下（做法如下；某個 CLI 在那裡的 `dirs` 會取代 AgentsView 預設替它讀的資料夾，所以也要把平常那個列進去，例如 `~/.copilot`；Claude Code 與 Codex 的 `homes` 則是加在預設之外）。啟動 Harness Relay 的環境設了 `COPILOT_HOME`（且沒有設定各 CLI 自己的資料夾）時也一樣：Copilot 的預設帳號就在那個資料夾，AgentsView 要等它列進 `[agents.copilot] dirs`（或 `COPILOT_DIR`）才會讀。只接受這台電腦上的網址。更新失敗時（例如 AgentsView 沒有在執行），卡片上會說明原因，不影響對話。

- 設定網址之前就有的對話，會在它的下一回合結束後送出。
- 在 Harness Relay 刪除對話，已經送到 AgentsView 的內容會留著；需要的話請在 AgentsView 裡移除。
- **開啟用的網址（選用）**：**開啟 AgentsView** 預設打開上面的網址。想從其他裝置打開 AgentsView，例如[透過 Tailscale](remote-access.zh-TW.md#5-也瀏覽-agentsview選用) 用手機打開，就在這裡填那個網址。對話仍然送到上面的網址。

想在 AgentsView 中只看到 Harness Relay 的 session，先設定各 CLI 自己的資料夾（見上方），再執行一個只讀那個資料夾的 AgentsView：

1. 安裝 AgentsView（見[它的快速入門](https://www.agentsview.io/docs/quickstart/)）。
2. 在你的家目錄建立 `.relay-agents/agentsview/config.toml`：

   ```toml
   [agents.claude]
   dirs = []
   homes = ["~/.relay-agents/claude"]

   [agents.codex]
   dirs = []
   homes = ["~/.relay-agents/codex"]

   [agents.grok]
   dirs = ["~/.relay-agents/grok/sessions"]

   [agents.antigravity-cli]
   dirs = ["~/.relay-agents/antigravity/.gemini/antigravity-cli"]

   [agents.copilot]
   dirs = ["~/.relay-agents/copilot"]

   [agents.muse]
   dirs = ["~/.relay-agents/muse/data/muse/sessions"]
   ```

   Copilot 填的是它整個家目錄：AgentsView 從其中的 `session-state` 讀它的 session，從它的 `session-store.db` 讀這些 session 每個回合的用量（Windows 上執行時用的是自己的那一份，見上方）。Cursor 與開源 agent 在這裡什麼都不用設：Harness Relay 會自己送出它們的 session。CLI 的每個[其他帳號](#多個帳號)在這些資料夾旁邊都有自己的資料夾，以 CLI 的子資料夾名稱加上帳號的 id 命名（例如 `copilot-1a2b3c4d`、`muse-5e6f7a8b`；列出 `~/.relay-agents` 的內容就找得到）：把它加進那個 CLI 的清單，後面接上和預設帳號相同的路徑（`"~/.relay-agents/copilot-1a2b3c4d"`、`"~/.relay-agents/muse-5e6f7a8b/data/muse/sessions"`；Claude Code 與 Codex 則加在 `homes`，例如 `homes = ["~/.relay-agents/claude", "~/.relay-agents/claude-9c0d1e2f"]`），否則用那個帳號的成員的 session 不會出現在 AgentsView。電腦上有 AgentsView 支援的其他工具（Cursor、Gemini CLI……）時，它也會讀那些工具的預設資料夾。不想要的話，把它們列在 `disabled_agents`（見 [AgentsView 的設定說明](https://www.agentsview.io/docs/configuration/)）。
3. 讓它的資料放在那個資料夾，用你選的 port 啟動（這裡用 9999）。macOS 與 Linux：

   ```bash
   AGENTSVIEW_DATA_DIR=~/.relay-agents/agentsview agentsview serve --port 9999
   ```

   Windows PowerShell：

   ```powershell
   $env:AGENTSVIEW_DATA_DIR = "$HOME\.relay-agents\agentsview"
   agentsview serve --port 9999
   ```

   Windows 命令提示字元：

   ```bat
   set AGENTSVIEW_DATA_DIR=%USERPROFILE%\.relay-agents\agentsview
   agentsview serve --port 9999
   ```

   加上 `--background` 可以在關掉終端機後繼續執行；要停止時，用同樣的 `AGENTSVIEW_DATA_DIR` 執行 `agentsview serve stop`。
4. 在 **設定 → Agent 的 session → AgentsView** 填入 `http://127.0.0.1:9999`，按 **儲存**。

AgentsView 預設會隱藏使用者只說了一則訊息的 session。你只傳過一則訊息的對話，會在你傳下一則訊息後出現，或在 AgentsView 的 session 篩選中開啟 **Include single-turn** 後出現。

想用手機瀏覽 AgentsView，見[用手機連線](remote-access.zh-TW.md#5-也瀏覽-agentsview選用)。

## 3. 開始對話：新對話與範本

app 打開時是首頁：只有 logo 與一句標語。點側邊欄最上面的 logo 或 **Harness Relay** 就會回到首頁。要開始，點 **＋ 新對話**。在這裡選擇團隊在哪裡工作、可以做什麼——**工作目錄**、**檔案權限**，以及**權限範圍以外的動作**要怎麼處理（見[對話規則](#對話規則)）——以及首席 agent 組的團隊要不要先讓你確認（**直接採用首席 agent 組的團隊，不必等我確認**；頁面會記住你的選擇）。按 **開始對話 →**，然後提出你的第一個問題。

你不必為對話挑選團隊：首席 agent 會為每個問題選一個（見[自動組隊](#自動組隊)），依據的是這個頁面上的[範本](#範本)；設計團隊就是在範本裡進行。

### 自動組隊

每個新問題都有它的團隊。**首席 agent**（見[首席 agent](#首席-agent)）會讀你的問題、到目前為止的對話（精簡過的）、目前的團隊，以及所有範本（內建與你自己存的）的完整內容（成員、角色、模式與輪數），然後決定沿用目前的團隊、直接套用某個範本、依範本調整（例如增減成員、改寫角色、換模式或輪數），或從頭設計新團隊。

它會依每個 coding agent 能做什麼來分配成員：每個已登入 CLI 的每個模型、各自支援的推理強度與預設推理強度，以及各 CLI 在工作目錄裡自己載入的內容（內建工具、skill、MCP 伺服器與它們的工具、subagent、plugin，不含你[設為不載入](#各-cli-自己載入的內容)的項目），再加上[工具庫](#工具庫mcp-伺服器skill-與記憶)：每個 CLI 的成員預設會拿到哪些 MCP 伺服器、skill 與記憶，以及目前團隊和範本裡每位成員實際拿到哪些。所以需要搜尋網路或使用某個服務的成員，會放在有那個工具的 CLI 上；困難的推理工作會用較強的模型或較高的推理強度。首席 agent 只看工具，不會改：誰拿到工具庫的哪些項目，維持你的設定（在設定頁和每位成員的 **工具**）。詢問各 CLI 載入了什麼（不會呼叫模型）是在它新成員會用的[帳號](#多個帳號)的家目錄裡進行，模型清單與預設值也以那個帳號為準；已經在其他帳號的成員，模型、預設值、自己的 skill 與 MCP 伺服器可能不同。在一個資料夾第一次詢問需要幾秒鐘（超過 20 秒還沒回答的 CLI，這次設計會標為未知）；之後首席 agent 會直接用上次的答案，並在背景重新詢問各 CLI。

它寫角色時（調整或設計團隊，或新增、改寫某個成員），會用那位成員的模型最適合的方式來寫：Claude、GPT、Gemini、Grok、Muse、Cursor 的 Composer 與開放權重模型，各家都有自己對怎麼下指示的建議。首席 agent 只參考你已登入的 CLI 會跑的模型的建議，每個模型也會標明適用哪一份（Cursor 或 Copilot 的 Auto 自己挑模型，所以沒有），唯讀的對話裡也不會要求修改檔案。每個角色的第一行說明這位成員是誰：隊友看到的就是這一行。你範本裡的角色則維持你寫的樣子。

- 首席 agent 的決定會以 **團隊設計** 卡片出現在對話中：沿用的目前團隊、直接套用的範本、依哪個範本調整，或新設計的團隊；原因；以及每位成員的完整角色，太長時會折疊成幾行（按 **顯示更多** 看全部，[分享出去的頁面](#分享對話)上也一樣）。
- 預設由你確認：在卡片上按 **確認團隊**，團隊就會回答你的問題。確認前側邊欄會把這個對話標為 **等你確認團隊**；這段期間（甚至首席 agent 還在設計時）你寫的訊息會停在輸入框上方，和你的問題一起交給團隊。**調整團隊** 會開啟團隊設定，你可以自己修改這份設計，或請首席 agent 修改（見[對話中修改團隊](#對話中修改團隊)）；在那裡儲存修改也算確認。只有最新一份設計會出現 **調整團隊**：它就是現在的團隊，較早的卡片則是紀錄。
- 勾選 **直接採用首席 agent 組的團隊，不必等我確認**（在新對話頁面，或之後在 **團隊設定** 裡），團隊就會立刻回答；卡片上仍會顯示首席 agent 選了什麼、為什麼（**已直接採用**）。
- 不是每則訊息都是新問題。回答 agent 的提問、@ 目前團隊成員的訊息（由被 @ 的成員回答）、**繼續**、**重試** 與排程訊息，都會直接交給目前的團隊，不會重新設計。
- 留下來的成員（名稱與 CLI 都相同）會保留他們的 session 與已經知道的事，以及你替他們設定的帳號與 **工具**；新成員會從頭讀這段對話。
- 工作目錄與檔案權限由你決定；首席 agent 不能更改。
- 如果團隊是首席 agent 設計或調整的，卡片會問你要不要保留：按 **存成範本** 就會存起來（可以重新命名），之後會出現在 **範本** 中，讓首席 agent 直接選用。直接套用的範本或沿用的目前團隊本來就在，卡片不會詢問。
- 如果首席 agent 的回答無法使用（或它的 CLI 執行失敗），會沿用目前的團隊（第一個問題則改用「一般問題智囊團」），卡片上會說明原因。若在它設計團隊時按 **■ 停止**，按 **繼續** 或提出下一個問題時會重新設計團隊。
- 原本要在尚未就緒的 CLI（未登入，或沒有模型來源的開源 agent）上執行的成員，會改用首席 agent 的 CLI。首席 agent 可以安排任何已就緒的 CLI，包括開源 agent，並使用它們選單裡列出的模型。
- 編輯問題（見[複製、編輯與重試](#複製編輯與重試)）會為它重新設計團隊（除非修改後 @ 了成員，那就由他們回答），並需要再確認一次（勾了直接採用時則不必）。
- 卡片上的 **不採用，沿用目前的團隊** 會婉拒這份設計，改由原本的團隊回答（第一個問題，或首席 agent 本來就沿用團隊時不會出現）。在你確認或不採用之前，對話仍保留目前的團隊：**重試** 或編輯較早的訊息都還是用它（並刪除等待中的設計）。等待期間，**團隊設定** 會顯示這份等待中的設計，在那裡儲存就會照你修改後的樣子採用。
- 團隊有 Grok 成員、而 Grok 還不信任工作目錄時，卡片會在你確認前提醒你，並附上 **信任這個資料夾**。

### 範本

範本是你設計團隊的地方；首席 agent 會針對每個問題挑選、調整或取代它們。內建範本：

| 範本 | 模式 | 團隊 |
| --- | --- | --- |
| 架構師 → 實作者 → 審查者 | 接力 | Claude 規劃、Codex 實作、Grok 審查，用 `@` 交棒 |
| 三方辯論 | 圓桌兩輪 | 提案者、務實派、懷疑者，適合設計討論與技術選型 |
| 平行解題比較 | 平行 | 三個 agent 各自獨立解同一個問題 |
| 一般問題智囊團 | 圓桌 | 分析師 → 查核者 → 整合者，適合任何問題，不限寫程式 |
| 結對程式 + QA | 圓桌 | Navigator 指路、Driver 寫碼、QA 測試 |

點範本（或 **＋ 新增範本**）會跳出對話框：**範本名稱**、**說明**（首席 agent 挑範本時會讀它，所以寫清楚這個團隊擅長什麼）、**團隊成員**（見[團隊成員](#團隊成員)），以及他們如何輪流（模式，以及輪數或交棒次數；見[對話規則](#對話規則)）。你自己的範本修改後按 **儲存範本** 就地更新，按 × 刪除。內建範本不能修改，但調整過內容後，可以按 **另存成我的範本** 保留你調整過的版本。**＋ 新增範本** 會從空白團隊開始：每個可用的 CLI（已安裝且有登入的帳號）各一位成員，定位留白；頁面還在詢問各 CLI 時先不放成員，知道之後才出現。範本裡有成員用的 CLI 在這台電腦還不能用（沒有安裝或沒有登入）時，打開範本會把那位成員改用可以用的 CLI，有範本還沒用到的就優先選它：對話框會列出被改過的成員，儲存就會照這樣保存。有修改還沒儲存時，關閉對話框前會先詢問。範本沒有工作目錄或權限：那些屬於對話。內建範本會跟著介面語言顯示。

### 團隊成員

每張卡片是一個 agent：

- **@名稱**：用於 `@` 的名稱。可用字母、數字、`_`、`-`（中文也可以），團隊內不能重複。
- **Claude Code / Codex / Grok / Cursor / Antigravity / Copilot / Muse Code / OpenCode / Goose / Cline / OpenHands / Pi**：由哪個 CLI 執行這個 agent。同一個 CLI 可以有多個 agent（例如兩個不同角色的 Claude）。CLI 尚未就緒的卡片會說明原因（未登入、沒有模型來源、找不到 CLI），並附上前往它設定卡片的連結。
- **帳號**：由這個 CLI 的哪個帳號執行這個 agent，CLI 有[多個帳號](#多個帳號)時才會出現。例如三位 Codex 成員可以各用一個帳號。
- **定位 / 角色**：自由描述這個 agent 的定位與職責。這是最重要的欄位：告訴它負責什麼、*不*該做什麼、要交棒給誰。
- **模型**：CLI 回報的可用模型，或選 **自訂…** 自行輸入模型 ID。「預設」會使用設定頁的預設值，沒有的話用 CLI 自己的預設。開源 agent 的模型寫成「模型來源/模型」（見[開源 agent 與模型來源](#開源-agent-與模型來源)）：從你設定好的模型來源中挑一個，或在設定頁指定它的預設模型。Claude Code、Codex、Grok 與 Copilot 也會列出你的自訂端點的模型，讓它們在你自己的伺服器上執行。
- **推理強度**：只列出所選模型支援的等級（例如 low / medium / high / xhigh）。換成不支援目前等級的模型時，會自動改回預設。
- **↑ ↓**：調整順序。在圓桌模式中就是發言順序；在接力模式中第一位是**隊長**。
- **工具**：這位成員從[工具庫](#工具庫mcp-伺服器skill-與記憶)拿到的項目會以標籤列出，按 **調整** 打開清單勾選。預設勾選狀態依成員的 CLI 而定（預設不給這個 CLI 的項目會註明），其他 CLI 的記憶分頁不會列出。伺服器或 skill 改名後選擇仍保留。這些是加在成員的 CLI 自己會載入的內容之外；卡片在工具庫沒有給這個 CLI 的項目時，以及按 **調整** 打開清單後在清單上方，會說明是什麼：有登入的 CLI 也會載入它自己的設定（它的 skill 和 MCP 伺服器，來自它自己的資料夾，這個資料夾會隨 **設定 → Agent 的 session** 或帳號移動；有些 CLI，例如 Cursor、Grok 與 Codex，也會讀你家目錄的部分內容；「設定 → 該 CLI」列出成員所用帳號會載入的 skill、MCP 伺服器與 hook，不含在那裡設成不載入的）；開源 agent 用的是 Harness Relay 自己的設定資料夾，而不是你家目錄裡它自己的那個，所以你在那裡的設定不會被讀取（「設定 → 該 CLI」列出它還會自己載入的，例如專案的 `AGENTS.md`）。設定頁查詢的是預設工作目錄：在其他資料夾的對話，也可能載入那個專案自己的設定。工具庫沒有給這位成員的 CLI 的項目時（工具庫是空的，或只有給其他 CLI 的記憶），卡片會說明，並附上前往工具庫的連結。

用 **＋ Claude Code**、**＋ Codex**、**＋ Grok**、**＋ Cursor**、**＋ Antigravity**、**＋ Copilot**、**＋ Muse Code** 或各開源 agent 的按鈕新增成員（最多 8 位，或 `RELAY_MAX_TEAM_AGENTS` 允許的人數）。

### 對話規則

**模式**

| 模式 | 行為 | 適合 |
| --- | --- | --- |
| 圓桌 | 依序發言，每個人都看得到前面的人說了什麼。可設定輪數（1–5）；某一輪所有人都回覆 `[PASS]` 時提前結束。 | 討論、審查、逐步改進答案 |
| 平行 | 所有 agent 同時、獨立回答；下一輪才看得到上一輪的答案。 | 比較不同做法、取得獨立意見 |
| 接力 | 一次一位發言。agent 用 `@名稱` 把發言權交給隊友；沒有 @ 任何人就交還給你。可設定每則訊息的最多交棒次數（1–30）。 | 流水線：規劃 → 實作 → 審查 |

**工作目錄**：所有 agent 工作的資料夾，大家共用。一個對話最多可以有八個，每個在輸入框裡是一個標籤（按 × 移除）；agent 從第一個（粗體）開始，其他的也以同樣的權限交給它們（Cursor 在第一個裡工作；可編輯模式下，它用自己的工具寫入其他的之前會先問你，但 `/tmp` 這類暫存資料夾除外，Cursor 在那裡寫入不會詢問）。每一個都和第一個一樣：在可編輯模式下會變成 git repository，每則回覆會記錄在其中改了哪些檔案，平行模式下每位 agent 也各有一份副本。要加入資料夾，輸入路徑後按 Enter：輸入時，最後一個字後面會跟著一個 Enter 鍵提示（點它也能加入）。在空白的輸入框按 Backspace 會移除最後一個資料夾，離開輸入框時還留著的路徑也會加入。點一下輸入框或旁邊的箭頭，或按 ↓，就能從使用中的工作目錄挑選：預設工作目錄在最前面（標示 **預設**），接著是各對話使用的工作目錄，最近用過的在前；已經不存在的資料夾不會列出，已經選了的以粗體顯示。邊輸入，清單只留下包含你輸入的每個詞的路徑（不分大小寫，`~` 代表家目錄，在 Windows 上 `/` 與 `\` 視為相同），所以名稱含空格的資料夾也找得到。用滑鼠（清單會保持開著，方便再選一個），或用 ↑ ↓ 與 Enter 選擇；Esc 收起清單。有八個資料夾時，輸入框會說明已達上限，移除一個之前不能再加。輸入框有焦點時，箭頭旁會出現資料夾按鈕：點了會開啟系統的選擇資料夾視窗（就像選擇要上傳的檔案時那樣），可以一次選多個資料夾（macOS 與 zenity；kdialog 與 Windows 一次選一個），選好的資料夾都會加入。視窗會開在你正在輸入的路徑，否則開在最後一個資料夾（或它上層最近一個存在的資料夾）。這個按鈕只出現在執行 Harness Relay 的那台電腦的瀏覽器中，因為視窗開在那台電腦上；在 Linux 上需要 zenity 或 kdialog。設定頁的預設工作目錄也有同樣的輸入框、清單與按鈕。

**檔案權限**：對話中所有 agent **不必詢問**就能做的事：

| 等級 | 不必詢問就能做 |
| --- | --- |
| 唯讀 | 讀檔、搜尋、上網查資料（Copilot 也會在它的沙箱中執行它認為是唯讀的指令，例如 `ls`、`cat`、`git status` 與 `echo`）。 |
| 可編輯 | 另外還能修改工作目錄中的檔案，並執行測試、建置等專案指令（Claude Code 限常用的一組指令；Codex 則是沙箱內的任何操作，沙箱無法連網；Cursor 沒有，每個指令都會詢問，你的 Cursor 團隊允許清單上的除外；寫入那些一改就可能讓程式碼之後執行的檔案，例如 `.git/config` 與 `.vscode/`，也會詢問；Antigravity 同樣沒有，每個指令都會詢問，寫到工作目錄以外、或寫進那些一改就可能讓程式碼之後執行的資料夾，例如 `.agents` 與 `.git/config`，也會詢問；Copilot 則是沙箱內的任何操作，但寫進那些一改就可能讓程式碼之後執行的資料夾，例如 `.github/hooks` 與 `.git/hooks`，會詢問，MCP 工具呼叫與儲存記憶也會詢問；Muse Code 則是沙箱內的任何操作，但把內容用管線交給 shell 或要連網的指令會詢問，寫進 `.muse`、`.agents`、`.git/hooks` 與 `.git/config`（Muse 會詢問的那些）也會詢問）。不包含推送與發佈。 |
| 完全存取 | 所有操作，不再詢問。請只在信任的目錄使用。 |

在完全存取以外的權限，Claude Code、Codex、Grok、Copilot 與 Muse Code 的指令都在它們那個 CLI 的作業系統沙箱中執行，只能寫入工作目錄與暫存資料夾（有多個工作目錄時，每一個都可以）。Codex 的沙箱也讓指令無法連網，Claude Code 的沙箱會在指令要連到每個主機時詢問你；Grok 的沙箱只有在 Linux 上擋得了網路；Copilot 的沙箱讓指令可以連網，但讀不到你的家目錄（Harness Relay 會讓它們讀你的 git 設定，git 少了它就不能執行：`~/.gitconfig`，以及 `~/.config/git` 裡的 `config`、`ignore` 與 `attributes` 檔，不包括 git 可能放在那裡的憑證檔）；Muse Code 的沙箱會對要連網的指令詢問，Harness Relay 不論哪種模式都會問你。在原生 Windows 上只有 Codex 與 Copilot 的沙箱裝好就能用；Muse Code 1.4.18 在那裡完全存取以外的權限不執行任何指令，完成 Muse 自己的沙箱設定後也一樣，因為 Harness Relay 驅動它的那個模式在 Windows 上不用沙箱（見[各平台的作業系統沙箱](sandboxing.zh-TW.md)）。Copilot 的沙箱在 macOS 與 Windows 上不需要另外安裝；在 Linux 上需要 bubblewrap 0.5 以上、slirp4netns、util-linux 2.35 以上、iproute2、iptables、`/dev/net/tun`，以及 unprivileged user namespace 與 network namespace（Ubuntu 24.04 會限制它們），缺少時它執行的每個指令都會失敗，不會有任何指令在沙箱外執行（見[各平台的作業系統沙箱 → Linux](sandboxing.zh-TW.md#linux)）；都備齊時，它的指令連得到網際網路，但連不到這台電腦自己 loopback（`127.0.0.1`）上的服務，所以在那裡，連到你啟動的本機資料庫或 dev server 的測試會失敗：請改用這台電腦的區域網路位址。每一輪 Copilot 開始前，Harness Relay 會檢查 Copilot 回報的沙箱政策，不是 Harness Relay 設定的那一份時（或 Copilot 沒有回報它的 allow-all 開關，那時它可能是開著的），這一輪就不會開始。專案的 hook，或你自己的 Copilot hook、plugin、擴充功能或語言伺服器，會在 Copilot 的 session 開啟時執行的話，會先另外短短啟動一次、在什麼都不會執行的地方檢查沙箱，所以它們也在沙箱內執行。你自己的 Copilot 設定，它的執行只保留模型、proxy、你拒絕的網址、Copilot 是否把 session 同步到 GitHub（`remoteExport`）與是否自動更新，以及它自己載入的內容，絕不保留你的沙箱、允許的網址、權限模式或存下的核准。在可編輯模式下，Copilot 寫入各工作目錄不必詢問，但那些一改就可能讓程式碼之後執行的資料夾（`.github/hooks`、`.github/copilot`、`.github/mcp.json`、`.agents`、`.claude`、`.vscode`、`.git/hooks`……，不分大小寫）除外，這些會詢問；寫到工作目錄以外，Copilot 自己會不經詢問就拒絕。它的指令也改不了這些資料夾：這一輪開始時已經存在的那些（`.git/hooks`、`.git/config`、`.vscode`、`.claude`……），Harness Relay 會交給 Copilot 的沙箱設為唯讀；它的 dev-tool access 本來會讓指令寫入的共用套件與建置快取（npm、pnpm、Yarn、Bun、Deno、pip、uv、Poetry、Cargo、Go、Maven、Gradle、Playwright 等）也一樣，所以之後在沙箱外的建置或指令，不會執行指令留在那裡的東西。和 Codex 與 Claude Code 一樣，在完全存取以外的權限，會寫入這些快取的安裝相依套件會失敗；請交給完全存取的一輪，或自己安裝。在 macOS 上，指令可以把工作目錄裡那些唯讀資料夾的上一層改名再改回來（`mv .git .g`…）來繞過它們；Harness Relay 自己的 git 絕不執行 repository 的 hook，但你之後自己執行的 git 會。可編輯模式下，它的 MCP 工具呼叫與儲存記憶也會詢問（Copilot 內建的 GitHub MCP 伺服器能推送檔案、開 pull request，而且在任何沙箱之外；記憶則存在 GitHub 上，給所有使用這個 repository 記憶的人）。Cursor 在 Harness Relay 執行它的模式下，不管哪個系統都沒有沙箱：在完全存取以外的權限，它要執行的每個指令都會詢問你（對話設為自動拒絕時則直接拒絕），測試與建置也一樣，但 Cursor 團隊管理員放進團隊自動執行允許清單的指令除外（Harness Relay 無法清除它）；你允許的指令會以你的權限執行，也能連網。它自己的工具讀檔不必詢問，在可編輯模式下修改工作目錄裡的檔案也不必詢問，但那些一改就可能讓程式碼之後在任何沙箱之外執行的檔案（`.git/hooks`、`.git/config`、`.vscode/`、`.claude/*.json`、`.cursor/*.json`、`*.code-workspace`……）除外：Cursor 會詢問這些，也會詢問寫入工作目錄外的檔案（寫成 `~/…` 的家目錄路徑也算；`/tmp` 這類暫存資料夾除外，它在那裡寫入不會詢問），以及寫入這個對話其他工作目錄的檔案（它只在第一個裡工作），Harness Relay 則會問你，卡片上會說明是哪一種。Antigravity 在 Harness Relay 的執行中同樣沒有沙箱（它自己的沙箱會讓它的指令寫不進工作目錄，所以 Harness Relay 不開啟它；你自己的 Antigravity 設定，它的執行只保留模型與服務，所以你的終端機沙箱、權限或信任的資料夾在那裡都不適用）：在完全存取以外的權限，它要執行的每個指令都會詢問你（對話設為自動拒絕時則直接拒絕），測試與建置也一樣；你允許的指令會以你的權限執行，也能連網。它自己的工具讀檔與網路搜尋不必詢問，在可編輯模式下寫入各工作目錄也不必詢問，但那些一改就可能讓程式碼之後執行的資料夾（`.agents`、`.gemini`、`.claude`、`.cursor`、`.vscode`、`.mcp.json`、Copilot 的 `.github/hooks` 與 `.github/agents`、`.git/hooks`、`.git/config`……，不分大小寫）除外：這些會詢問，寫到工作目錄以外也會。Muse Code 在它自己的作業系統沙箱中執行（macOS 上是 Seatbelt，Linux 上是它自帶的 bubblewrap，Windows 上則是它自己的沙箱，要先完成設定），依 Harness Relay 每次執行替它寫的權限設定檔，並關掉 Muse 的核准評審（由一個模型決定要詢問什麼）；你自己的 Muse 權限設定與信任的資料夾在這些執行中都不適用。它自己的工具讀檔與網路搜尋不必詢問，在可編輯模式下寫入各工作目錄也不必詢問，但 `.git`、`.muse` 與 `.agents` 底下（以及 `.envrc`）Muse 會詢問：寫進 `.muse`、`.agents`、`.git/hooks` 或 `.git/config` 會問你。工作目錄裡其他 agent 的設定（`.claude`、`.vscode`、`.mcp.json`…）它不經詢問就寫入，和 Claude Code、Codex 與 Grok 一樣；寫到工作目錄以外，Muse 自己就會拒絕。它的沙箱讓它的指令只能讀取 `.git`、`.muse` 與 `.agents`。在完全存取以外的權限，Muse 不信任任何工作區，所以專案自己的 `AGENTS.md`、skill 與 hook（`.muse/hooks.json`，Muse 會在沙箱外執行它）都不會載入；完全存取時會載入。沙箱也讓 agent 碰不到你瀏覽器的資料夾與 Harness Relay 的資料庫（Cursor 自己的檔案工具只靠它這次執行設定裡的拒絕規則，而 Cursor 是拿寫下來的路徑去比對：受保護路徑換個大小寫，或指向它的連結，都擋不住；Antigravity 的只限於它會詢問的呼叫，而它在各工作目錄內的讀取不在其中（經由連結讀到工作目錄以外的會詢問，指向受保護路徑時會被拒絕）；它們的指令只靠詢問；Muse Code 的靠它這次執行權限設定檔裡的拒絕規則，它的檔案工具與沙箱裡的指令都遵守）；工作目錄包含 Harness Relay 本身、語音輸入的資料夾（或位於它裡面）、你的家目錄或 CLI 自己的資料夾時，則會拒絕可編輯模式。要開發 Harness Relay，請從另一個資料夾執行你使用的那份。可編輯模式適合你信任的程式碼：測試、建置和專案腳本執行的都是 agent 能修改的程式碼，所以使用 Grok 時，agent 仍可能透過它們連上網路。使用 Grok、Copilot、Muse Code 與開源 agent 時，可編輯模式會在推送或發佈前詢問，指令包在 shell 語法裡（`if`、`while`、`!`、`{ }`、`eval`、`sudo sh -c`、heredoc）時也一樣，shell 或直譯器要執行從管線拿到的內容（`curl … | sh`）時也會詢問。這只是盡力而為：腳本與程式自己做的事（`npm run`、`make`、腳本檔、git alias、`find -exec`、`ssh`、`python -c`）不會被解讀。提高對話的權限時，每個 agent 下一輪都會帶著完整的歷史開始新的 session，所以以較低權限執行過的 session 絕不會以較高權限接續（Muse Code 會沿用 session 建立時的權限，所以權限往任何方向改變後，以及 Harness Relay 重新啟動後，它的 agent 都會開新的 session）。這是依 CLI 分別記錄的，所以成員換回一個上次以較低權限執行的 CLI 時，在那裡也會重新開始；開源 agent 為這位成員保存的資料夾會先清空，清不掉時這一輪不執行。不信任的程式碼或指示，請使用唯讀，或把權限範圍以外的動作設為自動拒絕。唯讀模式下，Claude Code 修改檔案的工具會完全關閉，Cursor 的則既不能寫入也不能刪除（兩者都會顯示「唯讀模式不允許寫入」）；Antigravity 與 Copilot 的每個寫入都會詢問，你允許的就會寫入（你允許的 Copilot 指令在各工作目錄裡寫入的也是）；Muse Code 寫入檔案的工具會被拿掉，但你允許的指令會在它的沙箱裡執行，而沙箱讓它可以寫入工作目錄。

**開源 agent**（OpenCode、Goose、Cline、OpenHands、Pi）沒有自己的沙箱，所以在完全存取以外，Harness Relay 會把它們每一個，連同它們啟動的一切，放進[它自己的沙箱](sandboxing.zh-TW.md#harness-relay-自己的沙箱)執行：

| 權限 | agent 會詢問什麼 | 沙箱允許它做什麼 |
| --- | --- | --- |
| 唯讀 | 每個修改與每個指令（讀取、搜尋與上網照常執行） | 不能寫入工作目錄，即使你允許了修改或指令也一樣：只能寫入這次執行的暫存資料夾與它自己的 session 資料夾 |
| 可編輯 | 推送與發佈，以及 shell 或直譯器執行從管線拿到的內容（`… \| sh`）；修改與其他指令照常執行 | 也能寫入各工作目錄與對話的附件資料夾 |
| 完全存取 | 都不詢問（agent 自己的全部允許模式） | 沒有沙箱，和其他 CLI 一樣 |

沙箱也讓它們碰不到你瀏覽器的資料夾與 Harness Relay 的資料庫，並讓它們自己的設定維持唯讀。網路方面，這次執行的模型來源不必詢問就連得到；其他主機會在對話中詢問（對話設為自動拒絕時則直接拒絕），但這台電腦自己的位址（或會解析到它的名稱）、agent 自己會連的少數主機，以及一次執行中第 30 個之後的主機，都不詢問就直接拒絕。在 macOS 上，它們執行的指令讀得到上層每個程序啟動時的環境變數，包括 Harness Relay 的伺服器與啟動它的 shell，所以請不要在環境變數裡放 API key 再啟動 Harness Relay（把金鑰存在設定頁）。沙箱無法啟動時（在 Linux 上它需要 `bubblewrap`、`socat` 與 `ripgrep`），這一輪會失敗並說明如何修正；在原生 Windows 上這些 agent 只能以完全存取執行。

**權限範圍以外的動作**：選 **詢問我**（預設）時，agent 想做權限沒涵蓋的事，會在對話中詢問你（見[核准](#核准)）。選 **自動拒絕** 時，這類動作會直接被拒絕，agent 會被告知並改用其他方式。（完全存取時不會顯示這個設定。）

**git 與檔案安全（可編輯 / 完全存取）。**若工作目錄還不是 git repository，Harness Relay 會自動在該處執行 `git init`（絕不會在家目錄或整個磁碟執行），也絕不會 commit 到你的分支。如果工作目錄位在涵蓋整個家目錄的 repository 裡（例如 dotfiles repository），會被拒絕，因為每一輪都得記錄整個資料夾。接著：

- **圓桌 / 接力**：agent 輪流直接修改工作目錄，每則回覆都會記錄該 agent 改了哪些檔案。這類對話執行中時，其他對話無法同時寫入同一個目錄（會出現「正在修改」的訊息）。
- **平行**：每個 agent 在**自己的副本**（git worktree）中工作，不會互相覆蓋。直到你選定一份結果並套用之前，工作目錄都不會被改動（見[檢視與套用修改](#檢視與套用修改)）。

有多個工作目錄時，每一個都各自這樣處理：每一個都會變成 repository（同一個 repository 裡的兩個資料夾共用它），回覆會依資料夾列出改了哪些檔案，這個對話在修改時其他對話無法寫入其中任何一個，平行模式下每位 agent 也會各有每一個的副本。

## 4. 對話

- 按 Enter **送出**，Shift+Enter 換行。用注音或拼音輸入時，Enter 只會選字，不會送出。在手機和平板上，Enter 換行，按 **↑** 送出（接實體鍵盤時，⌘/Ctrl+Enter 也能送出）。你的訊息會照你輸入的方式換行；agent 的回覆則以 Markdown 排版。網址後面直接接中文時（`請看https://github.com/org/repo及…`），連結會在中文開始的地方結束，點了才會開到正確的頁面；網址本身的中文（`/wiki/臺灣`、`?q=中文`）仍然算在連結裡。
- **附加檔案**：可以把圖片（例如截圖）直接貼到輸入框、把檔案拖到輸入框上，或按 📎。每則訊息最多 10 個檔案、每個 20 MB，可以不打字只傳檔案。每個讀到這則訊息的 agent 都會拿到檔案路徑，用自己的工具開啟；圖片（PNG、JPEG、GIF、WebP）也會直接給它看。送出的圖片會顯示成縮圖（點一下開啟原圖），其他檔案則顯示成可以下載的標籤。
- **很長的問題** 在聊天中只會顯示前幾行；按 **顯示更多** 可以看完整內容，按 **收合** 再折起來。
- **`@` 指定成員**：輸入 `@` 會跳出成員清單。訊息中有 @ 時，**只有被 @ 的 agent 會回覆**（接力模式則由他們開始接力）；沒有 @ 時，整個團隊依模式參與。名字後面可以直接接文字（`@Builder請實作`）；程式碼中的 @ 會被忽略。
- **即時串流**：回覆會一邊產生一邊顯示。工具動作（讀檔、改檔、執行指令）和步驟之間的思考會收在同一個可展開的列中，並顯示數量（**5 個動作 · 4 段思考**）；進行中時，這一列會顯示旋轉圖示和正在進行的步驟（或最新一行思考）。展開後可依序看到每一步，被拒絕或失敗的步驟會顯示原因。放不下的長檔案路徑會保留結尾，檔名一直看得到；滑鼠移到步驟上可看完整內容。標題下方的成員標籤會標示誰正在發言；成員很多時這一列可以左右捲動（滑鼠滾輪也可以），並會自動捲到發言者。agent 存在工作目錄裡、並嵌入回覆中的圖片與影片（`![chart](out/chart.png)`）會直接顯示在聊天室：點圖片可開啟原圖，影片可以直接播放。來自網站的圖片會以連結顯示，不會自動載入。agent 為你做的檔案，例如 PDF、簡報或試算表，會顯示成帶有下載箭頭的連結（`[Slides](out/deck.pptx)`）：點一下就會存到你正在用的裝置，不論是那台電腦，還是透過 Tailscale 連線的手機。只有工作目錄（或該 agent 的 worktree）裡的檔案可以下載；agent 會被告知把檔案存在那裡並附上連結。連結的檔案不存在時，連結後面會顯示 **⚠ 無法下載 …** 與原因；等 agent 做好檔案後再點一次即可。Mermaid 程式碼區塊會畫成圖表：按 **原始碼** 看程式碼、按 **複製** 複製它，點一下圖表可在「符合寬度」與「實際大小」之間切換。比聊天室還寬的表格可以左右捲動：短的儲存格維持一行，長的會換行但保有好讀的寬度，不會每欄都被擠成一行一個字。程式碼區塊也可以左右捲動。
- **回覆中插話**：團隊回覆時輸入框照樣可以用。按 Enter，訊息會先停在輸入框上方，在下一位 agent 發言前送到（平行模式則在下一輪開始前）；當時正在發言的成員，下一次發言時才會看到。@ 了成員的訊息會等到該成員發言（之後送出的訊息也會排在它後面，維持你送出的順序）。如果直到這次執行結束都沒有回合接到它，團隊會開新的一輪回答它。它在對話中會標上 **插話**。送到之前可以按 **編輯**（文字會回到輸入框）或 **撤回**。
- **停止並改問這個**：團隊回覆時按 ⌘+Enter（Windows 與 Linux 為 Ctrl+Enter），會停止團隊並立刻送出這則訊息（排在等待中的訊息之後）；上方等待區的 **停止並立即送出** 則是把等待中的訊息立刻送出。
- **■ 停止**：停止目前的執行，並結束 agent 的程序。等待中的訊息會留在上方（**這些訊息還沒送出**），可以送出、編輯或撤回；你的下一則訊息或 **繼續** 會先把它們送出。
- **繼續 ↻**：不輸入新訊息，讓團隊接著做（再跑一組輪次，或從隊長開始再接力一次）。接力達到交棒上限後特別好用。
- **PASS 的回覆**：沒有補充的 agent 會回覆 `[PASS]`，以淡色的「沒有補充（PASS）」顯示。
- **向你提問**：好答案取決於只有你知道的事（你的情況、目標或偏好）時，agent 會先問你、不亂猜，團隊也會停下來：其他人不會發言，問題下方標示 **等你回答**，側邊欄顯示 **等你回答**。直接在輸入框回覆：提問的 agent 會先依你的回答給出完整答案，接著這一輪的其他成員繼續（平行模式中，提問的成員會在下一輪前重新回答；接力模式則把發言權交回提問的成員）。回覆中 @ 了提問者以外的成員，會重新開始一次執行。**略過問題**（或問題下方的 **略過，讓團隊繼續**）讓其他成員不等你的答案繼續做。提問的 agent 回覆期間你送出的訊息，會等你回答時一起送出。
- **agent 的思考與動作**：agent 的推理過程和工具步驟收在同一個摺疊列中（串流時顯示 **思考中…** 和最新一行）；展開這一列後，每段思考以第一行列出，點一下可以看完整內容。它的計畫 / 待辦清單會以 **計畫** 核對清單顯示並隨進度更新，每個工具步驟也都能展開查看輸出。
- 每則回覆會顯示耗時；CLI 有回報時也會顯示費用與 token 數（Cursor 與 Muse Code 兩者都不回報；Antigravity 與 Copilot 回報 token 數，不回報費用）。

### 核准

agent 想做權限沒涵蓋的事時（安裝套件、在唯讀模式執行指令、推送程式碼、寫入工作目錄以外的地方、從沙箱連到某個主機），它的回覆中會出現一張卡片，說明它想做什麼（確切的指令、檔案、網址或主機）以及原因。允許之後指令會在沙箱外執行時，卡片會註明。agent 會等你回應：

- **允許**：只允許這一次。
- **本對話都允許「…」**：這次以及之後類似的請求，在這個對話接下來都不再詢問（指令的話，指的是同一個程式與子指令，例如 `npm install`；串接的指令要每一段都符合才會允許；設定了會決定執行什麼的變數，例如 `PATH` 或 `LD_PRELOAD`，或把內容用管線交給 shell 的那一行，只依它完整的原文比對）。
- **拒絕**：可以先輸入要它改做什麼（選填）；agent 會收到你的訊息（Cursor、Muse Code、Cline 與 OpenHands 的 agent 只會知道你拒絕了）並繼續（Antigravity 或 Copilot 的 agent 則會結束這一輪：見下文）。

訊息框上方的橫幅會指出正在等待的請求；側邊欄會把這個對話標為 **等你核准**，瀏覽器分頁標題也會顯示有幾個對話在等你。按 **■ 停止** 會拒絕所有還在等待的請求；agent 已經停止（當掉或逾時）的請求也會失效；Harness Relay 本身停止時還在等待的請求，會在它重新啟動時失效。在唯讀對話中允許某個動作時，若另一個對話正在修改同一個目錄，這個動作會被拒絕，並告知 agent 原因。Codex 在自己的沙箱中執行指令，只有在它判斷需要超出沙箱允許的範圍時才會詢問。Cursor 沒有沙箱，所以在完全存取以外的權限，它的每個指令都會詢問（你的 Cursor 團隊允許清單上的除外），你允許它執行的每個指令都在沙箱外執行（它的卡片會註明）。拒絕時附上的說明會顯示在對話中，但 Cursor 的拒絕不能附帶訊息，所以它的 agent 收不到。Cursor 自己要問你的問題會略過：agent 改透過 Harness Relay 問你。

Antigravity 同樣沒有沙箱，所以在完全存取以外的權限，它的每個指令都會詢問，你允許它執行的每個指令都在沙箱外執行（它的卡片會註明）。任何一種拒絕（你的、自動的，或不經詢問就拒絕的受保護路徑）都會立刻結束它的這一輪：Antigravity 什麼都不告訴它的模型就停下，對話中被拒絕的呼叫會標上「（Antigravity 在拒絕後會結束這一輪）」；你的說明只會顯示在對話中，所以要它改做什麼，請在下一則訊息裡說。它的簡報（Harness Relay 把它加進 Antigravity 的系統提示）也會告訴它這件事：在可能需要你核准的呼叫之前，先說明它要做什麼、為什麼；要問你問題時，照 Harness Relay 的 agent 的方式問，不要用它自己的 `ask_question` 工具（它若還是那樣問，問題會成為它的回覆，並結束這一輪）。

在完全存取以外的權限，工作目錄裡有專案替 Antigravity 準備的設定時，Harness Relay 會在 Antigravity 的這一輪開始前先問你：MCP 伺服器、hook 或 plugin（從每個工作目錄往上到它的 repository 根目錄，`.agents`、`.agent`、`_agents` 或 `_agent` 裡的 `mcp_config.json`、`hooks.json`、`plugins/` 或 `plugins.json`）。Antigravity 一開啟就會啟動它們，在任何沙箱之外執行，也不經詢問，唯讀模式下也一樣；而可編輯模式下的另一個 agent，或做出這個 repository 的人，都可能放進這些檔案。卡片會列出這些檔案；只要它們的內容不變，**本對話都允許** 就一直有效。你拒絕（或對話設為自動拒絕）時，這一輪不會開始。Antigravity agent 移到背景的指令，例如它啟動的伺服器，會隨它的這一輪結束；你停止這一輪時還在執行的指令也一樣。

Copilot 在完全存取以外的權限，在它的沙箱中執行指令，所以你允許它執行的指令也在沙箱中執行。它和 Antigravity 一樣，任何一種拒絕（你的、自動的，或不經詢問就拒絕的受保護路徑）都會立刻結束它的這一輪：Copilot 只告訴它的模型那個呼叫被拒絕了，就停下，對話中被拒絕的呼叫會標上「（Copilot 在拒絕後會結束這一輪）」；你的說明只會顯示在對話中，所以要它改做什麼，請在下一則訊息裡說。它的簡報（Copilot 每次啟動時都會當成它自己的指示讀取）也會告訴它這件事，並請它在可能需要你核准的呼叫之前，先說明它要做什麼、為什麼。寫到工作目錄以外的檔案，以及它要以 detached（在背景）執行的指令，它的沙箱不允許，Copilot 自己會不經詢問就拒絕；它的這一輪會繼續。透過 ACP 執行時，Copilot 沒有自己的提問工具（它在那裡的工具裡沒有 `ask_user`），所以它的簡報會請它照 Harness Relay 的方式（`[ASK_USER]`）問你，就像上面的 **向你提問**。

在完全存取以外的權限，工作目錄裡有專案替 Copilot 準備的 hook 時，Harness Relay 會在 Copilot 的這一輪開始前先問你：從每個工作目錄往上到它的 repository 根目錄的 `.github/hooks/*.json`，以及專案的 `.github/copilot/settings.json` 或 `settings.local.json`、`.claude/settings.json` 或 `settings.local.json` 裡定義的 hook。Copilot 會在它的 session 開啟時與每次使用工具前執行那些 hook 檔，不經詢問，唯讀模式下也一樣（在它的沙箱中）；它的說明也說會執行那些設定檔裡的 hook（在不信任任何資料夾的 Harness Relay 執行中，它們沒有執行，但還是會問你）。可編輯模式下的另一個 agent，或做出這個 repository 的人，都可能放進這些檔案。卡片會列出這些檔案；只要每個完整 `.github/hooks` 資料夾（包括 JSON 檔旁邊的 script）與那些設定檔的內容不變，**本對話都允許** 就一直有效（hook 執行的、放在別處的 script 不算在內）。你拒絕（或對話設為自動拒絕）時，這一輪不會開始；所以不能問你的 Copilot [首席 agent](#首席-agent)，在這種專案裡不會啟動。你允許之後，Harness Relay 會先另外短短啟動一次、在什麼都不會執行的地方檢查 Copilot 的沙箱，hook 接著在沙箱內執行。帳號設定裡略過了 hook 時（見[各 CLI 自己載入的內容](#各-cli-自己載入的內容)）也會詢問：那只會關掉你自己的 hook，因為不管設定怎麼寫，Copilot 都會執行專案的 hook（以 copilot 1.0.109 試過）。完全存取時不會詢問。

Muse Code 只會詢問它的設定檔與沙箱不讓它執行的事，權限涵蓋的部分 Harness Relay 會直接回答，不顯示卡片。在完全存取以外的權限，唯讀時每個指令都會來問你；可編輯模式下，則是推送、發佈或把內容用管線交給 shell 的指令，以及 Muse 詢問的、寫進 `.muse`、`.agents`、`.git/hooks` 或 `.git/config` 的寫入；兩種模式下，要連網的指令也會（允許後只有那個指令能連網，仍在沙箱裡執行）。你允許的指令仍在 Muse 的沙箱裡執行（卡片上會說明），受保護的路徑則不經詢問直接拒絕。Muse 對同一個呼叫詢問兩次時（例如寫到工作目錄以外的指令），你只會被問一次；指令要連網則另外詢問。Muse 拒絕時不帶任何訊息：它的模型只會收到 Muse 自己的話，說你拒絕了這個動作、除非你要求否則不要重試，你的留言只顯示在對話中。它的說明會告訴它這一點，並請它說出需要這個呼叫做什麼，或問你。

開源 agent 也透過同樣的卡片詢問。Harness Relay 對它們的每個請求都只回答「這一次」：**本對話都允許** 由 Harness Relay 自己在這個對話裡記住，所以 agent 不會因此不再詢問，也不會改寫它自己的設定。唯讀時，允許修改、指令或 MCP 工具並不會讓它寫得進去：沙箱仍然會拒絕，卡片也會說明；需要時請把對話改成可編輯。MCP 工具的卡片會顯示交給工具的內容（OpenCode 的請求只寫出工具名稱）。它們的沙箱擋下某個程式連到這次執行的模型來源以外的主機時，卡片會詢問那個主機（選 **本對話都允許**，這個對話之後的執行也會允許，但只限那個主機的那個埠號）。完全沒說是什麼的請求（例如 OpenHands 之前沒有宣告任何動作的請求）只能允許一次：**本對話都允許** 會允許所有這類請求。它們的請求還在等待時按 **■ 停止**，會取消這個請求，而不是拒絕它；在 prompt 送出前停止，則什麼都不會送出。agent 的回合結束後才來的請求不會出現卡片，直接拒絕。權限提高時，它們的每位成員也會從清空的狀態開始；刪除對話時，會移除這些 agent 為它保存的東西。你拒絕時的留言會不會傳給模型，要看是哪個 agent：OpenCode、Goose 與 Pi 會轉交；Cline 與 OpenHands 只會告訴它們的模型你拒絕了，留言只顯示在對話中（見[各 agent 要注意的地方](#各-agent-要注意的地方)）。

### 檢視與套用修改

agent 修改檔案時，回覆最後會有一張卡片，列出改了哪些檔案（A 新增、M 修改、D 刪除，以及增刪行數）：

- **查看這回合 diff**：這個 agent 在這一回合改了什麼。
- 平行模式中，卡片會標示 **在 worktree** 與該 agent 的分支，而它最新的那張卡片還有：
  - **查看 @名稱 的完整結果**：這次執行開始以來，這個 agent 改的所有內容；
  - **套用到工作目錄**：把這份結果複製到你的工作目錄（有多個時，複製到它改過的每一個：全部套用，或其中一個有衝突時都不套用；之後從清單移除的資料夾不會套用）。不會自動 commit：請用你平常的工具檢查後自行 commit。

套用其中一份結果後，其他 agent 的結果會標示為過期（工作目錄已更新），下一輪平行作業會讓每個 agent 從更新後的目錄重新開始。如果你的工作目錄在這段期間有跟結果衝突的修改，就不會套用任何變更，並說明原因；可以請 agent 以目前的狀態為基礎重做。

### 對話中修改團隊

點上方的 **團隊設定** 可以修改角色、模型、推理強度、模式、權限或工作目錄，從下一回合開始生效。更換某個 agent 使用的 CLI 時，該 agent 會開新 session 並重新讀一次對話紀錄。團隊回覆中無法儲存設定。這裡顯示的成員是 **目前的團隊**：首席 agent 可能在你的下一個問題時更換它（見[自動組隊](#自動組隊)）。你也可以在這裡勾選或取消 **直接採用首席 agent 組的團隊，不必等我確認**。

想讓首席 agent 幫你改，就在 **團隊設定** 最上面的 **請首席 agent 調整** 寫下想怎麼改（例如「加一位用 Codex 的測試人員」、「改成接力模式」或「讓 Reviewer 專注在安全性」），再按 **請首席 agent 調整**（或按 ⌘/Ctrl+Enter）。它會讀到目前為止的對話，改好下方顯示的團隊，但還不會改到對話的團隊：它的說明會講為什麼，列出改了什麼（新增、移除、改名或換 coding agent 的成員，改寫的角色、模型、發言順序、模式），並顯示花了多少時間與費用；**復原** 會把團隊改回原樣，按 **儲存** 才會採用（對於等待確認的設計，儲存就是確認，如上所述）。它留下或改名的成員會保留工具與 session；換到另一個 coding agent 的成員會保留工具，並重新讀一次對話，和你自己換的時候一樣。做不到的要求（例如更改權限），它會說明原因，團隊維持原樣。它調整期間無法編輯或儲存團隊；按 **停止**，或關閉 **團隊設定**，就會停止。如果這段期間團隊變了（例如首席 agent 剛設計好團隊），這次的調整不會套用，請再問一次。儲存前你可以再請它調整，或自己動手修改它的團隊。

### 排程

上方的 **排程** 會在設定的時間，把一則訊息傳給這個對話的團隊，就像你自己送出的一樣——例如每個平日 09:00 傳「@Reviewer 看一下昨天合併的 PR，列出可能的風險」。

想直接從排程開始、而不是先開對話，就按側邊欄 **新對話** 旁邊的月曆按鈕 **新排程**。填寫和下面相同的選項，再加上工作目錄、檔案權限，以及是否直接採用首席 agent 的團隊，按 **建立排程**。Harness Relay 會為它開一個對話（沒有命名時以訊息命名），首席 agent 立刻為這則訊息組隊，請在團隊卡片上確認。這時不會執行：團隊會在設定的時間收到訊息。團隊還在組、或在等你確認時到期的時間，最多會再試 30 分鐘，之後才略過。如果組隊被停止，排程視窗會提供 **請首席 agent 組隊**。

- **要傳給團隊的訊息**——要送出的內容。和平常一樣，用 @ 指定成員時，只有被 @ 的成員回答；@ 了不在團隊裡的名字不會傳給任何人（由訊息 @ 到的其他成員回答；一個成員都沒有 @ 到時，才由整個團隊回答）——輸入時視窗就會提醒，在 **團隊設定** 把訊息 @ 的成員改名或移除時也會提醒。用 **新排程** 時還沒有團隊：首席 agent 會依訊息 @ 的名字（例如 `@Reviewer`）為成員命名，如果少了誰，團隊卡片會在你確認前提醒（有排程的對話裡，之後提問組出的團隊也一樣）。
- **時間**——**一次**（某個日期與時間）、**每天**或**每週**（選擇星期幾）的某個時間，或**每隔幾小時**（從設定時間時算起；只改訊息時節奏不變）。儲存前會顯示接下來三次的時間與時區；時間以排程的時區計算，在其他時區的裝置上可以改用那台裝置的時區。
- **權限範圍以外的動作**——排程執行時可能沒人看著：預設會**自動拒絕** agent 想做的、超出對話權限的事（agent 會被告知並改用其他方式，對話中也會顯示拒絕了什麼），但你已在這個對話中一律允許的動作除外。選 **詢問我** 則和平常一樣在對話中詢問你，agent 會等你回來（每一回合最多 45 分鐘，或 `RELAY_TURN_TIMEOUT_MIN` 設定的時間）。你在排程執行中寫訊息之後，就會照常詢問你。對話本身設為自動拒絕，或有完全存取權限時，這個設定不會改變它。
- **錯過的時間**——Harness Relay 只在執行時送出。關閉期間或電腦睡眠時錯過的時間，會**略過**並在對話中留下說明，或在**開啟後補送一次**（錯過幾次都只補一次）。
- **每次開新對話**——不在這個對話送出，而是每次開一個新對話，沿用同樣的團隊、設定、「本對話都允許」的動作與側邊欄群組，以這個對話的名稱加上時間命名，在那裡送出訊息。每次都從乾淨的上下文開始，這個對話也不會越來越長；但 agent 不記得前幾次做過什麼，要延續的事請 agent 寫進工作目錄的檔案。這個對話裡等你回答的問題、或在佇列裡等待的訊息，都不會讓它先不送；但它仍需要確認過的團隊，而且有對話（包括這個）正在修改同一個資料夾時會等待。平行模式下，每個新對話都有自己的 worktree 與 `relay/*` 分支，刪除那個對話時才會清掉。排程的狀態會連到上次開的對話，**立即執行一次** 也會連到剛開的對話。
- **啟用**——取消勾選可以暫停排程而不刪除。

上方會顯示排程（滑過可看下一次的時間），側邊欄的對話旁也會出現時鐘；上次沒有送出時兩者都會變成琥珀色。排程送出的訊息標有 **排程**。團隊回覆中時，排程訊息會像你那時送出的訊息一樣等待；agent 在等你回答（排程訊息永遠不會被當成你的回答）、團隊還沒確認，或上一則排程訊息還在等團隊接手時，則會先不送（並留下說明）。團隊被停止時還在等待的排程訊息，會在下一次時間送出。另一個對話（每次開新對話的排程，也包括這個對話）正在修改同一個資料夾時，最多會再試 30 分鐘。排程訊息在等待時你回答了 agent 的問題，會先送出你的回答，排程訊息接在後面；如果它指定的成員在那次執行中不會發言，之後會自己開始一次執行，而且和其他排程執行一樣自動拒絕核准，除非排程設為詢問。**立即執行一次** 可以馬上送出試試看；**刪除排程** 會移除它。每個對話一個排程，而且在這裡要有確認的團隊才能啟用（**新排程** 會自己啟用，並請首席 agent 組隊）。排程訊息會交給目前的團隊：首席 agent 不會為它們設計團隊，因為那時可能沒有人在場確認。排程啟用時，**團隊設定** 會提醒你修改會套用到排程的執行，並在團隊有完全存取權限時提出警告。

### 瀏覽檔案

點上方的 **檔案** 會開啟這個對話的工作目錄（有多個時，從上方的清單選一個）：資料夾排在前面，可以篩選目前資料夾的項目，按 ↑ 回到上一層。點檔案就能預覽：程式碼附行號和語法上色，Markdown 可以切換預覽和原始內容，也能看圖片和影片。**下載** 會把任何檔案存到你正在用的裝置，包含無法預覽的檔案，例如 PDF 或簡報。**複製路徑** 會複製檔案的完整路徑。要把整個資料夾下載成 ZIP 檔，按工具列最右邊的下載鈕，下載目前所在的資料夾（工作目錄本身也可以）；或按列表中資料夾旁邊的下載鈕（滑過時出現）。資料夾太大而無法打包時（檔案與資料夾超過 10,000 個或 1 GB，通常是因為 `node_modules` 這類資料夾），如果它在 git repository 裡，會提議只下載沒被 git 忽略的檔案（裡面的其他 repository 也包含在內）。ZIP 檔裡的檔案和瀏覽時看得到的相同，保留原本的權限，放在以資料夾命名的資料夾裡（成員的 worktree 以工作目錄和成員命名）。平行模式下也可以選某位成員的 worktree，在套用前先看它的結果。只會顯示所選資料夾裡的內容，`.git` 資料夾不會列出，超過 512 KB 的檔案只顯示開頭。在手機上，列表和預覽輪流顯示，按 **返回列表** 回去。

### 複製、編輯與重試

- 訊息下方的按鈕都是圖示（指著按鈕會顯示名稱）。agent 回覆下方的按鈕一直顯示；你自己的訊息要滑鼠移到訊息上才會出現（手機和平板上一直顯示）。agent 回覆下方，複製、重試、分享和分支在左邊，這則回覆的時間、費用與 token 數在最右邊；你自己的訊息下方，複製和編輯在泡泡底下。
- **複製**（兩張紙）會把這則訊息的文字複製成 Markdown，內容和原文完全一樣：連結保留完整網址，格式、表格、程式碼與換行都不變（用一般 http 開啟時也一樣，例如從手機連線）。自己選取文字再複製的話，複製的是畫面上顯示的內容（連結只有文字、沒有網址）。上方 **分享** 裡的 **複製成 Markdown** 會把整段對話複製下來（見[分享對話](#分享對話)），每則都標明是誰說的（使用 agent 當時的名字與 CLI）；被停止的回覆若留下沒結束的程式碼區塊，會自動補上結尾。工具動作不會包含在內。
- 你自己的訊息下方的 **編輯**（鉛筆）可以修改後重新傳送（Enter 傳送、Shift+Enter 換行、Esc 取消；在手機和平板上 Enter 換行，按 **傳送** 送出）。這則之後的對話會被刪除，團隊從這裡重新回答；每個 agent 都會開新的 session，重新讀到你修改的這則為止的紀錄。被刪除的回覆改過的檔案**不會**還原；如果其中有回覆改過檔案，送出前會先請你確認。團隊回覆中無法編輯。
- agent 回覆下方的 **重試**（兩個繞圈的箭頭）會讓這位 agent 重新回答。它的回覆與之後的所有內容都會被刪除（之後還有訊息時會先請你確認）；不是接力模式時，同一輪中排在它後面的成員也會重新回答。

### 分支對話

想試另一個方向、又不想失去原本的對話時，可以分支：agent 回覆下方的 **分支對話**（一條分岔的線）會建立一個新對話「**分支 · <標題>**」並打開它：

- 新對話裡有到這則回覆為止每則訊息的副本（附加檔案與改動檔案的 diff 也一起），以及原本的對話**現在**的團隊、設定、「本對話都允許」的回答和側邊欄群組（不是那則回覆當時的樣子）。對話標題後方、以及複製過來的訊息後面的一條線，都會寫著 **延續自 <標題>**，點了會回到原本的對話（原本的對話刪除後，只顯示它的標題，不再是連結）。對話標題和原本對話的標題放不下時，兩者各占一半（其中一個較短時，剩下的空間讓給另一個），並以 … 縮短，所以兩者都看得到。
- 如果那則回覆向你提問，分支裡的問題也會等你回答，即使你在原本的對話已經回答過：從某個問題分支，就能換個方式回答。
- 原本的對話完全不變，分支時它也可以繼續回覆；只有到你分支的這則為止的回覆必須已經完成。
- 平行模式中，複製過來的回覆所顯示的圖片與檔案，來自原本對話中那位成員的 worktree，所以原本的對話刪除後就看不到了（diff 還在）。結果只能在做出它的對話裡套用。
- 分支裡的 agent 會開新的 session：第一次發言時會收到複製過來的訊息，之後兩個對話各走各的。
- 兩個對話共用工作目錄，檔案**不會**倒回去：檔案是原本的對話留下的樣子，不是那則回覆當時的樣子。分支裡的 agent 會被告知這一點。
- 自己的訊息下方沒有分支：想在某個問題之後改問別的，可以從它前一則回覆分支，或編輯這個問題（會取代它之後的內容）。
- 你在分支裡送出的第一則訊息會成為它的名稱，就像新對話以第一個問題命名，讓名稱說出這個分支往哪裡走（你自己改過名稱的不會被改掉）。編輯第一則複製過來的訊息，會讓它成為獨立的對話（複製的訊息一則都不剩），並以編輯後的訊息命名。
- 側邊欄會把分支列在原本的對話底下，它們一起待在同一個群組：見[側邊欄裡的分支](#側邊欄裡的分支)。分支也可以再分支，沒有深度限制。
- 分支一定屬於寫出那則回覆的對話。分支裡到分支點為止的訊息是從原本的對話複製過來的：從其中的回覆（包括最後一則複製的）再分支，做出的是原本對話的分支，就像你當初在那裡分支一樣，會列在原本的對話底下並以它命名，而不是列在你點的這個分支底下。分支的分支，則可能是更上層的對話。在分支裡重試或編輯也可能讓它換位置：裡面一則都不剩它所屬對話寫的訊息時，它會改列在更上層的對話底下（名稱若仍是建立時的名稱，也會改用那個對話的）。

### 分享對話

上方的 **分享** 會分享整段對話；agent 回覆下方的 **分享**（方框加箭頭）會分享從開頭到這則回覆為止的所有內容。兩者都不含工具呼叫、思考過程、待辦清單、權限請求與變更的檔案。對話框提供兩種方式：

- **複製成 Markdown**：複製文字，每則都標明是誰說的。
- **建立連結**：做出一個和畫面上聊天室一樣的頁面（標題、團隊、訊息與其中的程式碼、表格、圖表和圖片；不含模式、權限與排程的標籤；團隊設計裡即使在寬螢幕上也超過幾行的角色一樣折疊，按 **顯示更多** 一樣能展開，較短的角色則完整顯示），頁尾附上 Harness Relay 的名稱、logo 與分享時間（點 logo 或時間右邊的連結圖示會打開 Harness Relay 的網站），再用你的 GitHub CLI（`gh`）上傳成 *secret gist*：有連結的人都能在 gistpreview.github.io 打開，但不會被列出，也搜尋不到。請從 https://cli.github.com 安裝 2.66.0 以上的 `gh`，並執行一次 `gh auth login`（更舊的 `gh` 無法不經詢問就移除分享，這時 Harness Relay 會說出需要的版本與目前安裝的版本）；沒有安裝或沒有登入時，什麼也不會上傳，對話框會說明怎麼處理：macOS 與 Windows 的安裝指令（各有複製按鈕）、下載頁與 Linux 安裝說明、`gh auth login` 指令與它的說明，以及註冊 GitHub 帳號的地方。在設定頁移除分享時也會顯示同樣的說明。頁面必須小於 1 MB（gistpreview 透過 GitHub 的 API 讀取 gist，更大的檔案會被截斷）：圖片會縮小，還是放不下時就不放；太長的對話可以改成分享到比較前面的某則回覆。頁面包含它顯示的所有內容，不會從任何地方載入東西。團隊還在寫其中的回覆時，請等回覆寫完再建立連結；正在編輯的訊息要先送出或取消。

**回覆連結的檔案**：要分享的回覆連到你電腦上的檔案時（`[報告](out/report.md)`），對話框會在連結下方列出這些檔案和大小，由你決定要附上哪些：勾選的檔案會上傳到它們自己的另一個 secret gist（和頁面分開，否則 GitHub 會把頁面截斷），頁面上的連結會從那裡取得它們（從 `gist.githubusercontent.com`：文字檔和圖片在瀏覽器裡打開，PDF、簡報等其他檔案會下載），所以**有連結的人都能下載這些檔案**。沒勾選的檔案，頁面上的連結會變成純文字：文字保留，但沒有下載箭頭，也不能下載。任何種類的檔案都能附上（文字檔、PDF、簡報、圖片、壓縮檔…），每個最多 50 MB，合計最多 100 MB、20 個；不能附上的檔案會說明原因：找不到、不在對話的資料夾裡（或在 `.git` 裡），或超過 50 MB。檔案除了 `gh` 也會用 `git` 上傳（由 gh 幫 git 登入，不必另外設定），所以也要裝好 `git`。檔名是 git 保留給自己的（像 `.gitignore`、`.gitmodules`）會在檔名前面加上 `_` 再上傳。只會讀取該回覆自己的下載連結能給你的檔案，也就是工作目錄、該 agent 的 worktree 或附件裡的檔案，絕不讀 `.git`。一開始會勾選上限內所有能附上的檔案，但檔名看起來可能含有機密的除外（像 `.env`、`.npmrc` 這類點開頭的檔案、`*.pem`、`*.key`、`id_rsa` 這類金鑰，以及檔名含 secret、credential、password、token 或 API key 的檔案）：這些會標示出來，要附上請自己勾選。回覆寫完或檔案有變動時會重新檢查清單，你勾選或取消的都會保留；只有新出現的檔案才套用預設。如果列出之後檔案有變動、已經不能附上，就什麼都不會上傳，並重新檢查清單。如果 Harness Relay 在檔案上傳期間停止，之後「設定」會列出放檔案的 gist 並標示為沒有完成，讓你可以移除它。放檔案的 gist 建立之後，如果檔案或頁面傳不上去，那個 gist 會再被刪除；連刪除也失敗的話會告訴你，並在「設定」列出那個 gist、標示為沒有完成，讓你可以移除它。

**設定 → 分享的對話** 會列出你建立的所有連結，最新的在最上面，並標示內容範圍（以及附上了幾個檔案）與時間：可以打開頁面、它的對話、GitHub 上的 gist 或放附檔的 gist，也可以一次移除一個，或勾選多個一起移除。移除會刪除它在 GitHub 上的所有 gist（`gh gist delete`）：頁面的和放附檔的，連結和檔案的連結都會失效（GitHub 可能還會從快取提供已移除的檔案幾分鐘）；兩個都刪掉之後才會從列表移除，有一個刪不掉時會留在列表上並說明原因，可以再移除一次。已經在 GitHub 上刪掉的，只會從列表移除。`gh` 登入另一個 GitHub 帳號時建立的 gist，要切回那個帳號（`gh auth switch`）才能移除。

### 回報問題

遇到問題或有想法？側邊欄底部「設定與登入」右邊的對話框圖示會開啟「回報問題」。選擇類型（問題、建議或其他），寫下發生了什麼事（主旨可以不填，會用內容的第一行），按「寄出」：你的郵件程式會開啟，開發者的信箱、主旨與你的回報都已填好。把截圖拖進信裡，再按寄出。在你寄出之前，除了你選擇上傳的截圖（見下方），什麼都不會離開你的電腦。

- 「截圖（選填）」：貼上、拖進來或選擇圖片（最多 5 張 PNG、JPEG 或 WebP：不接受 GIF，也不接受存成 `.jfif` 的 JPEG），再按「上傳截圖」：截圖會用你的 GitHub CLI（`gh`，需要已登入）上傳成 secret gist，信裡附上連結。只會上傳顯示圖片必要的部分：拍攝位置等中繼資料（照片的 EXIF、XMP、註解、動態照片的影片）都會拿掉，照片只保留該怎麼轉正（縮圖也會拿掉：它可能是裁切前的畫面）。不完整的 JPEG 或 PNG 會照瀏覽器顯示的樣子上傳到中斷處；不完整的 WebP，以及任何讀不懂結構的圖片，都會被拒絕。連結裡看得到你的 GitHub 帳號名稱。有連結的人都看得到；寄出前可以按「刪除上傳」再刪除那個 gist。報告寄出後才上傳、沒有任何寄出的信連到的，對話框會提醒你（再寄出一次才會附上），關掉對話框時會被刪除。上傳了卻沒寄出就離開（重新整理頁面或結束 app）的，會留在你的 GitHub 帳號裡，說明是 *Harness Relay problem report · screenshots*：請到 gist.github.com 刪除。信寄出後就收不回來：之後在 GitHub 上刪除 gist，信裡的連結會失效，但開發者已經看過或存下的截圖收不回來。沒有 `gh` 的話，移除截圖，改成拖進信裡。
- 沒有郵件程式？「用 Gmail 寄」會在新分頁開啟一樣填好的 Gmail；或按「複製內容」，用任何郵件寄到內容第一行的收件人。複製成功就和「寄出」一樣算寄出了：截圖的 gist 會保留，關掉對話框時報告就會清空。
- 信裡一律會附上 Harness Relay 的版本、系統、瀏覽器、各 CLI 的版本與語言，比較容易找出問題（寄出前會等它們載入，最多 10 秒；伺服器沒有回應時，信裡會寫明）；展開「會一併附上版本與系統資訊」可以看到每一行。你的檔案、路徑與帳號都不會附上。
- 回報太長放不進郵件連結時，會改放進剪貼簿，信裡會請你貼上。剪貼簿寫入失敗時不算寄出：你打的內容會留著，直到你用「複製內容」複製為止。
- 關閉對話框時，輸入的內容會保留，直到你寄出為止。

### 在 GitHub 給 Harness Relay 一顆星星

如果你覺得 Harness Relay 好用，側邊欄底部回報問題圖示左邊的星星會開啟一個小對話框，請你到 GitHub 給這個專案一顆星星。對話框裡的示意圖說明在 repo 頁面要按哪裡（右上方的「Star」，需要登入 GitHub；按下後會變成「Starred」），「到 GitHub 按星星」會在新分頁打開那個頁面（桌面 app 裡會用你的瀏覽器開啟）。Harness Relay 不會送出任何東西：對話框只是打開連結。

### 語音輸入

按送出鍵旁的 🎙 開始說話，再按一次（錄音時會顯示紅色計時）就會把文字放到游標所在的位置；你可以先修改、加上 `@成員`，再自己送出。按 Esc 取消錄音，一次最多錄兩分鐘。語音由你電腦上的 whisper.cpp 轉成文字，錄音不會上傳。

語音輸入是選用的。第一次按 🎙 時，會先跳出說明，告訴你要下載什麼、放在哪裡：

- **引擎**（whisper.cpp）：macOS 用 Homebrew 安裝（`brew install whisper-cpp`），使用 GPU（Metal）；Linux 與 Windows 由 Harness Relay 下載官方版本（約 5–10 MB），用 CPU 執行。電腦上已經有 whisper.cpp 的話會直接使用。
- **模型**：選一個；說明視窗會推薦最適合這台電腦的（Apple Silicon 是 Large v3 Turbo，其他電腦是 Small）。

按 **下載並安裝** 後就可以繼續使用：安裝會在背景進行（🎙 上會有一個小點），**設定 → 語音輸入** 會顯示每個步驟、下載進度與安裝紀錄，也可以 **取消安裝**。每個檔案在使用前都會先比對它應有的內容（SHA-256）。連不到 Hugging Face 或 GitHub 時，可以用 `RELAY_VOICE_MODEL_BASE_URL` 與 `RELAY_VOICE_ENGINE_BASE_URL` 改從鏡像站或你自己的伺服器下載（檔案一樣會檢查）；`RELAY_VOICE_DIR` 則能把檔案放在資料資料夾以外的地方，例如容量較大的硬碟。

在 **設定 → 語音輸入** 也可以從頭安裝、下載與切換模型（**下載並使用**、**使用**、**移除**）、選擇辨識語言（跟隨介面語言、自動偵測、中文（繁體）或 English）、指定自己的 `whisper-server`，或按 **移除語音輸入** 刪除下載的檔案。引擎在第一次說話時啟動，閒置 10 分鐘後停止，釋放模型佔用的記憶體。

### 對話列表

側邊欄依[群組](#群組)列出所有對話，最新的在最上面，並標示各自的狀態：

| 標籤 | 意義 |
| --- | --- |
| **等你核准**（橘色） | 有 agent 在等你核准。 |
| **等你確認團隊**（橘色） | 首席 agent 為你的問題設計好團隊了；確認後團隊就會回答（[自動組隊](#自動組隊)）。 |
| **回覆中**（藍色、跳動） | 團隊正在工作。 |
| **新回覆**（綠色、標題加粗） | 你在看其他畫面時，這個對話已經回覆完成。 |
| **出錯了**（紅色） | 最後一則回覆以錯誤結束，而你還沒看過。 |

時間前面的時鐘代表這個對話有[排程](#排程)（滑過可看下一次的時間）；上次沒有送出時會變成琥珀色。切換到其他對話（或關閉分頁）時，對話會繼續執行；標籤會自動更新。點聊天畫面上方的標題可以重新命名；滑過對話並按 × 可以刪除。對話標題會用滿側邊欄的寬度，放不下時才以 … 結尾；資料夾與 × 按鈕在滑過時才出現（手機與平板上一直顯示）。成員很多的對話會顯示前幾個成員圓點與 **+N**。

想要更大的畫面時，按 *Harness Relay* 旁的側邊欄按鈕即可收合側邊欄。左上角會留下一個按鈕，按下即可展開側邊欄。這個選擇會記在瀏覽器中。（在手機上，側邊欄則是用 ☰ 開啟的抽屜，而且頁面不會縮放：雙指或點兩下都不會放大，點訊息框時也不會自動放大。在手機與平板上，標題列只有一行：標題，以及 **分享**、**檔案**、**排程** 與 **團隊設定**。手機上這四項收在標題列右邊的 **⋯** 裡，各自附上圖示（方框加箭頭、資料夾、時鐘、兩個人）；排程啟用時時鐘是藍色的，**⋯** 上也會有藍點。團隊成員、模式與權限請到 **團隊設定** 查看，只有權限為 **完全存取** 時，標題旁會出現紅色標籤提醒。訊息框在輸入前只佔一行；按鈕讓輸入空間太窄時，會移到文字下方。）

### 通知與提示音

除了側邊欄的標記，Harness Relay 也能在團隊 **回覆完**（或回覆出錯）、以及 **需要你**（核准、確認團隊、回答問題）的時候告訴你。在 **設定與登入 → 通知與提示音** 開啟；每個瀏覽器、每支手機各自設定，設定只存在那個瀏覽器裡。

- **顯示系統通知**：第一次會請瀏覽器允許，之後會跳出系統通知，寫著對話標題、誰回覆了、回覆的開頭（核准則是它要執行的指令，提問則是問題）。點一下就會打開那個對話。
- **播放提示音**：回覆完是兩個音，需要你是三個音。打開時會先播一次，讓你聽聽看。瀏覽器只讓你在頁面載入後點過或打過字的頁面播放聲音，所以重新載入後，或從通知打開手機上的 App 後，要在你第一次點畫面之後才會有聲音。
- **通知我**：選擇要知道哪一種（回覆完成、需要你）。
- **傳送測試通知**：試試看。

視窗在前景且有焦點時，你正在看的對話不會通知。Harness Relay 在前景時只會播放提示音（其他的側邊欄會顯示）；分頁在背景、或視窗被別的視窗擋住時才會跳出通知。開了好幾個分頁時，只有其中一個會通知你。通知會顯示回覆的開頭，或核准要執行的指令，所以可能出現在鎖定的手機上：若要保密，可以在手機的通知設定裡，選擇在鎖定畫面隱藏通知預覽。

**在手機上，或 Harness Relay 沒開著時。** 在支援推播通知的瀏覽器上（電腦上的 Chrome、Edge、Firefox 與 Safari；Android 的 Chrome；iPhone 與 iPad 則要先把 Harness Relay [加入主畫面](remote-access.zh-TW.md#4-加到主畫面)，iOS 16.4 以上），開啟通知時也會讓那個瀏覽器訂閱推播：伺服器會透過瀏覽器的推播服務（Google、Apple、Mozilla 或 Microsoft 的）送出每則通知，內容加密，只有那個瀏覽器讀得到。所以手機鎖定時也會收到，並使用系統的通知音（關掉 **播放提示音** 時則不出聲）。瀏覽器的 Harness Relay 頁面在前景時，伺服器不會推播給它，因為頁面自己會告訴你。推播需要以 HTTPS 開啟頁面（在手機上就是 `tailscale serve` 給的網址，見[從手機使用](remote-access.zh-TW.md)），執行 Harness Relay 的電腦也要開著、能連上網路。登出一個瀏覽器（**設定與登入 → 已登入的瀏覽器**）也會停止它的通知。

**在桌面 app 裡**，視窗開著時會跳出通知（app 的視窗沒有推播服務）。想在關掉視窗後也收到通知，可以同時在瀏覽器裡打開 Harness Relay 並開啟通知；這樣在 app 的視窗位於前景時，那個瀏覽器也可能為同一則回覆通知你。

### 群組

按 **新對話** 下方的 **新群組**，輸入名稱後按 Enter。群組依建立的順序排列，最後是預設群組 **其他**（一定存在）：不屬於任何群組的對話都在這裡。

- **移動對話**：把對話拖到群組上（群組會亮起來），或滑過對話、按資料夾按鈕再選群組。手機與平板無法拖曳，資料夾按鈕會一直顯示。
- **自動分類**：你有群組時，新對話送出第一則訊息後，首席 agent（[設定 → 首席 agent](#首席-agent)）會在團隊回覆的同時讀這則訊息，把對話放進最適合的群組；決定前對話會顯示 **分類中…**。都不適合就留在 **其他**。每個對話只會自動分類一次，你已經自己移動過的對話不會被移走。沒有任何群組時不會詢問首席 agent。
- **重新命名或刪除群組**：滑過群組名稱，按鉛筆或 ×。刪除群組時，裡面的對話會移到 **其他**，不會被刪除。群組名稱不能重複，也不能叫 **其他**。
- **收合群組**：按群組名稱。收合的群組會顯示其中最需要注意的對話狀態圓點（等你處理、回覆中、出錯、新回覆）。收合狀態會記在瀏覽器中。

#### 側邊欄裡的分支

[分支](#分支對話)出來的對話，會列在寫出你分支的那則回覆的對話底下、稍微往右縮，左側有一條線；它自己的分支再列在它底下，先建立的在上面。分支最多縮排三層：更深的不再往右縮，標題前改加 ↳。

- **一串分支在同一個群組**：一個對話、它的分支、分支的分支……會一起待在同一個群組（其中最早建立的那個對話所在的群組）。移動其中任何一個（拖曳或用資料夾按鈕），整串都會一起移動；拖曳時整串會一起變淡。首席 agent 只會分類它們最源頭的那個對話。
- **順序**：整串分支在群組裡的位置，依其中任何一個對話最近的動態排列；同一個對話底下的分支則維持建立的順序。
- **展開或收合分支**：有分支的對話會有一個按鈕，顯示分支圖示和底下有幾個對話；按一下收合，再按一下展開。收合時按鈕會加上外框，並顯示其中最需要注意的狀態圓點。收合狀態會記在瀏覽器中。開啟被收合藏起來的對話（新的分支，或用搜尋找到的對話）時，會自動展開。
- **刪除**：刪除對話時，從它分支出去的對話都會保留（確認視窗會說有幾個）。它們會留在原本的位置，列在它原本的標題底下，標題後面加上 **（已刪除）**，不能點；等底下一個都不剩時，這個標題也會消失。刪除一串分支中間的對話時，其餘的對話也仍然待在同一串。
- **搜尋**結果會在分支圖示後面寫出它是從哪個對話分支出來的。

### 搜尋

按 **新對話** 下方的 **搜尋**，輸入要找的內容。標題或訊息（你和 agent 寫過的內容）包含你輸入的每個詞的對話會取代群組列出，不分大小寫：標題符合的排在前面，其餘依最近時間排列。每個結果會顯示符合的段落（並標出關鍵字）、所在群組、分支來源（如果是分支的話）與符合的訊息數。點結果即可開啟；按 Escape 或 × 回到群組。中文不必空格：詞的任何一部分都能找到。

## 5. 撰寫角色的小技巧

- 讓每個 agent 有明確且不重疊的職責，並寫清楚它**不**該做什麼（「不要自己改檔案」）。
- 接力模式中，明確寫出何時交棒給誰（「完成後列出改了哪些檔案，然後 `@Reviewer`」）。
- 讓一個 agent 負責最後的結論（「你最後發言，給使用者最終答案」）。
- 想比較多種實作時，用**平行**模式加可編輯權限：每個 agent 都有自己的副本，再套用你喜歡的那份。若是規劃 → 實作 → 審查的流程，用**接力**模式，讓每個 agent 接著前一位的修改繼續做。
- 把首席 agent 設計得好的團隊存成範本，並為你的每個範本寫上說明：首席 agent 挑範本時會讀它。

## 6. 資料存在哪裡

所有對話、範本與設定都存在專案資料夾的 `data/relay.db`（SQLite），只有你的帳號能讀取。你分享的連結也記在那裡；頁面本身（連同附上的檔案）是 GitHub 上的 secret gist。API key 例外：它們放在系統的金鑰儲存區（見上方「API key（選用）」），模型來源的金鑰也一樣（端點本身則存在 `data/relay.db`）；在沒有金鑰儲存區的系統上，它們加密存在 `data/relay.db`，金鑰在 `data/secrets.key`。瀏覽器的推播訂閱與伺服器用來簽署推播通知的金鑰則存在 `data/relay.db`（瀏覽器登出時移除它的訂閱）。附加的檔案存在 `data/attachments/<對話>/`，只有你的帳號能讀取，刪除對話時（或編輯較早的訊息而刪掉它們所屬的訊息時）會一併刪除。平行模式的 worktree 放在 `data/worktrees/`（對應你 repository 中的 `relay/…` 分支），刪除對話時會一併移除。各 CLI 也會在它們平常的位置（`~/.claude…`、`~/.codex`、`~/.grok`、`~/.cursor`、`~/.gemini`、`~/.copilot`、`~/.local/share/muse`）保存自己的 session 紀錄；設定了[各 CLI 自己的資料夾](#agent-的-session各-cli-自己的資料夾與-agentsview)時則放在那個資料夾；[其他帳號](#多個帳號)放在各自的資料夾，沒有設定各 CLI 自己的資料夾時位於 `data/accounts/`。開源 agent 把它們的紀錄放在那個資料夾裡它們的家目錄，或 `data/agent-homes/`，在每位對話成員自己的資料夾（`private/<key>`）裡；它們每次執行另有自己的暫存資料夾，執行結束就刪除（完全存取以外在 `data/relay-sandbox/`，完全存取時在 `data/run-tmp/`）；伺服器在執行中停止時，則在下次啟動時刪除。刪除對話時，會移除這些 agent 為它保存的東西。Muse Code 每一輪自己的設定資料夾（這次執行的設定）放在 `data/muse-runs/`，這一輪結束就刪除；伺服器在這一輪中停止時，則由之後的某一輪刪除。語音輸入的模型（以及 Linux 與 Windows 上的引擎）放在 `data/voice/`；**設定 → 語音輸入 → 移除語音輸入** 會把它們刪除。[工具庫](#工具庫mcp-伺服器skill-與記憶)也存在 `data/relay.db`，但 MCP 伺服器變數和標頭的值例外，它們跟 API key 一樣放在金鑰儲存區。介面語言、外觀與看完的導覽版本則記在瀏覽器中。要備份時，先停止程式再複製 `data/`（連同 `secrets.key`：少了它，加密存在資料庫裡的金鑰就讀不回來）。[桌面 app](#桌面-app) 則把同樣的檔案存在它自己的資料夾，而不是 `data/`。

## 7. 疑難排解

| 狀況 | 處理方式 |
| --- | --- |
| agent 顯示「未登入」 | 到設定與登入頁登入，或設定 API key，然後按 **重新檢查狀態**。 |
| 開源 agent 顯示「尚未就緒」或「尚未設定模型來源」 | 在 **設定 → 模型來源** 設定 API key 或端點，並確認它的 CLI 已安裝。 |
| 「…沒有指定模型」 | 在團隊設定裡給這位成員一個「模型來源/模型」，或在設定頁該 agent 的卡片設定預設模型。 |
| 「…還沒有設定 OpenAI / Anthropic / xAI 的 API key」、「沒有 id 為…的自訂端點」或「它的自訂端點…已在『設定 → 模型來源』刪除」 | 在 **設定 → 模型來源** 加上那把金鑰或那個端點，或改選你已有的模型來源的模型。如果那個模型是 CLI 自己的、只是開頭和已刪除的端點一樣，在 **已刪除的端點** 為那個端點按 **忘掉**。 |
| 「模型來源…在這台電腦上，卻沒有寫連接埠」 | 在端點的網址加上伺服器的埠號（例如 `http://localhost:11434/v1`）。 |
| 「Harness Relay 自己的沙箱無法啟動」或「需要…」 | 在 Linux 上安裝 `bubblewrap`、`socat` 與 `ripgrep`（`sudo apt-get install bubblewrap socat ripgrep`），Ubuntu 23.10 以上再加上[各平台的作業系統沙箱](sandboxing.zh-TW.md#在-linux-上)裡的 AppArmor 設定檔。在 macOS 上，請從一般的終端機啟動 Harness Relay，而不是從另一個沙箱裡。或改用完全存取。 |
| 開源 agent 在 Windows 上無法執行 | 它的沙箱在原生 Windows 上無法使用：請在 WSL2 中執行 Harness Relay，或改用完全存取。 |
| 在 Windows 上，CLI 說它是 Harness Relay 無法啟動的腳本 | Harness Relay 只啟動程式，從不經過 shell。它會讀 npm 的 `.cmd` 包裝檔（包括 Copilot 的 `copilot.cmd`，試過）、Cursor 的啟動檔與 Muse Code 的啟動檔，找出它們執行的程式；其他 `.cmd` 或 `.bat`，請在「設定」中把這個 CLI 的路徑改成它執行的程式（`.exe`）。 |
| 在 Windows 上，Pi 的指令失敗並顯示「No bash shell found」 | Pi 在 bash 中執行指令：請安裝 [Git for Windows](https://git-scm.com/download/win)（MinGit 沒有 bash），或把其他的 bash 放上 PATH（MSYS2、Cygwin），或在 Pi 的 `settings.json` 設定 `shellPath`。 |
| 開源 agent 詢問要連到 github.com 之類的主機 | 它的沙箱會詢問模型來源以外的主機。例如 OpenCode 在沒有安裝 `rg` 時，會從 GitHub 下載 ripgrep：請安裝 ripgrep，或允許它。 |
| 「找不到指令」 | 安裝該 CLI（設定頁的卡片附有官網連結），或在設定頁該 provider 卡片的 **執行檔** 區塊（在各帳號下方）指定路徑。 |
| 回覆最後出現錯誤框 | 閱讀訊息內容：那是 CLI 自己的錯誤（用量限制、登入、無效模型……）。修正後按 **繼續** 或重新送出。 |
| 自動組隊總是沿用目前的團隊，或改用「一般問題智囊團」 | 卡片上會說明原因。確認首席 agent 的 CLI 已登入（設定與登入 → 首席 agent），或改選其他首席 agent。 |
| agent 好像忘了之前的對話 | 若 CLI session 無法接續，Harness Relay 會自動開新 session 並提供完整紀錄；更換工作目錄或 agent 的 CLI 後、提高權限後（Muse Code 則是權限有任何改變後，以及 Harness Relay 重新啟動後），以及更新到會記錄每個 session 權限的版本後，可編輯或完全存取的對話第一次執行時，都屬於正常現象。 |
| 模型清單是空的或過時 | 在設定頁按 **重新檢查狀態** 重新整理；也可以隨時選 **自訂…** 自行輸入模型 ID。 |
| 送出時出現「正在修改」 | 另一個對話正在寫入同一個目錄。等它結束、停止它，或改用平行 / 唯讀模式。 |
| 套用時出現「衝突」 | agent 開始之後，你的工作目錄有了變動。沒有套用任何修改；送出新訊息讓 agent 從目前狀態重新開始，或自行合併該 agent 的 `relay/…` 分支。 |
| 平行模式的 agent 無法跑測試 | worktree 不包含被忽略的檔案（例如 `node_modules/`）；請 agent 先在自己的 worktree 安裝相依套件。 |
| agent 好像卡住了 | 看看有沒有 **等你核准** 標籤或核准卡片：它可能正在等你回應。 |
| Cursor 每個指令都要問，連測試和建置也是 | 正常現象：Cursor 沒有沙箱，所以在完全存取以外的權限，沒有指令能不經詢問就執行（你的 Cursor 團隊允許清單上的除外）。在對話中選 **本對話都允許** 可以涵蓋之後類似的指令；完全存取只在你信任的資料夾使用。 |
| Cursor 的回覆以「Cursor 的服務回報錯誤：…」結束 | 這是 Cursor 服務自己的回答。*Upgrade your plan to continue*：這個模型需要帳號沒有的 Cursor 方案，請換一個模型，或改用 Auto。*Please sign in to continue*：到設定頁重新登入這個帳號，或設定 API key。*Add a payment method to continue* 或 *Check your settings to continue*：到你的 Cursor 帳號處理。其他種類的錯誤，Cursor 以純文字送來，和回覆分不出來，所以會顯示成 agent 的回覆。 |
| Cursor 的回合以「Cursor 尚未登入（…）」失敗 | 到設定頁的 Cursor 登入，或設定 API key。這則訊息不附 Cursor 自己的登入連結，因為那一輪結束後，這個連結就沒有作用。 |
| Antigravity 每個指令都要問，連測試和建置也是 | 正常現象：Harness Relay 在沒有沙箱的情況下執行它，所以在完全存取以外的權限，沒有指令能不經詢問就執行。在對話中選 **本對話都允許** 可以涵蓋之後類似的指令；完全存取只在你信任的資料夾使用。 |
| 一拒絕某個請求，Antigravity 的這一輪就停了 | 正常現象：Antigravity 在任何拒絕之後都會結束這一輪，它的模型也看不到你的說明。請在下一則訊息裡說要它改做什麼，或允許那個請求。 |
| Antigravity 的回合以「Antigravity 尚未登入（…）」失敗 | 到設定頁的 Antigravity 登入（預設帳號），或設定 Gemini API key。 |
| Antigravity 的這一輪沒有開始：「這一輪沒有開始：這個專案有 Antigravity 會在沙箱外自己執行的設定……」 | 工作目錄裡有給 Antigravity 的 MCP 伺服器、hook 或 plugin（在 `.agents` 或它的其他寫法裡），它一啟動就會在任何沙箱之外執行它們，而你拒絕了（或對話設為自動拒絕）。檢查訊息裡列出的檔案，然後移除它們、在詢問時允許它們，或改用完全存取。 |
| Antigravity agent 啟動的伺服器在這一輪結束時停了 | 正常現象：Antigravity 的這一輪結束後，Harness Relay 會結束它的指令留著執行的東西（在 Windows 上，它們會隨 Antigravity 一起結束）。想讓伺服器一直執行，請自己啟動它。 |
| 一拒絕某個操作，Copilot 的這一輪就停了 | 正常現象：Copilot 在任何拒絕之後都會結束它的這一輪，它的模型也看不到你的說明。請在下一則訊息裡說要它改做什麼，或允許這個請求。 |
| Copilot 的這一輪失敗，顯示 *Copilot 尚未登入（…）* | 到「設定」的 Copilot 登入 GitHub，或設定 GitHub token（有「Copilot Requests」權限的 fine-grained token）。 |
| 在 Linux 上，Copilot 登入失敗，顯示 *Login succeeded, but the token was not saved…* | Copilot 找不到可以存放 token 的金鑰儲存區（例如沒有桌面金鑰圈的伺服器）。在帳號的 Copilot `settings.json`（`~/.copilot/settings.json`，或帳號資料夾裡的那一個）設定 `"storeTokenPlaintext": true` 再登入一次，或把 fine-grained GitHub token（有「Copilot Requests」權限）存成帳號的 API key。 |
| Copilot 的這一輪沒有開始：*這一輪沒有開始：這個專案有 Copilot 會自己執行的 hook……* | 工作目錄裡有專案替 Copilot 準備的 hook（`.github/hooks/*.json` 檔案，或專案的 Copilot 或 Claude Code 設定裡的 hook），Copilot 會不經詢問執行它們，而你拒絕了（或對話設為自動拒絕）。檢查它列出的檔案，然後移除它們、在它詢問時允許，或改用完全存取。在帳號設定裡略過 hook 沒有用：Copilot 照樣會執行專案的 hook。首席 agent 不能詢問，所以在這種專案裡，Copilot 首席 agent 一定會遇到這個：請改選其他 CLI 當首席 agent。 |
| Copilot 的這一輪沒有開始：*這一輪沒有開始：Copilot 的沙箱不是 Harness Relay 設定的樣子（…）* | Copilot 回報的政策不是 Harness Relay 給它的那一份：它的沙箱沒有開啟、可以被繞過、讓指令能用你的鑰匙圈或 git 與 gh 的憑證，或少了某個路徑。請更新 Copilot CLI，確認這台電腦能執行它的沙箱（Linux 見下一列），或改用完全存取。 |
| 在 Linux 上，Copilot agent 執行的每個指令都以 *Cannot start sandboxed command: …* 失敗 | 它的沙箱無法啟動：安裝 bubblewrap 0.5 以上、slirp4netns、iproute2 與 iptables（也需要 util-linux 2.35 以上與 `/dev/net/tun`），並允許 unprivileged user namespace 與 network namespace（在 Ubuntu 上，`kernel.apparmor_restrict_unprivileged_userns=1` 會擋住它們）；見[各平台的作業系統沙箱 → Linux](sandboxing.zh-TW.md#linux)。或改用完全存取。 |
| 在 Linux 上，Copilot 的指令連不到這台電腦上的伺服器（`127.0.0.1`：*Couldn't connect*） | 正常現象：在 Linux 上它的沙箱裡，指令有自己的網路（slirp4netns 的），連得到網際網路，但連不到這台電腦的 loopback。改用這台電腦的區域網路位址（伺服器也要在那個位址上接受連線，不能只聽 `127.0.0.1`），把這種測試交給另一個 agent，或改用完全存取。 |
| 可編輯模式下，Copilot 沒有寫入工作目錄以外的檔案，也沒有詢問 | 正常現象：它的沙箱只讓它寫入各工作目錄與暫存資料夾，Copilot 會自己拒絕這種寫入。把那個資料夾加為工作目錄，或改用完全存取。 |
| Muse Code 的回合以「Muse Code 尚未登入（…）」失敗 | 到設定頁的 Muse Code 登入（預設帳號），或設定 Meta API key。額外的 Muse Code 帳號需要它自己的 Meta API key。 |
| Muse Code 的這一輪沒有開始：「受保護的路徑 … 含有 \*、? 或 [」 | Muse Code 會把規則裡的這些字元當成萬用字元樣式，所以無法照原樣拒絕那個路徑。請改名或移走它，或改用完全存取。 |
| 在 Windows 上，Muse Code 的每個指令都以「sandbox enforcement unavailable: windows_elevated setup_required…」失敗 | Muse Code 1.4.18 在 Windows 上的 Harness Relay 裡，完全存取以外的權限不執行任何指令：Harness Relay 驅動它的那個模式在那裡不用沙箱，所以指令會失敗，而不會在沙箱外執行。Muse 自己的沙箱設定（`muse sandbox windows setup`）改變不了這一點（試過）。它的檔案工具仍能讀寫；要執行指令，請用完全存取或其他 agent。 |
| Muse Code 的模型選單沒有列出你有的模型 | Muse Code 只在 session 裡列出它的模型。Harness Relay 會讀 Muse 登入並執行過後存下的目錄，在那之前提供一份固定的清單。選 **自訂…** 並輸入模型的 id，或先跑一輪。 |
| Muse Code 用掉的 Meta 額度或 API 費用比它的回覆看起來需要的多 | Muse 的提醒（skill、目標、檢查自己的工作、記憶、它的待辦清單與範圍）會在每一輪旁邊自己送出模型請求：簡短的回合裡，比回合本身還多。在 Muse 自己的設定 `~/.config/muse/settings.json` 裡關掉你不需要的，例如 `"runtime_capabilities": {"plugin:tbh-reminders:reminder:verify-reminder": {"enabled": false}}`（其他的是 `skill-reminder`、`goal-reminder`、`todo-reminder`、`scope-reminder`、`memory`）。Harness Relay 的執行會保留這些開關。 |
| Muse Code 說 workflow 已關閉 | Harness Relay 關掉了 Muse 的 workflow：一輪會在它們的 agent 完成前結束。請它自己做這件事，或在團隊裡多加幾位成員。 |
| 儲存 API key 失敗（「無法把 API key 存進系統的金鑰儲存區」） | 鑰匙圈 / 金鑰圈被鎖定或拒絕存取。解鎖（或在詢問時允許存取）後再儲存一次，或改用環境變數。 |
| 一直顯示「重新連線中」 | 伺服器停止或正在重新啟動；恢復後頁面會自動重新連線。 |
| 用手機或其他裝置打開時出現 *Forbidden host* | 啟動 Harness Relay 時，把那個網址的名稱加進 `RELAY_ALLOWED_HOSTS`；詳見[用手機連線](remote-access.zh-TW.md#疑難排解)。 |
| 選工作目錄時出現「範圍太大」 | 這個資料夾位在以家目錄為根目錄的 git repository 裡（例如 dotfiles repository）。請改選專案資料夾，或在專案資料夾中執行 `git init`。 |
| 有些訊息是另一種語言 | 系統訊息與錯誤會以產生當下的介面語言寫成；切換語言不會翻譯它們。 |
| 🎙 顯示無法使用麥克風 | 允許這個網頁使用麥克風（網址列旁的網站權限），並確認系統的隱私權設定允許瀏覽器使用麥克風。 |
| 語音輸入安裝失敗 | 到 **設定 → 語音輸入** 查看錯誤與安裝紀錄。macOS 請先安裝 [Homebrew](https://brew.sh)；較舊的 Linux（glibc 早於 2.34）請自行安裝 whisper.cpp，再到 **進階** 設定 **whisper-server 路徑**。 |
| 語音轉文字很慢 | 在 **設定 → 語音輸入** 改用較小的模型（Small 或 Base）；沒有 GPU 時大模型要好幾秒。隔一段時間後的第一次辨識也要先載入模型。 |
| 辨識出簡體字或錯誤的語言 | 把 **辨識語言** 從自動偵測改成「中文（繁體）」或 English；較大的模型也會比較準。 |
| 設定各 CLI 自己的資料夾後，每個 agent 都顯示「未登入」 | 正常現象：新的家目錄一開始是空的（Cursor 仍是登入狀態：它的登入屬於你的電腦使用者）。到設定頁重新登入各 CLI，或設定 API key。 |
| 設定頁顯示「上次更新 AgentsView 失敗」 | 啟動 AgentsView，或檢查 **設定 → Agent 的 session** 中的網址與 port。`ECONNREFUSED` 表示那裡沒有程式在接收。對話會在下一回合結束後再送一次。 |
| AgentsView 裡找不到某個對話 | AgentsView 會隱藏使用者只說了一則訊息的 session：在它的 session 篩選中開啟 **Include single-turn**。 |
| 桌面 app 說 port 已被佔用 | 結束用 `npm start` 啟動的 Harness Relay（或其他程式；`npm run dev` 用的是 8789，不是 app 的 port），再按 **再試一次**。也可以先結束 app，在它的 `desktop.json` 設定其他 `"port"`（見[桌面 app](#桌面-app)）。 |
| 伺服器一啟動就停止：*Another Harness Relay server is using the data folder* | 兩個伺服器不能共用同一個資料夾（各自啟動時會停掉另一個的執行）。結束另一個（例如同一個資料夾的 `npm start`），或用 `RELAY_DATA_DIR` 給這一個自己的資料夾。 |
| 桌面 app 顯示某個 CLI「找不到指令」，但它在終端機裡能用 | App 在啟動伺服器時讀取登入 shell 的環境（在 Windows 上是系統的 PATH）：安裝 CLI 之後，在選單選 **重新啟動伺服器…**。如果還是找不到，在設定中把 **執行檔** 設為 CLI 的完整路徑（在終端機執行 `which claude` 查看；Windows 上用 `where claude`，npm 的 `.cmd` 也可以）。 |
| 桌面 app 的 AppImage 在 Linux 上一啟動就結束 | 加上 `--no-sandbox` 啟動（見[桌面 app](#桌面-app)）。 |
| 桌面 app 的視窗或瀏覽器顯示登入頁 | 登入連結沒有及時使用，或視窗已被登出：視窗請從 app 的選單選 **打開 Harness Relay**，瀏覽器請選 **在瀏覽器打開**。 |
| 桌面 app 說它的伺服器太久沒有啟動完成 | 更新之後，macOS 可能會詢問 Harness Relay 能否使用鑰匙圈裡它的金鑰，伺服器會等你回答，最多三分鐘。回答之後，從選單選 **啟動伺服器**。 |
| macOS 上 **登入時自動啟動** 沒有啟動 app | macOS 要你核准：在 **系統設定 → 一般 → 登入項目與延伸功能** 允許 Harness Relay。 |
| **更新到 …** 說 Harness Relay 無法自己更新，或更新失敗 | 對話框會說明原因，並提供該版本的頁面：照第一次的方式安裝新版。在 Mac 上，請先把 app 移到「應用程式」（從 `.dmg` 或不能寫入的資料夾執行的 app 無法取代自己）。下載或檢查失敗時不會改變任何東西：app 照常以目前的版本執行。 |
| **分享到手機** 說讀不到這台電腦分享了什麼 | `tailscale serve status` 沒有回應，所以 app 沒有分享任何東西（否則可能蓋掉其他服務或 Funnel）。確認 Tailscale 正在執行並已登入，再試一次，或手動分享（見[用手機連線](remote-access.zh-TW.md)）。 |
| port 被佔用 | 換一個 port 啟動：macOS 與 Linux 用 `PORT=8790 npm start`，Windows PowerShell 用 `$env:PORT=8790; npm start`。`npm run dev` 也一樣，介面的代理會跟著 `PORT`。 |
