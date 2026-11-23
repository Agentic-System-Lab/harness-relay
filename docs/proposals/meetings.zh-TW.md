[English](meetings.md) | **繁體中文**

# 會議筆記

> **狀態：尚未開始；一份調查，以及它建議的設計。** 見[提案](README.zh-TW.md)。

要讓 Harness Relay 做到 [Grok Bot 的會議功能](https://docs.x.ai/grok-bot/meetings)需要什麼：一個團隊替使用者的 Google Meet、Zoom 與 Microsoft Teams 通話做筆記，通話進行中回答關於它的問題，結束後給出摘要與待辦事項，也能再把它們送出去。以及一個在使用者自己電腦上、沒有公開位址的程式，有哪些進入會議的途徑，每條途徑又會對 Harness Relay 的防護要求什麼。

## 怎麼找到的

2026-11-23 對 Harness Relay 的程式碼、xAI 的 Grok Bot 文件，以及 Microsoft、Google、Zoom、Apple、Electron、whisper.cpp 與會議 bot 服務的文件、更新紀錄與開發者論壇所做的調查，再由沒參與調查的審查者檢查一次（關於程式碼的說法對照程式碼、設計所依據的來源重新讀過、每個連結都打開過）。除了讀已安裝的桌面 app 的 Info.plist 之外，沒有安裝、登入或執行任何東西。關於其他產品的每項發現都有標記：

- **docs**：出自廠商自己的文件、更新紀錄、公告或公開的程式碼；
- **reported**：只見於媒體、論壇（包括廠商自己的論壇）或第三方的文章；
- **unsure**：尚未確認；在據此實作之前要先查證。

關於 Harness Relay 本身的說法都註明檔案，不加標記。

## Grok Bot 做什麼

出自[它的會議頁面](https://docs.x.ai/grok-bot/meetings)與相鄰的頁面（**docs**；其中幾頁仍帶著另一個產品的名稱與網址，所以以下是文件的說法，不是實際看到的行為）：

- 它以名為「*名稱*（*你的名字* 的 Bot）- transcribing」的參與者加入 Google Meet、Zoom 或 Teams 通話，由主持人放行。「It listens, takes notes, answers questions in the meeting chat, and sends you a summary and action items when the call ends.」沒有任何地方說它會說話。
- 派它去有三種方式：把會議連結貼到它的對話裡（並核准一張卡片）、讓它跟著使用者的行事曆，或用 routine（routine 派去的 bot 只做筆記，不在會議聊天裡回答）。
- 每場會議有 Disable Interactivity（只做筆記；在它加入之前）、Cancel 與 Quit。過去會議的摘要與逐字稿之後還能再要；長的報告放在一個頁面上。
- 會議裡有人要它扣下來的東西時，它會告訴主人是誰要的，並提議送出；它絕不在會議裡分享主人的憑證。
- 管理員可以替整個組織關掉會議功能。文件沒有寫 API、錄音廠商、通知（名稱之外）、限制或語言。

## 現在有什麼

- **語音輸入**（`src/server/voice.ts`）：whisper.cpp 的 `whisper-server`，從設定安裝（macOS 上來自 Homebrew；其他系統是固定版本的發行檔，和每個模型一樣以 SHA-256 檢查），在 127.0.0.1 的隨機連接埠、隨機路徑前綴下以 `--no-timestamps` 啟動，閒置就停止。它一次接受一段最長 120 秒的錄音（`src/shared/types.ts` 的 `VOICE_MAX_SECONDS`），由頁面把 WAV 以 base64 放在 JSON 裡送來（`POST /api/voice/transcribe`，大小在 `src/server/app.ts` 的 `VOICE_MAX_BASE64` 之內）；中文時帶一段讓它以正體字寫出的提示（`whisperLanguage()`）。頁面只錄麥克風（`src/web/recorder.ts`）。
- **桌面 app 的媒體**（`desktop/src/lifecycle.ts` 的 `permissionAllowed()`）：伺服器自己的頁面可以使用麥克風，其他媒體都不行。它的資源存取 entitlement 是麥克風與 Apple Events 的（`desktop/entitlements.mac.plist`）；Harness Relay 設定了麥克風與 Apple Events 的用途說明（`desktop/electron-builder.yml` 的 `extendInfo`，翻譯在 `desktop/macos/*.lproj/InfoPlist.strings`），而 Electron 自己的 Info.plist 還加上一些通用的說明，其中包括 `NSAudioCaptureUsageDescription`（「This app needs access to audio capture」），已安裝的 app 裡看得到。它跑在 Electron 45 上，簽章是 ad hoc。
- **行事曆**（`src/server/connectors/caldav.ts` 的 `CalendarEvent`、`graph.ts` 的 `graphEvent()`）：事件的標題、時間、地點、說明與參與者，但沒有它的線上會議。Graph 的 `onlineMeeting`、`isOnlineMeeting` 與 `onlineMeetingProvider` 沒有要，它的說明也只是內文的開頭（`bodyPreview`）；iCalendar 的 `CONFERENCE` 沒有讀。會議連結只在它寫在地點或那段說明裡時才拿得到。
- **在事件開始前啟動的自動任務**（`src/server/watch.ts` 的 `checkCalendar()`）：即將開始的事件，每個一次，以 `<event>` 資料區塊送出。事件結束時什麼都不會啟動。
- **用 OAuth 登入的 Microsoft 帳號**（`src/server/oauth/providers.ts` 的 `microsoftProvider()`）：Graph 的行事曆（`Calendars.ReadWrite`）與 Teams 讀取（`Team.ReadBasic.All`、`Channel.ReadBasic.All`、`ChannelMessage.Read.All`）。沒有會議、逐字稿或錄影的 scope。
- **Teams 發文**（`src/server/connectors/teams.ts`、`messaging.ts`）：透過 Microsoft Graph PowerShell 的發文工作階段（`ChatMessage.Send`、`ChannelMessage.Send`），`teams_send_message` 對複製的訊息連結所指的聊天或頻道提出一則訊息。它是 `send` 工具，所以在每種權限下都在待送出匣等使用者確認。Teams 會議的聊天也是一個聊天，但 `destinationFromLink()` 會拒絕會議的加入連結（`/l/meetup-join/…`），雖然傳統的加入連結裡就帶著聊天的 thread（**unsure**：沒有對會議聊天試過發文）。
- **Google Drive**（`src/server/connectors/apps.ts`）：`drive_search` 與 `drive_read_document`（`drive.readonly`）可能已經能讀 Meet 存成 Google 文件的逐字稿與 Gemini 筆記，只要帳號能開啟它們（**unsure**：沒有對那些文件試過）。
- **從外面來的文字**：工具從外面拿到的結果，放在標明是資料的區塊裡交給 agent，裡面的文字關不掉它的標籤（`src/server/gateway.ts` 的 `dataBody()`）；RLM 模式（`src/server/runCode.ts`，設定 → 實驗室）會分段讀長文字。
- **瀏覽器工具**（`src/server/browser/`）：每個對話一個 headless Chromium，有它自己的設定檔，每個連線都經過 Harness Relay 的 proxy，WebRTC 也限制在它上面、沒有自己的 UDP（`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`），沒有麥克風，聲音也是靜音（`--mute-audio`）。

## 缺什麼

- 擷取通話中其他人說的話（會議 app 的聲音），在任何系統上都沒有。
- 邊錄邊轉寫長時間的錄音，並保存逐字稿：誰在什麼時候說了什麼。
- 會議作為對話的一部分：它的卡片與控制、交給 agent 的逐字稿、它的摘要。
- 行事曆事件的會議連結與會議本身（Teams 的線上會議、Meet 的會議〔conference〕），以及會議結束之後的任何事。

## 進入會議的途徑

| 途徑 | 平台 | 即時 | 需要什麼 | 阻礙 |
| --- | --- | --- | --- | --- |
| A. **在這台電腦上**：使用者的麥克風與會議的聲音，由 whisper.cpp 轉寫 | 每個 app，也包括面對面的會議 | 是 | 桌面 app 的系統音訊權限，或在 Chrome、Edge 裡分享的分頁 | 要在使用者自己的電腦上，且使用者在場；告知其他人是使用者的事 |
| B. **平台自己的逐字稿**，會後讀取 | Teams、Meet、Zoom | 否 | 開啟轉寫的公司或學校帳號；下面列的 scope | 管理員同意（Teams）；只有主辦人或主持人（Meet 的清單、Zoom）；晚幾分鐘到幾小時 |
| C. **bot 服務的參與者**（Recall.ai、Attendee、Vexa、Meeting BaaS、Skribby） | 三者都有 | 只在有公開端點時 | 一個帳號與金鑰；每小時 0.30–0.50 美元，轉寫另計 | 所有人的聲音都送到第三方；2026 年對 bot 的規則（見下） |
| D. **Harness Relay 自己的 bot**：瀏覽器工具，或像 joinly 那樣的 | Meet、Teams | 是 | 有媒體、已登入的瀏覽器 | 同 C，加上瀏覽器工具的防護 |
| E. **平台的即時 API** | — | 是 | 公開 URL（Zoom RTMS 的 webhook）、Azure 上的 Windows Server 媒體 bot（Teams）、加入開發者預覽計畫（Meet Media API） | 沒有一個能連到 127.0.0.1 上的伺服器；Meet 的 Media API 在 2027-01-15 終止 |

### A. 在這台電腦上

各系統提供的：

| 系統 | 會議的聲音 | 只擷取一個 app | 權限 |
| --- | --- | --- | --- |
| macOS 14.2+ | Core Audio process tap（`AudioHardwareCreateProcessTap`）；Electron 的 `audio: 'loopback'`，從 Electron 39 起就是一個 tap（**docs**） | 依行程，macOS 26 起也可依 bundle ID；瀏覽器的分頁不行，它的聲音來自一個輔助行程（**docs**、**reported**） | 「僅限系統錄音」，Info.plist 要有 `NSAudioCaptureUsageDescription`，不需要 entitlement（**docs**）。沒有 API 能事先請求或查詢是否已允許（Apple 工程師在它的論壇上說的，**reported**）；透過 Electron 時，被拒絕的權限會給一條一開始就是 `ended` 的音訊軌（**docs**）。Electron 的做法還會要一條影片軌，所以大概也會要螢幕錄製權限（**unsure**） |
| Windows | WASAPI loopback，Electron 的 `loopback`（**docs**） | 從 build 20348 起有 process loopback，實際上就是 Windows 11（**docs**，它的頁面對 build 號說法不一） | 不會詢問（**reported**） |
| Linux | PulseAudio 或 PipeWire 的 monitor（`parec -d @DEFAULT_MONITOR@`、`pw-record`）（**docs**） | 依串流 | 不用：使用者的任何行程都能錄。Electron 在 Linux 上沒有 loopback，Chromium 也把 monitor 從 `getUserMedia` 藏起來（**docs**） |
| 瀏覽器 | Chrome 與 Edge：每個桌面系統上都能分享分頁的聲音（`getDisplayMedia`）（**docs**）；Windows 與 ChromeOS 上可分享整個系統的聲音，macOS 14.2+ 從 Chrome 141 起也可以（**reported**） | 那個分頁 | 每次都用分享選擇器，並勾選分享音訊；Firefox 與 Safari 不分享聲音（**docs**） |

- ad hoc 簽章：macOS 把隱私權限綁在 app 的簽章上，所以 ad hoc 簽章的 app 每次更新都會失去它的權限（**reported**，Apple 的開發者支援在它的論壇上說的，談的是螢幕錄製）；系統錄音權限是否也一樣：**unsure**。
- 我與對方：分開擷取麥克風與會議的聲音，就能分出使用者與其他人，Granola 與 OpenWhispr 就是這樣做（**reported**）；whisper.cpp 的 `--diarize` 會把立體聲錄音的兩個聲道標成兩位說話者（**docs**）。不戴耳機時麥克風也會收到其他人的聲音，而 Chromium 的回音消除只去掉 Chromium 自己播放的聲音（**unsure**）。
- 邊錄邊轉寫：`whisper-server` 沒有串流端點，只有給檔案用的 `/inference`，並接受 `--vad`（Silero，要有它自己的模型檔）（**docs**）；它的 `whisper-stream` 範例只讀 SDL 的麥克風（**docs**，它的原始碼）。所以要在停頓處切成幾秒到 30 秒的片段，落在語音輸入的限制之內。在 M2 Ultra 到 M5 Max 上，用 large-v3-turbo 或更小的模型，光是編碼一個 30 秒的區段就要 21–256 毫秒（whisper.cpp 自己的 benchmark，**docs**）；解碼還要另外算，基本款晶片與 CPU 版本都沒有量過。
- 台灣華語夾雜英語：Breeze-ASR-25（聯發科，Apache-2.0，以 Whisper large-v2 微調），有社群轉成的 GGML 版本（模型是 **docs**，轉換版是 **reported**）。Apple 的 `SpeechTranscriber`（macOS 26+）有 zh-TW，一個 transcriber 一種語言，只能從 Swift 用（**docs**，zh-TW 是 **reported**）。
- 不用 bot 的產品：Granola（Electron、tap 或 ScreenCaptureKit、我與對方、在雲端轉寫）、Notion 的 AI Meeting Notes、Fireflies 與 Otter 的桌面 app。它們都把告知其他人的事留給使用者，提供一段貼到會議聊天的文字、一段語音通知，或視訊畫面上的標記（**docs**）。
- 同意：加州錄下機密對話要所有參與者同意（刑法 §632），另外幾個州也是（**reported**，各處清單不同）；在台灣，通訊的一方可以錄音（通訊保障及監察法 §29，**docs**）。2025 年 8 月依加州與伊利諾州法律對 Otter.ai 提起的集體訴訟還在進行中（**reported**）。

來源：[process tap](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)、[`NSAudioCaptureUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription)、[它的權限](https://developer.apple.com/forums/thread/756783)、[ad hoc 的權限](https://developer.apple.com/forums/thread/795739)、[Electron 的 `desktopCapturer`](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[Electron 的 tap](https://releases.electronjs.org/pr/49717)、[WASAPI loopback](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)、[process loopback](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-audioclient_activation_type)、[pactl](https://man.archlinux.org/man/pactl.1.en.txt)、[`getDisplayMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)、[Chrome 141](https://developer.chrome.com/release-notes/141)、[macOS 上的 Chrome](https://blog.addpipe.com/getdisplaymedia-allows-capturing-the-screen-with-system-sounds-on-chrome-on-macos/)、[whisper.cpp 的 server](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md)、[它的 CLI](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md)、[它的 stream 範例](https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream/stream.cpp)、[它的 benchmark](https://github.com/ggml-org/whisper.cpp/blob/master/scripts/bench-all-gg.txt)、[Breeze-ASR-25](https://huggingface.co/MediaTek-Research/Breeze-ASR-25)、[`SpeechTranscriber`](https://developer.apple.com/documentation/speech/speechtranscriber)、[OpenWhispr](https://openwhispr.com/blog/local-speaker-diarization)、[Granola](https://docs.granola.ai/help-center/taking-notes/transcription)、[Granola 的告知](https://docs.granola.ai/help-center/consent-security-privacy/transparency-solutions/introduction)、[Notion](https://www.notion.com/help/ai-meeting-notes)、[Fireflies](https://guide.fireflies.ai/articles/6666374717-how-to-record-meetings-without-a-bot-on-the-fireflies-desktop-app)、[§632](https://law.justia.com/codes/california/code-pen/part-1/title-15/chapter-1-5/section-632)、[§29](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0060044&flno=29)、[Otter.ai 的訴訟](https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit)。

### B. 平台自己的逐字稿

| | Teams（Graph） | Google Meet | Zoom |
| --- | --- | --- | --- |
| 從行事曆事件找到會議 | `onlineMeeting.joinUrl`，再 `GET /me/onlineMeetings?$filter=JoinWebUrl eq '…'`（`OnlineMeetings.Read`，不需管理員同意；參與者能否用這個篩選：**unsure**） | 會議代碼：它的 `meet.google.com` 連結的路徑，或 Calendar API 的 `conferenceData.conferenceId`（CalDAV 的說明沒有寫到它）；再 `conferenceRecords?filter=space.meeting_code="…"` | 會議 ID，再 `GET /past_meetings/{id}/instances` 取得它的 UUID |
| 逐字稿 | `…/transcripts/{id}/content`，VTT，有說話者；`OnlineMeetingTranscript.Read.All`，**需管理員同意**；給主辦人與邀請名單上的人，會議過期後就不行；委派權限的 app 要逐場查詢。租用戶可以關掉 Graph 讀取逐字稿（403 `GraphAccessToTranscriptsDisabled`），或關掉 VTT 的說話者（403 `SpeakerAttributionNotAllowed`；這時改用沒有說話者的文字格式） | `conferenceRecords.transcripts.entries`（`meetings.space.readonly`），或它存下的 Google 文件（Drive）；`list` 只列使用者主辦的會議，參與者則可以 `get` 一筆紀錄與它的產出；紀錄 30 天後刪除 | `GET /meetings/{uuid}/transcript`（AI Companion）或錄影的 VTT（Pro 以上）；只有主持人（**reported**）；有參加的會議用 My Notes API（2026-08）（**unsure**） |
| 平台自己的筆記 | Copilot 的 `aiInsights`（筆記、待辦事項）：要 Copilot 授權與管理員同意，最多晚 4 小時 | Gemini 的 `smartNotes`（2026-04 正式推出），也會存成附在事件上的 Google 文件 | AI Companion 的 `meeting_summary`：付費帳號、自己主持的會議 |
| 個人帳號 | 都沒有（「Not supported」） | gmail.com 沒有；Workspace Individual 與 AI Pro 或 Ultra 的主持人能否透過 API：**unsure** | Basic：沒有錄影、沒有摘要 |
| 用什麼登入 | Microsoft 帳號 | Google 帳號 | 新的服務：使用者自己的 General app、PKCE、`127.0.0.1` 重新導向，比對時忽略連接埠；`localhost` 會被拒絕，開發模式下會變動的連接埠也被拒絕過（**reported**） |
| 晚多久 | 5–30 分鐘，有時幾小時（**reported**） | 45 分鐘以上；`FILE_GENERATED` 之後條目還可能增加（**reported**） | 一小時內，最多好幾天（**reported**） |
| 推送 | 只送到公開的 `notificationUrl` | Workspace Events 經過 Pub/Sub，可用使用者的權杖拉取訂閱 | 只有 webhook |

以使用者身分在會議聊天發文：Teams 可以（`chatInfo.threadId`、`POST /chats/{id}/messages`、`ChatMessage.Send`，不需管理員同意；參與者能否：**unsure**）；Meet 沒有 API；Zoom 可透過 Team Chat API 發到它的持續聊天頻道（**unsure**，沒有人回報完整做過）。以上除非另有標記，都是 **docs**。

來源：[onlineMeeting](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get)、[逐字稿](https://learn.microsoft.com/en-us/graph/api/calltranscript-get)、[Graph 的權限](https://learn.microsoft.com/en-us/graph/permissions-reference)、[AI insights](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/meeting-insights)、[聊天訊息](https://learn.microsoft.com/en-us/graph/api/chat-post-messages)、[Calendar 事件](https://developers.google.com/workspace/calendar/api/v3/reference/events)、[Meet 的 REST API](https://developers.google.com/workspace/meet/api/reference/rest/v2)、[它的 scope](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)、[它的會議](https://developers.google.com/workspace/meet/api/guides/conferences)、[它的產出](https://developers.google.com/workspace/meet/api/guides/artifacts)、[Meet 的逐字稿](https://support.google.com/meet/answer/12849897)、[Meet 的事件](https://developers.google.com/workspace/events/guides/events-meet)、[Zoom 的 loopback 重新導向](https://developers.zoom.us/changelog/platform/pkce-loopback/)、[被拒絕的變動連接埠](https://devforum.zoom.us/t/public-client-pkce-oauth-invalid-redirect-url-with-dynamic-loopback-port/147625)、[Zoom 的 My Notes](https://developers.zoom.us/changelog/my-notes/august-03-2026/)、[它的逐字稿](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065911)。

### C、D 與 E：bot 與即時 API

2026 年對 bot 的規則：

- Zoom：從 2026-03-02 起，要加入帳號外會議的 app 必須以 OBF 權杖取得授權（**docs**，Zoom 的開發者部落格），它的 bot「can only join … once their verified associated owner is in a meeting … and must leave … when their owner leaves」（**docs**）；加入別人的會議需要經 Zoom 審查過的 app（**docs**）；大約從 2026 年 7 月起拒絕匿名參與者（**reported**，Zoom 的論壇）。在 Zoom 上，bot 已經不能替不在場的使用者出席。
- Teams：它偵測到的 bot 不論大廳怎麼設定都要在大廳等候（`ExternalBotAccessMode`，預設 `RequireApprovalWhenDetected`）（**docs**）。
- Meet：「safeguarded guest admit flow」把有風險的訪客放進預設拒絕的第二個佇列（**docs**）。
- 服務：Recall.ai 每小時 0.50 美元，轉寫另加 0.15 美元；即時逐字稿需要「a publicly exposed endpoint」，新帳號在設定保存期限之前會一直保留錄音（**docs**）。Attendee（Elastic License 2.0；Docker 加 Postgres 與 Redis，amd64）、Vexa（Apache-2.0）、joinly（MIT：帶 Whisper 與 MCP 工具的 Chromium bot）（**docs**）。它們的 bot 都用自己操作的瀏覽器加入 Meet 與 Teams。
- 即時 API：Zoom 的 RTMS 只在 webhook 裡給出串流的位址，還要付費的 Developer Pack；Teams 的媒體 bot 以 C# 跑在 Azure 的 Windows Server 上，每台都要公開 IP；Google 在 2027-01-15 終止 Meet Media API 與它的端點（**docs**）。

來源：[Zoom 改用 OBF](https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/)、[Zoom 的 OBF](https://developers.zoom.us/docs/meeting-sdk/auth/obf/)、[匿名加入](https://devforum.zoom.us/t/anonymous-join-exception/144677)、[Teams 的外部 bot](https://learn.microsoft.com/en-us/microsoftteams/manage-external-bots)、[Meet 的放行流程](https://workspaceupdates.googleblog.com/2026/02/safeguarded-guest-admit-flow-in-google-meet.html)、[Recall.ai 的價格](https://www.recall.ai/pricing)、[它的即時端點](https://docs.recall.ai/docs/real-time-websocket-endpoints)、[Attendee](https://attendee.dev/pricing)、[Vexa](https://vexa.ai/pricing)、[joinly](https://github.com/joinly-ai/joinly)、[RTMS](https://developers.zoom.us/docs/rtms/troubleshooting/)、[Teams 的媒體 bot](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots)、[Meet 的版本說明](https://developers.google.com/workspace/meet/release-notes)。

## 設計

先做途徑 A，因為它適用每個平台、每種帳號，不需要管理員，不加入任何人的通話，也不把聲音送出去；再用 B 補上 A 沒聽到的。依這個順序，每項各是一個 pull request。

1. **在這台電腦上做會議筆記。** 輸入框裡語音輸入旁邊的**做筆記**按鈕會在對話裡開始一場會議：一個 `meeting` 訊息部分，它的卡片顯示逐漸增長的逐字稿、時間，以及暫停、停止與捨棄。一台伺服器同時只錄一場會議，因為它的串流共用語音輸入唯一的引擎。
   - 擷取什麼：麥克風（「我」）與會議的聲音（「對方」），作為兩條串流，只在使用者點擊之後。在 macOS 與 Windows 的桌面 app 上用 Electron 的 loopback（`setDisplayMediaRequestHandler` 回答 `audio: 'loopback'`，只給伺服器自己的頁面，影片軌立刻丟掉；這個判斷做成純函式，放在 `desktop/src/lifecycle.ts` 的 `permissionAllowed()` 旁邊）。在 Linux 上由伺服器讀預設輸出裝置的 monitor（`parec` 或 `pw-record`，經過 `process.ts`），並用頁面的切段邏輯自己切那條串流；只能由桌面 app 自己的視窗，透過 app 與伺服器之間的通道（`parentPort`，`src/server/parent.ts`）啟動，絕不由 HTTP 請求啟動，因為登入同一台伺服器的手機或其他瀏覽器也能送那種請求。這條通道現在還沒有：視窗沒有 preload，也沒有 IPC（`desktop/src/main.ts`），`parent.ts` 也只傳 app 自己的訊息，所以需要一個只開放一個呼叫的 preload、一個在主行程裡確認發送者是 app 自己、位於伺服器位址上的視窗的處理器，以及一則指名那場會議、送給伺服器的新訊息；或者改從頁面腳本碰不到的系統匣選單啟動。錄音時系統匣會顯示。在瀏覽器裡用 Chrome 與 Edge 分享的分頁：使用者挑選會議的分頁。其他情況（Firefox、Safari、透過[遠端存取](../remote-access.zh-TW.md)的手機）只錄麥克風，適合面對面的會議，卡片會說明這點。
   - 轉寫：頁面在停頓處切開每條串流（在 AudioWorklet 裡看音量，每段最長 30 秒），把片段送到伺服器（`POST /api/conversations/:id/meetings/:meetingId/audio`，和每個寫入一樣是 JSON：以 base64 放入、大小與語音輸入相當的 16 kHz 單聲道 WAV、它的串流與開始時間），每條串流一次一段；伺服器用語音輸入的引擎與模型（`VoiceService`）轉寫每一段，把文字連同串流、開始與結束時間存下來，並透過 SSE 推送。聲音轉寫完就刪除。轉寫跟不上時，頁面把片段留著直到上限，再丟掉最舊的，逐字稿會標出那段空缺。
   - 持續多久：擷取的頁面每隔幾秒更新一次租約，不管有沒有人說話，讓伺服器分得出安靜的會議與已經不在的頁面；租約過期的會議會暫停，它的卡片提供繼續。會議在兩條串流都靜音幾分鐘後、到了幾小時的時間上限，以及它的對話被刪除時自動停止。這些限制是 `src/shared/types.ts` 裡的常數（片段長度、佇列、租約、靜音、最長的會議），經由 `GET /api/limits` 提供。
   - agent 拿到什麼：進行中，使用者送出的訊息會帶著從團隊上一輪以來的逐字稿，作為 `<meeting_transcript>` 資料區塊（經過 `dataBody()`，所以參與者的話關不掉它；簡報會說：這是其他人的話，絕不是指示）。`meeting_transcript` 工具（`read`）和 `outbox_status` 一樣不論群組都提供，給每個拿到 Harness Relay 工具的成員（Grok、Muse Code 與開源 agent 只在完全存取下，`GATEWAY_FULL_ACCESS_ONLY`），而有會議的對話即使沒有選任何 app 群組也會拿到這些工具（現在只有選了群組才有，`relayGroups`），依時間或字詞給出其中任何一段：這個對話自己的會議，或在自動任務的那一輪裡它的事件指名的那場會議，由伺服器綁定在那一輪上（絕不由 agent 的參數決定），其他的都不行；RLM 模式會分段讀很長的逐字稿。停止之後：團隊或只有首席 agent 跑一輪，以使用者的語言寫出摘要、決定與待辦事項（誰、何時之前），作為一則回覆。之後由現有的工具把它送出去（郵件、Slack、Teams、Google 文件、Obsidian：每一項都經過待送出匣），後續的事變成提議的自動任務（`<schedule>` 區塊），長期記憶開啟時也可以變成筆記。
   - 告知其他人：第一場會議之前，以及每次的卡片上，都有一段簡短的提醒：Harness Relay 不加入任何通話，所以除非使用者告訴他們，其他人不會知道；並附上一段兩種語言的文字，可貼到會議聊天裡（在 Teams 上由第 4 步提出）。
   - 桌面 app：在 `extendInfo` 與兩種語言的 `InfoPlist.strings` 裡寫自己的 `NSAudioCaptureUsageDescription`，取代 Electron 的通用文字；`permissionAllowed()` 允許伺服器自己的頁面使用 `display-capture`。一開始就是 `ended` 的音訊軌代表權限被拒絕：卡片會說明到系統設定的哪裡去允許。因為權限之後也可能失去，若一場會議的「對方」一直靜音、「我」卻聽到說話聲，卡片也會給同樣的提示。
2. **行事曆裡的會議。** `CalendarEvent` 加上會議的連結與平台：取自 Graph 的 `onlineMeeting.joinUrl` 與 `onlineMeetingProvider`，同時要事件的內文（不只 `bodyPreview`）；取自 iCalendar 的 `CONFERENCE` 或 Google 的 `X-GOOGLE-CONFERENCE`（**unsure**：Google 的 CalDAV 是否會送）；否則取地點或說明裡第一個 Zoom、Meet 或 Teams 連結。行事曆工具與行事曆觸發的 `<event>` 都列出它。會議即將開始的通知帶著**做筆記**，打開的對話以事件的標題、參與者與說明作為會議的背景；它絕不自己啟動麥克風。另外，自動任務多一個來源：會議結束（它的事件結束，或第 1 步的停止），它的 `<event source="meeting">` 指名那場會議，那一輪的 `meeting_transcript` 可以讀它：「把待辦事項送到 #team」對一系列會議只要設定一次。
3. **平台的逐字稿。** 給第 1 步沒聽到的會議（使用者不在場，或用手機參加），以及要平台的說話者名稱時：
   - Teams：Microsoft 帳號的 `meetings` 用途，要 `OnlineMeetings.Read` 與 `OnlineMeetingTranscript.Read.All`（需管理員同意）；用加入連結找到事件的會議，會議結束後查詢它的逐字稿直到出現，間隔越來越長（和自動任務的檢查一樣逐步放慢），讀進同一份逐字稿：有說話者的 VTT，或在租用戶不給說話者時，沒有說話者的文字；租用戶不讓 Graph 讀逐字稿時，會照實告知。
   - Meet：Google 帳號的 `meet` 用途，要 `meetings.space.readonly`；會議代碼取自第 2 步找到的 Meet 連結，否則取自 Calendar API 的 `conferenceData`（這時 Google 服務需要加上它的主機：`googleProvider()` 的 `hosts` 只有 CalDAV 與使用者資訊的主機）；使用者主辦的會議的紀錄、條目與智慧筆記；使用者只是參加的會議，則透過 Drive 讀附在事件上的 Google 文件。
   - 兩者都經過 broker（`src/server/oauth/broker.ts`），不把權杖給 CLI；一個 `meeting_import` 工具（`read`），以及第 2 步的會議結束來源等待逐字稿出現。
4. **Teams 的會議聊天。** 把會議聊天的 thread 當作 `teams_send_message` 的目的地：傳統的加入連結裡就帶著它（`/l/meetup-join/19:meeting_…@thread.v2/0`），這時 `destinationFromLink()` 就接受它，並把它的租用戶（連結 `context` 裡的 `Tid`）與發文工作階段的比對；較新的 `/meet/…` 連結沒有，就透過 Graph 的 `chatInfo.threadId`。一段文字、一個回答，或會後的摘要，在使用者於待送出匣確認後送到會議聊天。逐字稿裡（第 1 或 3 步）提到使用者或問團隊的句子會被標出來，卡片上每句都有**問團隊**：由使用者啟動那一輪，其他人的話絕不會啟動任何一輪；沒有任何東西會自己送出。Meet 與 Zoom 沒有這樣的 API：卡片提供可複製的文字。
5. **Zoom。** 為使用者自己的 Zoom General app 加一個服務（PKCE；重新導向是 `http://127.0.0.1:<port>/oauth/callback`，絕不用 `localhost`：`src/server/oauth/signin.ts` 的 `redirectAddress()` 會給 localhost 上的頁面它自己的位址，所以 Zoom 的要強制用 127.0.0.1，就像 Microsoft 的避開 IPv6 loopback 那樣），一個用途讀使用者主持的會議的逐字稿與摘要，並在登入後的檢查確認 My Notes API 涵蓋使用者參加的會議之後，用它讀那些會議。

不在計畫內：加入通話的 bot（C、D）與即時 API（E）；見[考慮過的其他做法](#考慮過的其他做法)。

資料庫結構加上 `meetings`（對話的會議：從哪裡來、它的事件、時間與狀態）與 `meeting_segments`（它的串流或說話者、開始、結束與文字），隨對話一起刪除。

## 安全

- 聲音留在使用者自己的電腦上：whisper.cpp 在伺服器所在的電腦上轉寫它，和語音輸入一樣，沒有任何東西把它送到別處。透過遠端存取時，擷取它的頁面可能在另一台電腦上，片段會像語音輸入的一樣經過網路送到伺服器。片段經過 `/api/` 送來，經過它的中介層（登入、Host 與 Origin 檢查、只收 JSON），每段都檢查是大小合限的 WAV，轉寫完就刪除。
- 逐字稿的文字不會只留在這裡：它在成員的每一輪裡送到它們的模型服務，和任何訊息一樣。對不能外流的會議，用使用者自己的模型端點組成的團隊，就能讓它留在使用者自己管理的機器上；卡片會說明它的團隊成員用了哪些服務。
- 其他人說的話是資料，絕不是指示：`<meeting_transcript>` 區塊與工具的結果，都有長度限制，和郵件與網頁一樣。每則經由 Harness Relay 自己的工具給其他人的訊息、每次經由它們寫入文件，都在待送出匣等使用者，在每種權限下都一樣，包括完全存取（`send`），和現在相同。但團隊能做的不只這些：在完全存取下，CLI 自己的 shell 與網路、瀏覽器工具的點擊與輸入（`act`）、工具庫的 MCP 伺服器，以及 Claude 與 Codex 自己的 connector，都不經詢問就執行。所以在完全存取下，參與者的話會到達一個不經詢問就行動的團隊；會議的對話是完全存取時，卡片會提出警告。
- 麥克風與會議的聲音只在使用者點擊之後才開始，絕不因為自動任務或回覆而開始；卡片會顯示它們正在錄，在由伺服器錄音的 Linux 上，被錄音的那台電腦的系統匣也會顯示。
- 第 3 與 5 步的權杖留在伺服器的 broker 裡，和行事曆的一樣，只送到它們服務的主機；第 4 步透過現有的 Teams 發文工作階段發文，它的登入留在那個 PowerShell 行程裡。
- 告知其他人仍是使用者的事：Harness Relay 會說明這點並提供文字，絕不說已經告知了。
- 逐字稿裡有其他人的話：它隨對話存在資料庫裡，隨對話或按下捨棄時刪除，分享對話時除非使用者選擇納入，否則不包括它。已經產生的副本仍會留著：在 CLI 自己的工作階段檔案、AgentsView 的 thread、由它產生的長期記憶筆記裡；捨棄時會說明這點。

## 考慮過的其他做法

- **bot 服務的參與者（C）。** 它能在使用者不在時出席，並在任何會議的聊天發文。但通話裡所有人的聲音都送到第三方，除非另外設定否則會保留，每小時 0.30–0.50 美元，加上轉寫還更多；即時逐字稿需要公開端點；而 2026 年的規則讓它在 Teams 的大廳與 Meet 的第二個佇列裡等候，在 Zoom 上只能在主人在場時留下，比起第 1 步剩下的好處不多。之後若使用者要求處理他們不出席的會議，可以做成 connector，金鑰放在憑證儲存區，在會後讀取。
- **讓瀏覽器工具加入（D）。** 它們的 Chromium 是 headless 的，聲音是靜音：一個要主持人放行的訪客（在 Meet 會進入預設拒絕的佇列），WebRTC 限制在 proxy 上、沒有 UDP，也沒有聲音可讀。給它麥克風、喇叭與 UDP，會拆掉讓它的頁面碰不到網路與這台電腦的防護。joinly 顯示這樣的 bot 能在它自己的容器裡運作，但不是在 Harness Relay 的瀏覽器裡。
- **即時 API（E）。** 沒有一個能連到 127.0.0.1 上的伺服器，Meet 的還會在 2027 年 1 月終止。
- **原生的擷取輔助程式**（用 Core Audio tap 的 Swift 程式，像 audiotee；Windows 的 process loopback 與 PipeWire 用 Rust，像 application-loopback）。只擷取會議 app 的聲音，不需要影片軌，所以也許不會問螢幕錄製權限。但每個系統都要建置並簽章一個執行檔：留到第 1 步發現 Electron 的做法會問螢幕錄製權限時再做。
- **Recall.ai 的桌面 SDK。** 不用 bot 就在電腦上擷取，但會上傳到 Recall 的雲端，沒有 Linux 版，價格和它的 bot 一樣。
- **Apple 的 `SpeechTranscriber`。** 在裝置上執行、有 zh-TW，但要 macOS 26+、只能從 Swift 用、一次一種語言；whisper.cpp 已經在每個系統上都有了。
- **在雲端轉寫**（像 Granola 用的 Deepgram，或模型連線的）。在規格低的電腦上比較快，但會把所有人的聲音送出去，而 Harness Relay 的語音輸入從不這樣做。
- **像 Grok 的 bot 那樣自己在會議聊天裡回答。** 那樣參與者的話會決定團隊以使用者的身分對其他人發什麼；待送出匣讓這個決定留在使用者手上。

## 待決問題

- 要不要保留聲音，以便會後用更大的模型重新轉寫得更好？預設關閉；保留多久？
- Electron 45 在 macOS 上的 loopback 除了系統錄音之外，是否也會問螢幕錄製權限、macOS 多久會再問一次，以及 ad hoc 簽章的 app 是否每次更新都會失去權限：**unsure**，沒有試過。若是如此，就用原生輔助程式，或 Developer ID 簽章。
- 錄音中把桌面 app 的視窗關到系統匣：讓它的頁面繼續執行（視窗隱藏、計時器不被節流），還是暫停會議？
- 既然會議的每一輪裡有其他人的話，不論對話的權限，是否都讓它們在完全存取以下執行？
- 不戴耳機時的回音：「我」也會聽到其他人。要丟掉「我」裡與同一時間「對方」相同字詞的片段，還是請使用者戴耳機？
- 在第 1 步分辨對方的不同人（像 OpenWhispr 那樣對「對方」串流做 sherpa-onnx 的說話者分離），還是只用平台逐字稿（第 3 步）的名稱？
- 要不要把 Breeze-ASR-25 當作台灣華語夾雜英語的語音模型：用哪個轉換版，並像其他模型一樣固定版本並檢查？`--vad` 用的 Silero 模型也一樣固定；在引擎來自 Homebrew 的 macOS 上，它的建置是否有 VAD。
- 摘要由誰跑：團隊，還是只有首席 agent（比較省）？固定的大綱，還是使用者自己的範本？
- Teams 的管理員同意：透過使用者自己的 Entra app（OAuth 帳號），還是像 Teams 讀取已經可以的那樣，透過 Microsoft Graph PowerShell 的工作階段？
- `drive_read_document` 能否直接讀 Meet 的逐字稿與筆記文件，以及 Google 的 CalDAV 是否會給出會議連結：**unsure**，沒有試過。
- 參與者（不是主辦人）能否用加入連結找到 Teams 會議，並在它的聊天裡發文：**unsure**。
- `OnlineMeetingTranscript.Read.All` 是否在每個租用戶都需要管理員同意（如它的頁面所說），還是租用戶的同意政策能讓使用者自己同意：要對照 Graph 的權限參考確認。

## 測試

- 會議的路由與儲存，放在新的 `test/meetings.test.ts`：JSON 與 WAV 檢查、佇列的上限、每條串流維持順序、文字連同時間存下並透過 SSE 推送、租約與各種停止；引擎用替身，像 `test/voice.test.ts` 模擬 `whisper-server` 那樣。
- 頁面在停頓處切段的邏輯做成純模組（輸入音量、輸出切點），不需要 DOM 就能測。
- 提示：從上一輪以來、在長度限制內且經過 `dataBody()` 的 `<meeting_transcript>`；工具的範圍，以及它拒絕其他對話的會議；摘要那一輪的提示。
- 從 Graph 的欄位取出會議連結（`test/oauth.test.ts`，`graphEvent()` 在那裡測），從 `CONFERENCE`、`X-GOOGLE-CONFERENCE` 與文字取出（`test/connectors.test.ts`）；會議結束的來源（`test/watch-sources.test.ts`、`test/orchestrator-watch.test.ts`）。
- 第 3 到 5 步對 `test/fake-oauth-server.ts` 裡的替身：Graph 的線上會議與逐字稿（沒有管理員同意時的 403、`GraphAccessToTranscriptsDisabled`、`SpeakerAttributionNotAllowed` 與文字格式）、Meet 的會議紀錄（30 天後消失）、Zoom 的；傳統的 Teams 加入連結作為 `teams_send_message` 的目的地（`test/teams-graph.test.ts`）。
- `permissionAllowed()` 與擷取畫面媒體的判斷對 `display-capture` 的處理（`test/desktop-app.test.ts`）。
- 一個端對端測試，頁面的媒體像 `e2e/support/voice.ts` 替換 `getUserMedia` 那樣替換掉（`getDisplayMedia` 也是），會議路由後面接替身引擎，再加上會回答一段摘要的假 CLI；列在 `e2e/README.md` 與 `e2e/README.zh-TW.md`，它們的「沒有測到的部分」加上 Electron 的 loopback 與 Linux 的 monitor。
