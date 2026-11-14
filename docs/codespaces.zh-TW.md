[English](codespaces.md) | **繁體中文**

# 在 GitHub Codespaces 試用

codespace 是 GitHub 雲端上一台屬於你的 Linux 機器。這個 repo 的 dev container（`.devcontainer/`）會幫 Harness Relay 準備好一台：Node.js、Linux 上沙箱需要的套件、五個 agent CLI，並建置、啟動 app。你在瀏覽器裡就能試用 Harness Relay，電腦上不用安裝任何東西。

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Agentic-System-Lab/harness-relay?quickstart=1)

## 費用

codespace 算在你的 GitHub 帳號上。GitHub Free 個人帳號每月含 120 core-hours 和 15 GB-month 的儲存空間；這個 dev container 要的 2 核機器每小時用 2 core-hours，大約是 60 小時。codespace 閒置 30 分鐘後會停下（在 GitHub 上可以改），停下的 codespace 在你到 [github.com/codespaces](https://github.com/codespaces) 刪掉之前，仍會計算儲存空間。詳見 [About billing for GitHub Codespaces](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces)。

## 步驟

1. **建立。** 點上面的按鈕，再點「**Create codespace**」。第一次約需兩分鐘：安裝套件與 CLI、建置介面。在「**Change options**」裡也能先填入它提供的 API key（見 [API key](#api-key)）。
2. **登入。** 編輯器開好後，它的終端機會啟動 Harness Relay（`bash .devcontainer/start.sh`），並印出 codespace 自己網址上的登入連結 `https://<codespace>-8787.app.github.dev/#code=…`，旁邊附上登入碼。打開這個連結。第一次 GitHub 可能會先確認是你本人，再放行頁面，接著頁面會要你輸入登入碼：輸入終端機印出的那組即可。
3. **登入 agent。** 在「**設定與登入**」用連結或裝置代碼登入 Claude Code 或 Codex，或為 OpenCode 和 Pi 設定[模型來源](open-agents.zh-TW.md)。如果你的 GitHub 帳號有 Copilot，Copilot 已經用 codespace 的 GitHub token 登入了（見 [codespace 的 GitHub token](#codespace-的-github-token)）。
4. **提問。** 點「**新對話**」，工作目錄用 `/workspaces/playground`：dev container 已經幫你建好。Harness Relay 自己的資料夾（`/workspaces/harness-relay`）和包含它的 `/workspaces`，在完全存取以下的編輯模式都會被拒絕。

在那個終端機按 Ctrl+C 停止伺服器，用 `bash .devcontainer/start.sh` 再次啟動。伺服器執行中時再跑同一個指令，可以拿到另一個登入連結，給另一個瀏覽器或手機用。

已安裝：Claude Code、Codex、Copilot、OpenCode 和 Pi。其他的請照 [README](../README.zh-TW.md#需求) 在 codespace 的終端機安裝；再次打開「**設定與登入**」時 Harness Relay 就會找到它們。

## 安全

- **網址是私人的。** Codespaces 只讓你的 GitHub 帳號打開它。不要把 port 改成公開（「**Ports**」→「**Port Visibility**」）：否則任何知道網址的人，都能連到可以寫檔的 agent 的登入頁。
- **完全存取以下沙箱可以運作。** 為了 bubblewrap，dev container 以 `seccomp`、`apparmor` 和 `systempaths` 不受限制的方式執行，並給 Copilot 的沙箱一個 TUN 裝置。這讓容器和外面那台機器之間的隔離少了一些；在 codespace 裡，那台機器只屬於你。Harness Relay 自己的沙箱（`npx tsx scripts/sandbox-check.ts`：51 項全數通過）、Codex 和 Copilot 的沙箱都在 codespace 裡試過；見[各平台的作業系統沙箱](sandboxing.zh-TW.md#docker-與-dev-container)。
- **你登入的東西都留在 codespace 裡**：各 CLI 的登入在它的 home 資料夾，資料庫在 `data/`。能使用你 GitHub 帳號的人都能打開它。用完請刪除 codespace；如果也想結束各 CLI 的登入，先登出它們。

### codespace 的 GitHub token

Codespaces 會在 codespace 的環境變數裡放一個你的 GitHub token（`GITHUB_TOKEN`）。Harness Relay 會像傳遞你 shell 裡的變數一樣把它交給 agent：Copilot 用它登入，有完全存取的 agent 也能像你一樣使用它，範圍是 Codespaces 給它的權限（見 [Security in GitHub Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)）。不想讓 agent 拿到它，就不帶它啟動伺服器：

```bash
env -u GITHUB_TOKEN bash .devcontainer/start.sh
```

### API key

codespace 沒有系統金鑰圈，所以在「**設定**」裡輸入的 API key 會留在 codespace 裡的資料庫。建議改用 Codespaces secret：建立頁的「**Change options**」提供 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 和 `XAI_API_KEY`，其他的可以在 GitHub 的「**Settings → Codespaces**」為這個 repo 設定。它們會以環境變數的形式交給伺服器。這時 Claude Code 會改用 `ANTHROPIC_API_KEY`、Codex 會改用 `OPENAI_API_KEY`，而不是你的登入，依用量計費。

## 其他地方

同一個 dev container 也能在你自己的電腦上，用 VS Code 的 Dev Containers 或 `devcontainer` CLI 執行。這時 `start.sh` 就是 `npm start`：打開它印出的 `http://127.0.0.1:8787` 連結即可。

給維護者：[prebuild](https://docs.github.com/en/codespaces/prebuilding-your-codespaces) 能讓 codespace 更快就緒。它算在 repo 擁有者的帳上，目前沒有設定。
