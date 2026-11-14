[English](codespaces.md) | **繁體中文**

# 在 GitHub Codespaces 試用

codespace 是 GitHub 雲端上一台屬於你的 Linux 機器。這個 repo 的 dev container（`.devcontainer/`）會幫 Harness Relay 準備好一台：Node.js、Linux 上沙箱需要的套件、GitHub CLI、五個 agent CLI，並建置、啟動 app。你在瀏覽器裡就能試用 Harness Relay，電腦上不用安裝任何東西。

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Agentic-System-Lab/harness-relay?quickstart=1)

## 費用

codespace 算在你的 GitHub 帳號上。GitHub Free 個人帳號每月含 120 core-hours 和 15 GB-month 的儲存空間；這個 dev container 要的 2 核機器每小時用 2 core-hours，大約是 60 小時。codespace 閒置 30 分鐘後會停下（在 GitHub 的「**Settings → Codespaces**」可以改；要跑很久之前請先調高），停下的 codespace 在你到 [github.com/codespaces](https://github.com/codespaces) 刪掉之前，仍會計算儲存空間。詳見 [About billing for GitHub Codespaces](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces)。

## 步驟

1. **建立。** 點上面的按鈕，再點「**Create codespace**」。第一次約需兩分鐘：安裝套件與 CLI、建置介面。在「**Change options**」裡也能先填入它提供的 API key（見 [API key](#api-key)）。
2. **登入。** 編輯器開好後，它的終端機會啟動 Harness Relay（`bash .devcontainer/start.sh`），並印出 codespace 自己網址上的登入連結 `https://<codespace>-8787.app.github.dev/#code=…`，旁邊附上登入碼。打開這個連結。第一次 GitHub 可能會先確認是你本人，再放行頁面，接著頁面會要你輸入登入碼：輸入終端機印出的那組即可。
3. **登入 agent。** 在「**設定與登入**」：Claude Code 用它的連結，Codex 用它的裝置代碼（它用瀏覽器登入時，會把瀏覽器導回 `localhost`，那是你自己的電腦，不是 codespace）。Copilot 用 codespace 的 GitHub token 登入（見 [codespace 的 GitHub token](#codespace-的-github-token)），等 Copilot 回報你帳號的方案後才顯示為已登入；Copilot Free 也算。Pi 則要設定[模型來源](open-agents.zh-TW.md)。
4. **提問。** 點「**新對話**」，工作目錄用 `/workspaces/playground`：dev container 已經幫你建好。Harness Relay 自己的資料夾（`/workspaces/harness-relay`）和包含它的 `/workspaces`，在完全存取以下的編輯模式都會被拒絕。

在那個終端機按 Ctrl+C 停止伺服器，用 `bash .devcontainer/start.sh` 再次啟動。伺服器執行中時再跑同一個指令，可以拿到另一個登入連結，給另一個瀏覽器或手機用。

已安裝：Claude Code、Codex、Copilot、OpenCode 和 Pi。其他的請照 [README](../README.zh-TW.md#需求) 在 codespace 的終端機安裝，但有兩個例外：README 用 Homebrew 安裝 Goose，而 codespace 沒有 Homebrew（請看 Goose 自己的安裝說明）；OpenHands 要先裝 [uv](https://docs.astral.sh/uv/)。裝到伺服器 `PATH` 上原本沒有的資料夾（例如建立之後的 `~/.local/bin`）的 CLI，要重新啟動伺服器後才找得到。

## 在那裡有什麼不同

- **沒有選資料夾的對話框。** 系統的選資料夾對話框只會為伺服器那台電腦上的瀏覽器打開，所以請直接輸入工作目錄的路徑。
- **OpenCode 只能用完全存取。** 在 Linux 上，Harness Relay 自己的沙箱看不到 OpenCode 的伺服器，所以完全存取以下會拒絕執行它（見[開源 agent](open-agents.zh-TW.md)）。Pi 可以在完全存取以下執行。
- **要先登入 gh 才能分享成連結。** GitHub CLI 已經裝好，但 codespace 自己的 token 不能建立分享對話所用的 gist，而且只要那個 token 還在，`gh auth login` 就不肯保存登入。請在 codespace 的終端機裡，不帶它登入 gh 一次：

  ```bash
  env -u GITHUB_TOKEN gh auth login
  ```

  之後 Harness Relay 的 `gh` 分享時就會用這個登入（並且不帶 codespace 的 token）。codespace 裡沒有金鑰圈，所以 gh 把登入存成它資料夾（`~/.config/gh`）裡的一個檔案；在 codespace 裡，完全存取以下的 agent 讀不到這個資料夾（見[安全](#安全)）。
- **沒有桌面 app。** 選單、用 Tailscale 分享和 app 的更新都是桌面 app 的功能；這裡只有伺服器本身（`npm start`）。
- **沒在那裡試過：** 語音輸入、推播通知，以及登入 Claude Code 和 Codex。

## 安全

- **網址是私人的。** Codespaces 只讓你的 GitHub 帳號打開它。不要把 port 改成公開（「**Ports**」→「**Port Visibility**」）：否則任何知道網址的人，都能連到可以寫檔的 agent 的登入頁。
- **完全存取以下沙箱可以運作。** 為了 bubblewrap，dev container 以 `seccomp`、`apparmor` 和 `systempaths` 不受限制的方式執行，並給 Copilot 的沙箱一個 TUN 裝置。這讓容器和外面那台機器之間的隔離少了一些；在 codespace 裡，那台機器只屬於你。Harness Relay 自己的沙箱（`npx tsx scripts/sandbox-check.ts`：51 項全數通過）、Codex 和 Copilot 的沙箱都在 codespace 裡試過；見[各平台的作業系統沙箱](sandboxing.zh-TW.md#docker-與-dev-container)。
- **完全存取以下，agent 讀不到 codespace 的 token 檔案**：`/workspaces/.codespaces`（Codespaces 在那裡以 codespace 裡每個程式都讀得到的檔案，存放它的 token、登入各 registry 的憑證和你的 Codespaces secret），以及 gh 的資料夾（見 [agent 不能讀寫的地方](sandboxing.zh-TW.md#agent-不能讀寫的地方)）。有完全存取的 agent 讀得到 codespace 裡的任何東西。
- **你登入的東西都留在 codespace 裡**：各 CLI 的登入在它的 home 資料夾，資料庫在 `data/`。能使用你 GitHub 帳號的人都能打開它。用完請刪除 codespace；如果也想結束各 CLI 的登入，先登出它們。

### codespace 的 GitHub token

Codespaces 會給 codespace 裡的每個程式一個你的 GitHub token（`GITHUB_TOKEN`），權限是 Codespaces 給它的範圍（見 [Security in GitHub Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)）。Harness Relay 會像傳遞你 shell 的環境一樣，把它連同其他環境變數交給 agent：Copilot 用它登入，任何 agent 的指令也都能使用它，完全存取以下也一樣（例如 Copilot 的沙箱允許它的指令連上網路）。不想讓它出現在 agent 的環境裡，就不帶它啟動伺服器：

```bash
env -u GITHUB_TOKEN bash .devcontainer/start.sh
```

Copilot 自己的裝置登入需要金鑰圈，而 codespace 沒有：請改給它一個它自己的 token，設成 `COPILOT_GITHUB_TOKEN` 這個 Codespaces secret。

### API key

codespace 沒有系統金鑰圈，所以在「**設定**」裡輸入的 API key 會留在 codespace 裡的資料庫。Claude Code 和 Codex 的 key 建議改用 Codespaces secret：建立頁的「**Change options**」提供 `ANTHROPIC_API_KEY` 和 `OPENAI_API_KEY`，其他的可以在 GitHub 的「**Settings → Codespaces**」為這個 repo 設定。它們會以環境變數的形式交給伺服器。這時 Claude Code 會改用 `ANTHROPIC_API_KEY`、Codex 會改用 `OPENAI_API_KEY`，而不是你的登入，依用量計費。開源 agent 只用「**設定 → 模型來源**」裡設定的 key。

## 在你自己的電腦上

同一個 dev container 也能用 VS Code 的 Dev Containers 執行，它會把 port 轉發到你的電腦：這時 `start.sh` 就是 `npm start`，打開它印出的 `http://127.0.0.1:8787` 連結即可。它的容器選項同樣會削弱 Docker 與你電腦之間的隔離：在那裡，有完全存取的 agent 可能透過它們碰到你的電腦，所以只在 codespace 裡給 agent 完全存取。

給維護者：[prebuild](https://docs.github.com/en/codespaces/prebuilding-your-codespaces) 能讓 codespace 更快就緒。它算在 repo 擁有者的帳上，目前沒有設定。
