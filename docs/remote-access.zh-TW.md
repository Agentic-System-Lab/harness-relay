[English](remote-access.md) | **繁體中文**

# 用手機連線（Tailscale）

Harness Relay 在一台電腦上執行：agent、你的專案和各 CLI 的登入都留在那台電腦。透過 [Tailscale](https://tailscale.com)，你可以在任何地方用手機、平板或另一台電腦打開同一個聊天室，不必把它開放到區域網路或網際網路。

```mermaid
flowchart LR
  P["手機或平板<br/>（Tailscale App）"] -- "HTTPS，只在你的 tailnet 內" --> S["tailscale serve<br/>（在那台電腦上）"]
  S -- "http://127.0.0.1:8787" --> R["Harness Relay"]
  R --> A["claude · codex · grok"]
```

伺服器仍然只綁定 `127.0.0.1`。同一台電腦上的 `tailscale serve` 會接收從 tailnet 進來的請求，再轉給它。因此：

- 只有你 tailnet 裡的裝置連得到；
- 連線是有正式憑證的 HTTPS。手機瀏覽器要在 HTTPS 下才允許網頁使用麥克風（[語音輸入](user-guide.zh-TW.md#語音輸入)需要）。

## 需要準備

- **執行 Harness Relay 的電腦**：照[使用者說明](user-guide.zh-TW.md#1-安裝與啟動)設定好，agent CLI 也安裝在這台電腦上（之後可以用手機登入）。任何一直開著的電腦都可以：你的 Mac，或家用伺服器、NVIDIA DGX Spark 這類 Linux 機器。
- **那台電腦和手機都裝好 Tailscale**，並登入同一個 tailnet（iOS 與 Android 用 Tailscale App）。Mac 上如果沒有 `tailscale` 指令，到 Tailscale App 的設定裡安裝（CLI integration）。
- **MagicDNS 與 HTTPS 憑證**：在 Tailscale 管理後台的 **DNS** 頁開啟。HTTPS 還沒開的話，第一次執行 `tailscale serve` 時會印出開啟用的連結。

## 1. 把伺服器分享到 tailnet

在執行 Harness Relay 的電腦上：

```bash
tailscale serve --bg 8787
```

它會印出其他裝置要用的網址，例如：

```
Available within your tailnet:

https://my-computer.tail1234.ts.net/
|-- / proxy http://127.0.0.1:8787
```

- **只要做一次。** 加上 `--bg`，指令結束後仍會繼續分享；電腦或 Tailscale 重新啟動後也會自動恢復。
- **第一次執行**時，如果你的 tailnet 還沒啟用 Serve 或 HTTPS，指令會印出一個連結。打開並允許後，若指令已經結束，再執行一次。
- **在 Linux 上**，如果出現 *Access denied*，請加上 `sudo` 執行。也可以先執行一次 `sudo tailscale set --operator=$USER`，之後你的帳號不用 `sudo` 就能修改 Tailscale 的設定。
- **用了別的 port：** 如果你用其他 `PORT` 啟動 Harness Relay，這裡也要換成那個 port。

`tailscale serve status` 會顯示目前分享了什麼。

## 2. 用這個名稱啟動 Harness Relay

為了防範 DNS rebinding，伺服器只回應發給 `localhost` 或 `127.0.0.1` 的請求。把第 1 步的名稱加進去，不含 `https://` 和結尾的 `/`：

```bash
RELAY_ALLOWED_HOSTS=my-computer.tail1234.ts.net npm start
```

Windows PowerShell：

```powershell
$env:RELAY_ALLOWED_HOSTS="my-computer.tail1234.ts.net"
npm start
```

有多個名稱時，用逗號隔開放在同一個值裡。在電腦本機上，http://127.0.0.1:8787 照樣可以用。請用 `npm start`（建置好的介面和 API 在同一個 port），不要用 `npm run dev`。

## 3. 用手機打開

在手機上開啟 Tailscale，打開第 1 步的網址，例如 `https://my-computer.tail1234.ts.net`。聊天、**設定與登入**和語音輸入都跟在電腦上一樣，版面會配合小螢幕調整。

- **工作目錄**是那台電腦上的資料夾，不是手機上的。
- **用手機登入 agent**：選會顯示連結或代碼的方式。Codex 的「ChatGPT 瀏覽器登入」會在那台電腦上開瀏覽器，不是在手機上，請改用「ChatGPT 裝置碼」。
- **對話會繼續跑**：手機鎖定或關掉頁面時，對話仍在電腦上進行。回來後頁面會重新連線並補上進度。
- **語音輸入**：瀏覽器詢問時，允許使用麥克風。錄音會送到那台電腦轉成文字，不會傳到其他地方。

## 4. 加到主畫面

把圖示放到主畫面，點一下就能打開聊天室。手機的 Tailscale 必須開著、而且連得到那台電腦，圖示才能用。

### iPhone 與 iPad（Safari）

1. 用 Safari 打開網址。
2. 點 **分享**（看不到的話先點 **⋯**），再點 **加入主畫面**。可能要往下捲才看得到。
3. 保持 **以網頁 App 開啟**（Open as Web App）為開啟，可以改名稱，然後點 **加入**。

在 iOS 與 iPadOS 26 以後，圖示會把 Harness Relay 當成網頁 App 打開：全螢幕，沒有 Safari 的網址列。較舊的版本則是在 Safari 裡打開。網頁 App 的儲存空間跟 Safari 分開，所以第一次在那裡打開時會再出現一次使用導覽，介面語言也會先跟著手機的語言設定。iOS 上的 Chrome 與 Edge，分享選單裡也有 **加入主畫面**。

### Android（Chrome）

1. 用 Chrome 打開網址。
2. 點右上角的 **⋮**，再點 **加到主畫面**（Add to home screen）。較新版本的 Chrome 改叫 **安裝並建立捷徑**（Install and create shortcut）。
3. Chrome 有提供 **安裝**（Install）就選它，否則選 **建立捷徑**（Create shortcut），再點 **新增**。也可以直接把圖示拖到想放的位置。

圖示上有小 Chrome 標誌的捷徑，會在 Chrome 裡打開頁面。Samsung Internet 也有同樣的功能，在選單的 **新增頁面至 → 主螢幕**（Add page to → Home screen）。

## 讓它一直執行

只有在電腦醒著、伺服器也在執行時，手機才連得到 Harness Relay。

### macOS

用 `caffeinate -i` 啟動，伺服器執行期間 Mac 就不會進入睡眠：

```bash
RELAY_ALLOWED_HOSTS=my-computer.tail1234.ts.net caffeinate -i npm start
```

MacBook 闔上螢幕時仍會睡眠，除非它接著電源和外接螢幕。

### Linux 伺服器（systemd）

在透過 SSH 使用的機器上（例如家用伺服器或 DGX Spark），把 Harness Relay 設成 systemd user service，開機時自動啟動，停掉時也會自動重啟。下面的例子假設 repository 在 `~/harness-relay`。建立 `~/.config/systemd/user/harness-relay.service`：

```ini
[Unit]
Description=Harness Relay
After=network-online.target

[Service]
WorkingDirectory=%h/harness-relay
Environment=PORT=8787
Environment=RELAY_ALLOWED_HOSTS=my-computer.tail1234.ts.net
# systemd 不會讀 shell 的設定檔。把 `echo $PATH` 的結果貼在這裡，
# 伺服器才找得到 node 以及 claude、codex、grok 指令。
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=%h/harness-relay/node_modules/.bin/tsx src/server/index.ts
# 只停止伺服器：它會自己停掉 agent 的程序。
KillMode=mixed
TimeoutStopSec=20
# 用 SIGTERM 停止是正常停止，不算失敗。
SuccessExitStatus=143
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

接著啟動它，並讓它在你登出後繼續執行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now harness-relay
sudo loginctl enable-linger $USER
```

| 指令 | 作用 |
| --- | --- |
| `systemctl --user status harness-relay` | 看它是否在執行 |
| `journalctl --user -u harness-relay -f` | 即時看 log |
| `systemctl --user restart harness-relay` | 重新啟動（更新之後，或修改 unit 檔並執行 `systemctl --user daemon-reload` 之後） |
| `systemctl --user disable --now harness-relay` | 停止，並取消開機自動啟動 |

更新時，在 `~/harness-relay` 執行：

```bash
git pull
npm install
npm run build
systemctl --user restart harness-relay
```

重新啟動會中斷正在進行的 agent 回合，請在沒有對話正在回覆時更新。

在伺服器上：

- **port 已被佔用：** 如果 8787 已經被其他程式使用，在 unit 檔設定另一個 `PORT`，第 1 步也分享那個 port。
- **登入各 CLI：** 在瀏覽器的 **設定與登入** 登入（用裝置碼或連結），或透過 SSH 執行各 CLI 自己的登入指令。
- **API key：** 沒有桌面環境的機器通常沒有 Secret Service，在設定頁儲存的 API key 會留在 `data/relay.db`（見 [API key](user-guide.zh-TW.md#api-key選用)）。若不想這樣，改在 unit 檔加上 `Environment=ANTHROPIC_API_KEY=…` 或 `XAI_API_KEY`。

## 安全性

- **tailnet 裡的每台裝置都能使用它**，權限就是 agent 在那台電腦上的權限：Harness Relay 本身沒有登入機制。如果你的 tailnet 有其他人，請用 Tailscale 的[存取控制](https://tailscale.com/kb/1018/acls)，只讓你自己的裝置連到那台電腦。
- **不要用 `tailscale funnel`。** 它會把頁面公開到整個網際網路。
- **不要為了用 Wi-Fi 連線而用 `HOST=0.0.0.0` 啟動伺服器。** 這樣同一個網路上的任何人都能透過未加密的 HTTP 操作有寫入權限的 agent，手機瀏覽器也不會允許使用麥克風。
- **電腦的名稱會被公開。** 開啟 HTTPS 憑證後，Tailscale 會把每台取得憑證的電腦的完整名稱（`my-computer.tail1234.ts.net`）記錄在公開的 Certificate Transparency 紀錄中。不要用帶有私人資訊的電腦名稱。
- **停止分享：** `tailscale serve --https=443 off`。（`tailscale serve reset` 會移除這台電腦分享的所有內容，包含其他服務。）

## 疑難排解

| 狀況 | 處理方式 |
| --- | --- |
| 頁面打得開但什麼都載不出來，錯誤顯示 *Forbidden host* 或 *Forbidden origin* | `RELAY_ALLOWED_HOSTS` 跟你打開的網址不一樣。照 `tailscale serve status` 顯示的名稱填寫，不含 `https://`，然後重新啟動 Harness Relay。 |
| 網址完全打不開 | 確認手機的 Tailscale 已開啟，並登入跟電腦同一個 tailnet（Tailscale App 可以切換帳號）；確認電腦醒著；確認電腦上的 `tailscale serve status` 還顯示這個網址。 |
| Linux 上的 `tailscale serve` 出現 *Access denied* | 加上 `sudo` 執行，或先執行一次 `sudo tailscale set --operator=$USER`。 |
| 出現其他程式的頁面或憑證 | 電腦上有其他程式在監聽 443 port，沒有分享時就由它回應。先看 `tailscale serve status`：網址不見了就重做第 1 步。如果網址還在、卻仍由那個程式回應，就改用其他 port 分享：`tailscale serve --bg --https=8443 8787`，然後打開 `https://my-computer.tail1234.ts.net:8443`（`RELAY_ALLOWED_HOSTS` 不用改）。 |
| 只有以 service 執行時，agent 顯示「找不到指令」 | service 的 `PATH` 裡沒有那個 CLI。用 `command -v claude`（或 `codex`、`grok`）找到它的位置，把所在資料夾加進 `Environment=PATH=`，再重新啟動。 |
| 手機上 🎙 顯示無法使用麥克風 | 請打開 `https://` 開頭的網址，不要用 `http://`。在瀏覽器允許這個網站使用麥克風，並在手機設定中允許該瀏覽器使用麥克風。 |
| 主畫面圖示打開後是空白或錯誤頁 | 開啟手機的 Tailscale，再點一次圖示。 |
