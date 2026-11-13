import { AsyncLocalStorage } from 'node:async_hooks';
import type { Permission } from '../shared/types';
import { LANGS, type Lang } from '../shared/types';

/*
 * Language of user-facing server text (errors, system notes, adapter messages).
 *
 * The web app sends `X-Relay-Lang` with every request; a middleware runs the request inside
 * `withLang`, and AsyncLocalStorage carries the language into everything the request starts —
 * including a team run that keeps going after the HTTP response was sent.
 */
const als = new AsyncLocalStorage<Lang>();

export function withLang<T>(lang: Lang, fn: () => T): T {
  return als.run(lang, fn);
}

/** Language of the current request or run (zh-TW when none was given). */
export function currentLang(): Lang {
  return als.getStore() ?? 'zh-TW';
}

/** Reads `X-Relay-Lang`, falling back to the first tag of Accept-Language. */
export function parseLang(explicit?: string, acceptLanguage?: string): Lang {
  if (explicit && (LANGS as string[]).includes(explicit)) return explicit as Lang;
  const first = acceptLanguage?.split(',')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('en')) return 'en';
  return 'zh-TW';
}

const zhTW = {
  // Runs and adapters
  stopped: '已停止',
  timedOut: '執行逾時',
  exitedWithoutReply: (cli: string, code: number | null) => `${cli} 結束（exit ${code}）但沒有回應`,
  exitedWithoutTurn: (cli: string, code: number | null) => `${cli} 結束（exit ${code}）但沒有完成回合`,
  codexMcpListFailed: (detail: string) =>
    `Codex 無法列出它的 MCP 伺服器，因此無法在這次執行中不載入它們或它們的工具（${detail}）。請更新 Codex，或在「設定」裡 Codex 的「這個 CLI 自己載入的…」中，取消「MCP 工具」分頁的不載入勾選。`,
  codexLeftOutUnchecked: (detail: string) =>
    `無法確認 Codex 在這次執行中沒有載入設為不載入的 skill、hook 或 plugin（${detail}），所以沒有執行。請再試一次，或在「設定」裡 Codex 的「這個 CLI 自己載入的…」中取消這些不載入勾選。`,
  codexNoProfile: (active: string | undefined) =>
    `Codex 沒有在 Harness Relay 給它的權限設定檔中執行這個 thread（它回報的是${active ? `「${active}」` : '沒有設定檔'}，可能是不認得這個欄位的舊版 Codex），它的沙箱就擋不住你瀏覽器的資料夾與 Harness Relay 的資料庫，所以沒有執行。請更新 Codex（0.167 可以）再試一次。`,
  codexStillLoaded: (parts: ('skills' | 'hooks' | 'plugins')[]) =>
    `Codex 仍載入了設為不載入的${parts.map((p) => ` ${p === 'skills' ? 'skill' : p === 'hooks' ? 'hook' : 'plugin'}`).join(' 與')}（可能是不認得這項設定的舊版 Codex）。請更新 Codex，或在「設定」裡 Codex 的「這個 CLI 自己載入的…」中，取消${parts.map((p) => `「${p === 'skills' ? 'Skills' : p === 'hooks' ? 'Hooks' : 'Plugins'}」`).join('與')}分頁的不載入勾選。`,
  claudePluginsFailed: (detail: string) =>
    `Claude Code 無法列出它的 plugin，因此無法在這次執行中不載入它們（${detail}）。請更新 Claude Code，或在「設定」裡 Claude Code 的「這個 CLI 自己載入的…」中，取消「Plugins」分頁的「全部不載入」。`,
  claudeAgentsFailed: (detail: string) =>
    `無法讓 Claude Code 在這次執行中不載入它自己的 subagent（${detail}）。請更新 Claude Code，或在「設定」裡 Claude Code 的「這個 CLI 自己載入的…」中，取消「Subagents」分頁的「全部不載入」。`,
  claudeError: 'Claude Code 回報錯誤',
  claudeSandbox: (why: string) =>
    `Claude Code 無法啟動它的沙箱（完全存取以外的權限都需要）：${why}。在 Linux 與 WSL2 上請安裝 bubblewrap 與 socat（例如 sudo apt-get install bubblewrap socat），Ubuntu 23.10 以後還需要給 /usr/bin/bwrap 的 AppArmor 設定檔（見 docs/sandboxing.zh-TW.md 的「在 Linux 上」），再試一次；或把權限改成「完全存取」，在沙箱外執行。`,
  sandboxHost: '沙箱中的指令想連到這個主機。',
  commandNotFound: (bin: string) => `找不到指令「${bin}」。請確認已安裝，或在「設定」頁指定執行檔路徑。`,
  windowsShimBroken: (bin: string, script: string, target: string) => `「${bin}」是 ${script}，它執行的 ${target} 不在了：請重新安裝 ${bin}。`,
  windowsNoNode: (bin: string, script: string) => `「${bin}」是 ${script}，它要用 Node.js 執行，但 PATH 上找不到 Node.js：請安裝 Node.js，或把它加到 PATH。`,
  windowsScript: (bin: string, script: string) =>
    `「${bin}」是腳本 ${script}，Harness Relay 無法啟動它：它只啟動程式，從不透過 shell，而且讀不出這個腳本執行的是哪個程式。請在「設定」頁把執行檔路徑改成它執行的程式（.exe）。`,
  permission: { 'read-only': '唯讀', edit: '可編輯', full: '完全存取' } as Record<Permission, string>,
  grokRefusedReadOnly: '唯讀模式不允許，已告知 Grok 改用唯讀工具',
  grokRefusedPublish: '可編輯模式不允許推送或發佈',
  grokCancelledNoReason: 'Grok 自行中止了這一輪（stopReason: cancelled），沒有給出原因。',
  grokCancelled: (tool: string, reason: string | undefined) => `Grok 在執行工具「${tool}」時中止了這一輪${reason ? `（${reason}）` : ''}。`,
  grokCancelHint: (permission: string) => `目前的權限是「${permission}」；若這個操作是必要的，可以把權限改成「完全存取」再試。`,
  grokSandbox: (why: string) => `Grok 無法啟動沙箱（完全存取以外的權限都需要）：${why}。在 Linux 上，它禁止讀取的路徑需要 bubblewrap（例如 sudo apt-get install bubblewrap），Ubuntu 23.10 以後還需要給 /usr/bin/bwrap 的 AppArmor 設定檔（見 docs/sandboxing.zh-TW.md 的「在 Linux 上」）。`,
  grokNoSession: 'grok 沒有回傳 session id',
  grokModelsFailed: (path: string, why: string) => `無法把你自己的端點的模型寫進 Grok 的設定（${path}）：${why}`,
  // Harness Relay's own sandbox (relaySandbox.ts), for the CLIs that have none of their own
  relaySandboxWindows:
    'Harness Relay 自己的沙箱無法在原生 Windows 上使用（它用的 sandbox-runtime 在 Windows 上還是 alpha 版），所以這個 agent 在「唯讀」與「可編輯」下不會在這裡執行。請在 WSL2 裡執行 Harness Relay，或把權限改成「完全存取」（不使用沙箱）。',
  relaySandboxPathTooLong: (dataDir: string, max: number) =>
    `Harness Relay 的資料資料夾路徑（${dataDir}）太長，沙箱放不下它要建立的 socket，所以沒有執行：請把 RELAY_DATA_DIR 設成路徑不超過 ${max} 個位元組的資料夾（UTF-8：中文字每個佔 3 個），再重新啟動 Harness Relay；或改用完全存取。`,
  relaySandboxNoNode: 'Harness Relay 的沙箱需要 Node.js 22.12 或更新版本才能執行它的沙箱程式，而桌面 app 自己的執行環境不能當成 Node 使用：請安裝 Node.js，讓它出現在登入 shell 的 PATH 上，再重新開啟 app；或改用完全存取。',
  relaySandboxPlatform: (platform: string) =>
    `Harness Relay 自己的沙箱只能在 macOS 與 Linux 上使用（這裡是 ${platform}），所以這個 agent 在「唯讀」與「可編輯」下不會執行。請把權限改成「完全存取」，或在 macOS 或 Linux 上執行。`,
  relaySandboxMissing: (what: string, packages: string) =>
    `Harness Relay 自己的沙箱需要 ${what}，這台電腦上沒有，所以沒有執行（「完全存取」以外的權限都需要它）。請安裝：sudo apt-get install ${packages}（Fedora：sudo dnf install ${packages}），再試一次；或把權限改成「完全存取」。`,
  relaySandboxArch: (arch: string) =>
    `Harness Relay 自己的沙箱在這種處理器（${arch}）上擋不住 Unix socket（它的 seccomp 過濾器只有 x64 與 arm64 版），沙箱裡的程式就可能透過 Docker 等服務的 socket 跑到沙箱外，所以沒有執行。請把權限改成「完全存取」，或在 x64 或 arm64 的電腦上執行。`,
  relaySandboxFailed: (detail: string, platform: string) =>
    `Harness Relay 自己的沙箱無法啟動（「完全存取」以外的權限都需要它），所以沒有執行：${detail}。` +
    (platform === 'darwin'
      ? 'sandbox-exec 是 macOS 內建的；Harness Relay 本身若在另一個沙箱裡執行（例如由沙箱中的指令啟動），就無法再開沙箱：請從一般的終端機啟動 Harness Relay。'
      : platform === 'linux'
        ? 'bubblewrap 需要非特權的 user namespace：Ubuntu 23.10 以後請加上 /usr/bin/bwrap 的 AppArmor 設定檔（見 docs/sandboxing.zh-TW.md 的「在 Linux 上」）；在容器裡，容器要允許 user namespace 並能掛載新的 /proc（例如 docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined），或改用「完全存取」，讓容器當沙箱；WSL1 不支援，請用 WSL2。'
        : '') +
    '或把權限改成「完全存取」。',
  relaySandboxBadHost: (entry: string) => `「${entry}」不是沙箱可以連線的主機（只能是主機名稱或 IP 位址，可加上 :port），所以沒有執行。`,
  relaySandboxLocalPort: (entry: string) =>
    `模型來源「${entry}」在這台電腦上，卻沒有寫連接埠；沙箱只讓程式連到這台電腦上指定的連接埠，所以沒有執行。請在位址裡加上模型伺服器的連接埠（例如 localhost:11434）。`,
  relaySandboxRelayPort: (entry: string) =>
    `模型來源「${entry}」是 Harness Relay 自己的連接埠，沙箱裡的程式不能連到那裡，所以沒有執行。請改用模型伺服器自己的位址。`,
  relaySandboxRelative: (path: string) => `沙箱的路徑必須是絕對路徑，「${path}」不是，所以沒有執行。`,
  relaySandboxWritable: (path: string, folder: string) =>
    `這次執行可以寫入的「${path}」包含或位於「${folder}」，那裡的檔案決定 Harness Relay 或 agent 怎麼執行，agent 就能繞過沙箱，所以沒有執行。`,
  relaySandboxProgram: (path: string) =>
    `沙箱要用的程式「${path}」在這次執行可以寫入的資料夾裡，可能被 agent 換掉後在沙箱外執行，所以沒有執行。`,
  relaySandboxNoChannel:
    'Harness Relay 自己的沙箱沒有拿到它的控制通道（這是 Harness Relay 的錯誤：啟動它時沒有傳入 channel），所以沒有執行。',
  relaySandboxHost: '沙箱中的程式想連到這個主機。允許後，這次執行就能連到它（之後的執行也會，若你選了一律允許）。',
  grokRejectedModel: (value: string, err: string) => `Grok 不接受模型「${value}」：${err}`,
  grokRejectedEffort: (value: string, err: string) => `Grok 不接受推理強度「${value}」：${err}`,
  cursorRefused: '超出這個對話的權限，已拒絕',
  cursorReadOnlyWrite: '唯讀模式不允許寫入，Cursor 沒有寫入這個檔案',
  cursorProtectedWrite: 'Cursor 對這類檔案會先詢問：改動這裡可能讓程式碼之後在沙箱外執行（例如 git hook、編輯器的工作設定），或改變 agent 的設定。',
  cursorOutsideWrite: '這個檔案在工作目錄外：Cursor 寫入工作目錄外的檔案前會先詢問。',
  cursorOtherCwdWrite: '這個檔案在這個對話的另一個工作目錄裡：Cursor 只在第一個工作目錄裡工作，寫入其他工作目錄前會先詢問。',
  cursorCancelled: 'Cursor 自行中止了這一輪（stopReason: cancelled），沒有給出原因。',
  cursorNoSession: 'cursor-agent 沒有回傳 session id',
  cursorRejectedModel: (value: string, err: string) => `Cursor 不接受模型「${value}」：${err}`,
  cursorRejectedEffort: (value: string, err: string) => `Cursor 不接受推理強度「${value}」：${err}`,
  cursorRejectedMode: (err: string) => `Cursor 無法切換到 Agent 模式：${err}`,
  cursorExitCode: (code: number) => `結束代碼 ${code}`,
  cursorService: (error: string) => `Cursor 的服務回報錯誤：${error}`,
  cursorSignIn: (err: string) => `Cursor 尚未登入（${err}）。請到「設定」的 Cursor 登入，或設定 API key。`,
  cursorConfigFailed: (err: string) => `無法替這一輪準備 Cursor 的設定資料夾：${err}`,
  cursorAccountLogin:
    'Cursor 在每個電腦使用者只保留一個登入（macOS 上存在鑰匙圈裡），所以額外的 Cursor 帳號不能用瀏覽器登入：請替它設定 API key。預設帳號才用 Cursor 自己的登入。',
  antigravityRefused: '超出這個對話的權限，已拒絕',
  antigravityProtected: '這是受保護的路徑（瀏覽器資料、Harness Relay 的資料庫等），低於完整權限時不能讀寫，已拒絕',
  antigravityEndsTurn: '（Antigravity 在拒絕後會結束這一輪）',
  antigravityProjectSetup:
    '這個專案有 Antigravity 會自己啟動或執行的設定（.agents 等資料夾裡的 MCP 伺服器、hook 或 plugin）：agy 一開啟 session 就會在沙箱外執行它們，不經詢問，唯讀模式下也一樣。另一個 agent 或這個 repository 的作者都可能放進這些檔案。允許後這一輪才會開始；檔案內容改變後會再問一次。',
  antigravityProjectSetupRefused: (files: string) =>
    `這一輪沒有開始：這個專案有 Antigravity 會在沙箱外自己執行的設定（${files}），而它沒有被允許。檢查並移除這些檔案，或允許它們，或改用完全存取。`,
  antigravityOutsideWrite: '這個檔案不在這個對話的工作目錄裡：編輯權限只涵蓋工作目錄內的寫入。',
  antigravityConfigWrite:
    '這裡是 agent 的設定（例如 .agents/、.git/hooks、.vscode/）：寫在這裡可能讓程式碼之後在沒有沙箱的情況下執行，或改變 agent 的行為，所以先詢問。',
  antigravityExitCode: (code: number) => `結束代碼 ${code}`,
  antigravityCancelled: 'Antigravity 自行中止了這一輪（stopReason: cancelled），沒有給出原因。',
  antigravityNoSession: 'agy 沒有回傳 session id',
  antigravityRejectedModel: (value: string, err: string) => `Antigravity 不接受模型「${value}」：${err}`,
  antigravityRejectedEffort: (value: string, err: string) => `Antigravity 不接受思考強度「${value}」：${err}`,
  antigravityRejectedMode: (err: string) => `Antigravity 無法切換回預設模式：${err}`,
  antigravitySignIn: (err: string) => `Antigravity 尚未登入（${err}）。請到「設定」的 Antigravity 登入，或設定 Gemini API key。`,
  antigravityConfigFailed: (err: string) => `無法替這一輪準備 Antigravity 的設定：${err}`,
  antigravityAccountLogin:
    'Antigravity 把 Google 登入存在系統的 keyring 裡，Harness Relay 無法確定另一個帳號的登入不會取代預設帳號的，所以額外的 Antigravity 帳號只能用 Gemini API key。預設帳號才用 Google 登入。',
  copilotRefused: '超出這個對話的權限，已拒絕',
  copilotProtected: '這是受保護的路徑（瀏覽器資料、Harness Relay 的資料庫等），低於完整權限時不能讀寫，已拒絕',
  copilotEndsTurn: '（Copilot 在拒絕後會結束這一輪）',
  copilotProjectHooks:
    '這個專案有 Copilot 會自己執行的 hook（.github/hooks 裡的檔案，或專案 .github/copilot、.claude 設定裡的 hook）：Copilot 一開啟 session 和每次使用工具前都會執行它們，不經詢問，唯讀模式下也一樣（低於完整權限時在 Copilot 的沙箱裡），就算帳號設定裡略過了 hook 也一樣。另一個 agent 或這個 repository 的作者都可能放進這些 hook。允許後這一輪才會開始；檔案改變後會再問一次。',
  copilotProjectHooksRefused: (files: string) =>
    `這一輪沒有開始：這個專案有 Copilot 會自己執行的 hook（${files}），而它們沒有被允許。檢查並移除這些 hook，或允許它們，或改用完全存取。`,
  copilotOutsideWrite: '這個檔案不在這個對話的工作目錄裡：編輯權限只涵蓋工作目錄內的寫入。',
  copilotConfigWrite:
    '這裡是 agent 的設定（例如 .github/hooks、.agents/、.git/hooks、.vscode/）：寫在這裡可能讓程式碼之後在沒有沙箱的情況下執行，或改變 agent 的行為，所以先詢問。',
  copilotExitCode: (code: number) => `結束代碼 ${code}`,
  copilotCancelled: 'Copilot 自行中止了這一輪（stopReason: cancelled），沒有給出原因。',
  copilotNoSession: 'copilot 沒有回傳 session id',
  copilotRejectedMode: (err: string) => `Copilot 無法切換到 agent 模式，或照權限設定 allow-all：${err}`,
  copilotSignIn: (err: string) => `Copilot 尚未登入（${err}）。請到「設定」的 Copilot 登入 GitHub，或設定 GitHub token。`,
  copilotConfigFailed: (err: string) => `無法替這一輪準備 Copilot 的設定：${err}`,
  copilotSandbox: (problem: string) =>
    `這一輪沒有開始：Copilot 的沙箱不是 Harness Relay 設定的樣子（${problem}），所以低於完整權限時它的指令不能執行。請更新 Copilot CLI，確認這台電腦能執行它的沙箱（Linux 需要 bubblewrap 等工具），或改用完全存取。`,

  // Conversations and runs
  defaultTitle: '新對話',
  conversationNotFound: '找不到對話',
  signedOut: '這個瀏覽器尚未登入 Harness Relay。請打開它啟動時在終端機印出的登入連結，或執行 npm run login。',
  signedOutDesktop: '這個瀏覽器尚未登入 Harness Relay。請從桌面 app 的選單選「在瀏覽器打開」（app 自己的視窗則選「打開 Harness Relay」），它會用新的登入連結打開。',
  signInWrongCode: '代碼錯誤或已過期。',
  signInTooMany: '錯誤的代碼太多次了，請等一分鐘再試。',
  signInNoSession: '找不到這個已登入的瀏覽器。',
  cwdHoldsAgents: (dir: string, folder: string) =>
    `工作目錄「${dir}」包含或位於「${folder}」，那裡的檔案決定 agent 怎麼執行（家目錄裡的設定、CLI 自己的資料夾或它的程式）。可編輯模式下，agent 不經詢問就能修改這些檔案，也就能繞過它們的沙箱。請改用專案的資料夾，或唯讀模式。`,
  protectedPattern: (path: string) =>
    `Harness Relay 無法保護「${path}」：它的名稱含有 *、? 或 [，agent 的沙箱會把它當成樣式。請改名或搬到別處，或改用完全存取。`,
  grokSettingsChanged: (names: string) =>
    `這一輪中，Grok 自己資料夾裡的設定或程式被改動了（${names}）。agent 執行的指令可能改了它們；Harness Relay 已把它們改回原樣（改動後的版本另存在旁邊，名稱結尾為 .changed-…），skills 資料夾則請你自己檢查。用完全存取執行 Grok 之前，請先看過這些改動。`,
  // The open agents (OpenCode, Goose, Cline, OpenHands, Pi) and their model backends
  openNotImplemented: (cli: string) => `Harness Relay 還不能執行 ${cli}：它的轉接器尚未完成。請先改用其他 agent。`,
  openNoModel: (cli: string) =>
    `${cli} 沒有指定模型。請在團隊設定為這位成員選一個模型，或在「設定」裡 ${cli} 的「預設模型與推理強度」指定，格式是「模型來源/模型」，例如 openai/gpt-5.4-nano 或 homelab/muse-glimmer-30b-nvfp4。`,
  openBadModel: (cli: string, id: string) =>
    `${cli} 的模型「${id}」不是「模型來源/模型」的格式（例如 anthropic/claude-haiku-5-5、xai/grok-4.3，或你的端點 id 加上模型名稱）。`,
  openBackendMissing: (cli: string, backend: string, id: string) =>
    `${cli} 要用模型「${id}」，但還沒有設定 ${backend} 的 API key。請到「設定 → 模型來源」設定，或改選其他模型。`,
  openEndpointMissing: (cli: string, endpoint: string, id: string) =>
    `${cli} 要用模型「${id}」，但沒有 id 為「${endpoint}」的自訂端點。請到「設定 → 模型來源」新增，或改選其他模型。`,
  endpointDeleted: (cli: string, endpoint: string, id: string) =>
    `${cli} 要用模型「${id}」，但它的自訂端點「${endpoint}」已在「設定 → 模型來源」刪除。這一輪沒有執行，也沒有改送到 ${cli} 自己的服務。請改選其他模型，或重新新增這個端點；如果「${id}」是 ${cli} 自己的模型，到「設定 → 模型來源 → 已刪除的端點」忘掉「${endpoint}」。`,
  openNoHome: 'Harness Relay 沒有給這個 agent 它自己的家目錄。',
  openNoWindowsSandbox: (cli: string) =>
    `在 Windows 上，Harness Relay 的沙箱還不能保護 ${cli}，所以它只能以「完全存取」執行。請改用完全存取（只在你信任的資料夾），或在 WSL 中執行 Harness Relay。`,
  openSandboxUnavailable: (cli: string, reason: string) =>
    `Harness Relay 的沙箱無法為 ${cli} 準備這次執行（完全存取以外的權限都需要它），所以沒有執行：${reason}。請見 docs/sandboxing.zh-TW.md。`,
  openPrepareFailed: (cli: string, e: string) => `無法在 ${cli} 的家目錄寫入這次執行的設定：${e}`,
  openRefusedReadOnly: (cli: string) => `唯讀模式不允許，已告知 ${cli} 只用讀取的工具`,
  openToolNotRun: '沒有執行',
  openStateNotEmptied: (cli: string, e: string) =>
    `權限提高了，${cli} 在這位成員的資料夾必須先清空才能執行，但無法清空（${e}），所以沒有執行。請再試一次。`,
  openStateShared: (cli: string, path: string) =>
    `${cli} 這次執行要寫入「${path}」，但那裡不在這位成員自己的資料夾中，其他對話的執行也會讀到，所以沒有執行。這是 ${cli} 轉接器的錯誤，請回報。`,
  openToolNotFinished: '沒有執行完',
  openCannotResume: (cli: string) => `${cli} 沒有提供接續 session 的方法（session/resume 或 session/load）。`,
  openResumeFailed: (cli: string, e: string) => `${cli} 無法接續先前的 session：${e}`,
  openNoSession: (cli: string) => `${cli} 沒有回傳 session id`,
  openCancelled: (cli: string, tool: string, reason: string | undefined) => `${cli} 在執行工具「${tool}」時中止了這一輪${reason ? `（${reason}）` : ''}。`,
  openCancelledNoReason: (cli: string) => `${cli} 自行中止了這一輪（stopReason: cancelled），沒有給出原因。`,
  openRefusal: (cli: string) => `${cli} 的模型拒絕回答這一輪（stopReason: refusal）。`,
  openRejectedMode: (cli: string, mode: string, e: string) => `${cli} 不接受 session 模式「${mode}」：${e}`,
  openRejectedModel: (cli: string, model: string, e: string) => `${cli} 不接受模型「${model}」：${e}`,
  openRejectedEffort: (cli: string, effort: string, e: string) => `${cli} 不接受推理強度「${effort}」：${e}`,
  openNativeNotYet: (cli: string) => `Harness Relay 還不能列出 ${cli} 自己載入的項目。`,
  openNoLogin: (cli: string) => `${cli} 不需要登入：它使用「設定 → 模型來源」裡的 API key 與端點。`,
  openBackendsReady: (names: string) => `模型來源：${names}`,
  openNoBackend: '尚未設定模型來源（設定 → 模型來源）',

  // Goose (src/server/agents/goose.ts)
  gooseSessionNotChecked: (detail: string) =>
    `Harness Relay 無法檢查 Goose 這個 session 存的擴充功能清單（${detail}），所以沒有接續它：先前執行的指令可能在裡面加了不經詢問就會啟動的程式。這一輪改用新的 session。`,
  gooseAuthFailed: (backend: string) => `Goose 無法用 ${backend} 的 API key 登入。請到「設定 → 模型來源」檢查這把 key。`,
  gooseModelNotFound: (backend: string, model: string) => `${backend} 沒有模型「${model}」（404）。請在成員設定換一個模型。`,
  gooseUnreachable: (backend: string, host: string) => `Goose 連不上 ${backend}（${host}）。請檢查網路，或在「設定 → 模型來源」檢查端點的網址。`,
  // Pi (src/server/agents/pi.ts)
  piSessionMissing: (id: string) => `找不到 session ${id} 的檔案（可能已被刪除）`,
  piSessionMoved: (then: string, now: string) => `這個 session 的工作目錄是 ${then}，這一輪的是 ${now}`,
  piSessionMismatch: (want: string, got: string) => `Pi 開啟的是 session ${got}，不是 ${want}`,
  piGateMissing:
    'Harness Relay 的把關擴充套件沒有在 Pi 裡載入（它負責在每個工具呼叫前詢問），所以這一輪沒有開始。請確認 Harness Relay 的資料夾裡有 src/server/agents/piGate.js。',
  piGateWritable: (path: string) => `Harness Relay 的把關擴充套件（${path}）在這一輪可以寫入的資料夾裡，所以沒有執行 Pi。請換一個工作目錄。`,
  piModelMismatch: (want: string, got: string) => `Pi 選了模型「${got}」，不是指定的「${want}」`,
  piEffortLevels: (levels: string) => `這個模型可用的強度：${levels}`,
  piPromptRejected: (e: string) => `Pi 沒有接受這一輪的訊息：${e}`,
  piKeyRejected: (backend: string, e: string) => `${backend} 拒絕了 API key（${e}）。請到「設定 → 模型來源」檢查金鑰。`,
  piModelRejected: (model: string, backend: string, e: string) => `${backend} 沒有可用的模型「${model}」（${e}）。請改選其他模型。`,
  piUnreachable: (backend: string, e: string) => `連不上 ${backend}：${e}`,
  piEndpointUnreachable: (name: string, url: string, e: string) => `連不上端點「${name}」（${url}）：${e}。請確認伺服器正在執行，網址正確。`,
  piModelError: (e: string) => `模型回報錯誤：${e}`,

  // Cline (src/server/agents/cline.ts)
  clineBadKey: (where: string, e: string) => `Cline 的模型來源「${where}」拒絕了 API key：${e}。請到「設定 → 模型來源」檢查這把 key。`,
  clineBadModel: (model: string, where: string, e: string) => `模型來源「${where}」沒有 Cline 要用的模型「${model}」：${e}。請改選這個來源提供的模型。`,
  clineUnreachable: (where: string, e: string) => `Cline 連不上模型來源「${where}」：${e}。請確認端點正在執行、網址正確（設定 → 模型來源）。`,
  clineFailed: (e: string) => `Cline 沒有完成這一輪：${e}`,
  // OpenHands (agents/openhands.ts)
  openhandsSubagentRefused: '完全存取以外不允許：OpenHands 的 subagent 會不經詢問執行指令與修改檔案',
  openhandsNoSuchSession: '它的 session 資料夾裡沒有這個 session',
  openhandsBadKey: (backend: string) => `${backend} 不接受 OpenHands 用的 API key（401）。請到「設定 → 模型來源」檢查金鑰。`,
  openhandsBadModel: (backend: string, model: string) => `${backend} 沒有模型「${model}」，或這把金鑰不能用它。請為這位成員選另一個模型。`,
  openhandsUnreachable: (backend: string, e: string) => `OpenHands 連不到模型來源 ${backend}：${e}`,
  openhandsRateLimited: (backend: string, e: string) => `${backend} 暫時拒絕了 OpenHands 的請求（額度或速率限制）：${e}`,
  openhandsTerminal: (e: string) => `OpenHands 無法啟動它的終端機（tmux）：${e}`,
  openhandsFailed: (e: string) => `OpenHands 沒有完成這一輪：${e}`,
  openhandsNoCatalog: '找不到 OpenHands 安裝裡 LiteLLM 的模型清單',
  openhandsUnknownAction: '無法得知 OpenHands 要做的是哪個動作，所以沒有自動允許',
  openhandsLeftover: (n: number) => `它的 session 還留著 ${n} 個上一輪沒有完成的動作（停止或中斷時留下的），不能讓它們在不經詢問下執行`,
  openhandsAction: 'OpenHands 的動作',
  openhandsBatchTitle: (title: string, more: number) => `${title}（另有 ${more} 個）`,
  openhandsBatch: (n: number, calls: string[]) => `一次回答涵蓋這 ${n} 個動作：\n${calls.map((c) => `• ${c}`).join('\n')}`,
  openhandsNoTerminal:
    '完全存取以外，OpenHands 需要在沙箱裡使用終端機才能執行：請到「設定 → OpenHands」打開「讓 OpenHands 在沙箱裡使用終端機：它的指令因此可以讀寫你其他的終端機視窗」（打開後，它的指令可以在你其他的終端機視窗印出文字、讀取你在那裡輸入的內容、更改它們的設定，但仍無法替你在那些視窗打字），或把這個對話設成完全存取。',
  openhandsStuck: 'OpenHands 自己停止了這一輪：它的卡住偵測發現它一直重複相同的動作（或得到相同的錯誤）卻沒有進展。請再問一次、換個說法，或為這位成員選另一個模型。',
  openhandsBatchRefused: '跟同一批動作一起被拒絕：OpenHands 對整批只問一次，而其中另一個動作不被允許',
  openhandsOddLog: '它的 session 紀錄跟 OpenHands 自己寫下的樣子不同（可能被別的程式改過），Harness Relay 無法確定 OpenHands 接續時會不經詢問執行其中哪些動作',
  openhandsNoEffort: (backend: string, model: string) => `${backend} 的模型「${model}」不接受推理強度。請把這位成員的推理強度設成 none（或預設）。`,
  openhandsSandboxRefusedReadOnly: 'Harness Relay 的沙箱拒絕了：這個對話是唯讀的。',
  openhandsSandboxProtected: 'Harness Relay 的沙箱拒絕了：這是受保護的路徑，Harness Relay 不讓代理讀取（它自己的資料庫與暫存檔、瀏覽器的資料）。',
  openhandsSandboxRefused: 'Harness Relay 的沙箱拒絕了：這個位置不在這個對話可以寫入的資料夾內。',
  openSandboxRefusedReadOnly: 'Harness Relay 的沙箱拒絕了：這個對話是唯讀的。',
  openSandboxRefused: 'Harness Relay 的沙箱拒絕了：這個位置不在這個對話可以寫入的資料夾內。',

  tooManyEndpoints: (n: number) => `最多只能設定 ${n} 個自訂端點。`,
  endpointNotFound: (id: string) => `找不到端點「${id}」`,
  deletedEndpointNotFound: (id: string) => `沒有記著已刪除的端點「${id}」`,
  endpointIdInvalid: (id: string) => `端點 id「${id}」只能用小寫英文字母、數字與 -（開頭與結尾不能是 -，最多 32 個字元）。`,
  endpointIdReserved: (id: string) => `「${id}」是內建模型來源的名稱，請為端點取別的 id。`,
  endpointNameMissing: '請輸入端點的名稱',
  endpointUrlInvalid: (url: string) => `「${url}」不是可用的端點網址：需要 http:// 或 https:// 開頭，不含帳號密碼、查詢字串或 #。`,
  endpointUrlRelay: (url: string) => `「${url}」是 Harness Relay 自己的位址，不能當成模型端點。`,
  endpointModelsInvalid: (n: number, chars: number) => `模型名稱最多 ${n} 個，每個最多 ${chars} 個字元，不能含空白。`,
  backendUnknown: (id: string) => `未知的模型來源：${id}`,
  claudeReopens: (file: string, entry: string) =>
    `你的 Claude Code 設定（${file}）中的 sandbox.filesystem 讓沙箱可以存取「${entry}」，這會開放 Harness Relay 保護的路徑（瀏覽器的資料夾或它的資料庫）。請移除這一項後再試，或改用完全存取。`,
  cwdHoldsVoice: (dir: string, voice: string, fromEnv: boolean) =>
    `工作目錄「${dir}」包含語音輸入的資料夾「${voice}」，或就在它裡面${fromEnv ? '（RELAY_VOICE_DIR）' : ''}。Harness Relay 會在沙箱外執行那裡的語音引擎，而可編輯模式下 agent 不經詢問就能修改這裡的檔案。請改用其他資料夾或唯讀模式。`,
  cwdIsRelay: (dir: string) =>
    `工作目錄「${dir}」包含 Harness Relay 本身（它的程式或資料）。可編輯模式下，agent 不經詢問就能修改這裡的檔案，也就能改動 Harness Relay 的程式碼或資料庫，繞過它的沙箱與登入。請改用其他資料夾或唯讀模式；要開發 Harness Relay 本身，請從另一個資料夾執行你使用的那份 Harness Relay。`,
  // OpenCode (agents/opencode.ts)
  opencodeBackendError: (backend: string, e: string) =>
    `模型來源 ${backend} 回報錯誤，OpenCode 無法完成這一輪：${e}。請檢查「設定 → 模型來源」裡的 API key、端點網址與模型名稱。`,
  opencodeAuthRequired: (backend: string) => `OpenCode 無法使用模型來源 ${backend}：缺少 API key 或它被拒絕。請到「設定 → 模型來源」檢查。`,
  opencodeForeignControl: (detail: string) =>
    `安全問題，這次執行已停止：OpenCode 自己的伺服器被 Harness Relay 以外的程式操作了（${detail}）。agent 執行的指令可能讀到了它伺服器的密碼。沙箱的檔案與網路限制仍然有效；請檢查這一輪做了什麼。`,
  opencodeNoLinuxSandbox:
    '在 Linux 上，OpenCode 只能以「完全存取」執行：Harness Relay 的沙箱給它一個自己的網路，它的伺服器在那裡，Harness Relay 無法監看（完全存取以外需要監看），所以沒有執行它。請改用完全存取（只在你信任的資料夾），或改用另一個 agent。',
  opencodeDatabaseNotChecked: (detail: string) =>
    `Harness Relay 無法清掉 OpenCode 資料庫裡先前執行的指令可能加進去的權限規則（${detail}），所以清空了這位成員的 OpenCode 狀態，沒有接續這個 session。這一輪改用新的 session。`,
  opencodeWatchFailed: (e: string) => `Harness Relay 無法監看 OpenCode 自己的伺服器，所以沒有執行它（完全存取以外需要）：${e}`,
  opencodeWriteRefused: (path: string) => `沙箱不允許寫入 ${path}（唯讀模式，或不在這次執行能寫入的資料夾裡）`,

  // Sharing a conversation (a gist through the GitHub CLI)
  shareEmpty: '沒有可以分享的內容',
  shareTooLarge: (mb: string) => `這個分享頁有 ${mb} MB，超過 gistpreview 能顯示的 1 MB。請改成分享到比較前面的某則回覆。`,
  shareNoGh: (min: string) => `找不到 GitHub CLI（gh）。請從 https://cli.github.com 安裝 ${min} 以上的版本，並在終端機執行 gh auth login 後再試一次。`,
  ghTooOld: (min: string, version?: string) =>
    `GitHub CLI（gh）版本太舊${version ? `（目前是 ${version}）` : ''}：需要 ${min} 以上。請從 https://cli.github.com 更新 gh（用 Homebrew 裝的可以執行 brew upgrade gh）後再試一次。`,
  shareSignedOut: 'GitHub CLI（gh）尚未登入。請在終端機執行 gh auth login 後再試一次。',
  shareFailed: (detail: string) => `無法建立 gist：${detail}`,
  shareNoDetail: 'gh 沒有說明原因',
  shareNoUrl: 'gh 沒有回傳 github.com 上的 gist 網址（gistpreview 只能顯示 github.com 的 gist）。如果已經建立了 gist，可以用 gh gist list 找到它再刪除',
  unshareFailed: (detail: string) => `無法刪除 gist：${detail}`,
  unshareNotOwner:
    '這個 gist 還在 GitHub 上，但不屬於 gh 目前登入的帳號，所以無法刪除。請用 gh auth switch 切回建立它的帳號，再移除一次。',
  shareNotFound: '找不到這個分享',
  shareNoFileUrl: 'GitHub 沒有回傳上傳檔案的網址',
  shareNotGithub: 'gist 不在 github.com 上，gistpreview 只能顯示 github.com 的 gist',
  shareBadFiles: '要附上的檔案清單格式不對',
  shareFileProblem: {
    missing: '找不到這個檔案（或它是資料夾）',
    outside: '它不在這個對話的資料夾裡（或在 .git 裡）',
  },
  shareFileTooLarge: (mb: string) => `它超過 ${mb}`,
  shareFileRefused: (name: string, reason: string) => `無法附上「${name}」：${reason}。請重新勾選要附上的檔案後再試一次。`,
  shareFilesTooMany: (max: number) => `一次最多只能附上 ${max} 個檔案。`,
  shareFilesFailed: (detail: string) => `無法上傳附上的檔案：${detail}`,
  shareBeingMade: '這個分享還在建立中，完成後才能移除。',
  shareFilesTooLarge: (mb: string, max: string) => `要附上的檔案共 ${mb} MB，超過合計 ${max} 的上限。`,
  shareFilesUndone: (detail: string) => `無法建立分享頁（${detail}），已經上傳的檔案也一併刪除了。請再試一次。`,
  shareFilesLeftover: (detail: string) =>
    `無法建立分享頁（${detail}），已經上傳的檔案也沒能刪除，還在 GitHub 上（一個只有檔案、沒有頁面的 secret gist）。請到「設定 → 分享的對話」移除它。`,
  shareFilesUnknown: (detail: string, token: string) =>
    `無法建立分享頁（${detail}），也無法確認附上的檔案是否已經上傳。如果 GitHub 上有說明含「${token}」的 gist，請用 gh gist list 找到並刪除它。`,
  reportShotsNone: '沒有要上傳的截圖。',
  updateNone: '目前沒有可以更新的新版本。',
  updateUnderWay: '更新已經在進行中。',
  reportShotsTooMany: (max: number) => `一次最多只能上傳 ${max} 張截圖。`,
  reportShotTooLarge: (n: number, mb: number) => `第 ${n} 張截圖超過 ${mb} MB 的上限。`,
  reportShotNotImage: (n: number) => `第 ${n} 張截圖不是 PNG、JPEG 或 WebP 圖片。`,
  reportShotUnreadable: (n: number) => `第 ${n} 張截圖讀不懂它的檔案結構，沒辦法確定拿掉了中繼資料，所以不上傳：請重新截圖，或另存成 PNG 再試。`,
  reportShotsUndone: (detail: string) => `無法上傳截圖（${detail}），已經建立的 gist 也刪除了。請再試一次。`,
  reportShotsLeftover: (detail: string, url: string) =>
    `無法上傳截圖（${detail}），已經建立的 gist 也沒能刪除，還在 GitHub 上：${url}。請到 GitHub 刪除它。`,
  reportShotsUnknown: (detail: string, token: string) =>
    `無法上傳截圖（${detail}），也無法確認 gist 是否已經建立。如果 GitHub 上有說明含「${token}」的 gist，請用 gh gist list 找到並刪除它。`,
  reportShotsNotGithub: 'gh 登入的不是 github.com，截圖只能上傳到 github.com 的 gist',
  reportShotsNotFound: '這裡找不到這次上傳的截圖（可能是伺服器重新啟動過）：請到 GitHub 刪除那個 gist。',
  messageNotFound: '找不到這則訊息',
  branchTitle: (title: string) => `分支 · ${title}`,
  branchOnlyReply: '只能從 agent 的回覆分支',
  branchStreaming: '這則之前還有回覆在進行中，請等它們完成再分支',
  emptyMessage: '訊息不能是空的',
  typeFirst: '請先輸入訊息',
  badAttachment: '附加檔案的格式不正確',
  tooManyAttachments: (n: number) => `一則訊息最多附加 ${n} 個檔案`,
  attachmentTooLarge: (name: string, max: number) => `「${name}」太大了（上限 ${Math.round(max / 1024 / 1024)} MB）`,
  attachmentNotFound: '找不到這個附加檔案',
  mediaNotFound: '找不到這個圖片或影片（只能顯示工作目錄裡的圖片與影片）',
  downloadNotFound: '找不到這個檔案（只能下載工作目錄裡的檔案）',
  busy: '團隊還在回覆中，請先等待或按停止',
  busySettings: '團隊回覆中，無法修改設定',
  busyApply: '團隊還在回覆中，請等回覆結束再套用',
  shuttingDown: '伺服器正在關閉',
  noAgents: '這個對話沒有任何 agent',
  runFailed: (msg: string) => `執行失敗：${msg}`,
  stoppedNote: '已停止。',
  queuedNotFound: '這則訊息已經送出或撤回了',
  queueFull: (n: number) => `最多 ${n} 則訊息等待送出，請等團隊回覆後再送`,
  gitInitNote: (root: string) => `工作目錄原本不是 git repository，已自動執行 git init：${root}`,
  dirLocked: (title: string, root: string) =>
    `對話「${title}」正在修改 ${root}，請等它結束後再試（或改用唯讀 / 平行模式）。`,
  noWorktree: '這位成員沒有 worktree',
  resultStale: '工作目錄已經更新過，這份結果已過期；請讓團隊再跑一輪。',
  appliedNote: (name: string, files: number) =>
    `已把 @${name} 的修改套用到工作目錄（${files} 個檔案，尚未 commit）。下一次平行作業會從新的工作目錄狀態開始。`,
  noChanges: '這則訊息沒有檔案修改',
  relayLimit: (hops: number) => `已達接力上限（${hops} 棒），交還給使用者。可按「繼續」讓團隊接著做。`,

  // Approvals
  approvalNotFound: '這個請求已經處理過或已失效',
  approvalDeclined: '使用者拒絕了這個操作。',
  retryAgentGone: (name: string) => `@${name} 已不在團隊中，無法重試這則回覆`,

  // Auto team
  planNotFound: '找不到這份團隊設計',
  planNotSavable: '只有首席 agent 設計或調整過的團隊可以存成範本',
  planFailed: (why: string) => `首席 agent 沒有給出可用的團隊設計（${why}），改用預設範本。`,
  planUnparsable: '回覆中找不到 JSON 團隊設計',
  planUnknownTemplate: (id: string) => `沒有 id 為「${id}」的範本`,
  planTemplateTooBig: (name: string, max: number) => `範本「${name}」的成員比隊伍上限（${max} 位）多`,
  planTemplateFits: (name: string) => `首席 agent 判斷範本「${name}」適合這個問題，直接套用。`,
  planFailedKept: (why: string) => `首席 agent 沒有給出可用的團隊設計（${why}），沿用目前的團隊。`,
  planKeepFits: '首席 agent 判斷目前的團隊也適合這個問題，沿用不變。',
  planNoCurrentTeam: '這個對話還沒有團隊可以沿用',
  planAwaitingConfirm: '請先確認首席 agent 設計的團隊，團隊才會開始回答',
  // Asking the lead agent to change a team (team drawer)
  reviseEmpty: '請先說明想怎麼調整團隊',
  reviseTooLong: (max: number) => `調整說明最多 ${max} 個字`,
  reviseStopped: '已停止調整團隊',
  reviseFailed: (why: string) => `首席 agent 沒能調整團隊（${why}）。團隊維持原樣，可以換個說法再試一次。`,

  // Schedules
  scheduleNotFound: '這個對話沒有排程',
  scheduleTextRequired: '請輸入排程要傳給團隊的訊息',
  scheduleTextTooLong: (max: number) => `排程訊息最多 ${max} 個字`,
  scheduleBadRepeat: '排程的重複方式無效',
  scheduleBadTime: '時間的格式應為 HH:MM（24 小時制）',
  scheduleNeedDays: '每週的排程至少要選一天',
  scheduleBadHours: (max: number) => `間隔應為 1 到 ${max} 小時的整數`,
  scheduleBadMoment: '請選擇日期與時間',
  scheduleInPast: '這個時間已經過了，請選擇之後的時間',
  scheduleBadTimeZone: (tz: string) => `不認得時區「${tz}」`,
  scheduleNeedsTeam: '請先確認團隊，再設定排程',
  scheduleNoTeam: '團隊還沒確認',
  scheduleWaitsForAnswer: '團隊在等你回答問題',
  scheduleStillQueued: '上一則排程訊息還在等待送出',
  scheduleBusy: '對話正在更新，請稍後再試',
  scheduleQueueFull: '等待送出的訊息已經滿了',
  scheduleRefused: '排程執行時可能沒人看著，已自動拒絕',
  scheduleConvBusy: '對話正在更新設定或套用結果',
  scheduleMissedNote: (when: string) => `${when} 的排程訊息沒有送出：當時 Harness Relay 沒有在執行。`,
  scheduleSkippedNote: (when: string, why: string) => `${when} 的排程訊息沒有送出：${why}。`,
  scheduleFailedNote: (when: string, why: string) => `${when} 的排程訊息無法送出：${why}`,
  scheduleChatNote: (title: string) => `這個對話由「${title}」的排程開啟，排程的訊息在這裡送出。`,
  scheduleNoLead: '這個對話沒有讓首席 agent 組隊',
  scheduleHasTeam: '這個排程已經有團隊了',
  scheduleCreatedNote: '已建立排程。首席 agent 會為排程的訊息組隊；團隊確認後，排程會在設定的時間把訊息傳給它，現在不會先執行。',

  // HTTP
  unknownProvider: (p: string) => `未知的 provider：${p}`,
  dirNotFound: (cwd: string) => `目錄不存在：${cwd}`,
  keyringFailed: (e: string) => `無法把 API key 存進系統的金鑰儲存區：${e}`,
  noLogin: '沒有進行中的登入',
  unknownAccount: (provider: string, id: string) => `${provider} 沒有這個帳號：${id}`,
  tooManyAccounts: (provider: string, max: number) => `${provider} 最多 ${max} 個帳號（含預設帳號）`,
  badAccountLabel: (max: number) => `帳號名稱最多 ${max} 個字，不能換行`,
  defaultAccountStays: '預設帳號不能移除',
  accountBusy: '有對話正在執行，或首席 agent 正在替對話分群或調整團隊。請等它們結束（或停止對話、關閉團隊設定）再移除帳號。',
  presetNameRequired: '請輸入範本名稱',
  otherGroup: '其他',
  groupNameRequired: '請輸入群組名稱',
  groupNameTooLong: (max: number) => `群組名稱最多 ${max} 個字`,
  groupNameTaken: (name: string) => `已經有叫「${name}」的群組了`,
  groupNotFound: '找不到這個群組',
  tooManyGroups: (max: number) => `最多只能建立 ${max} 個群組`,

  // Validation
  needAgent: '至少需要一個 agent',
  tooManyAgents: (max: number) => `最多 ${max} 個 agent`,
  badName: (i: number, name: string) => `第 ${i} 個 agent 的名稱「${name}」無效：只能用字母、數字、_ 或 -，最多 32 字`,
  reservedName: (name: string) => `名稱「${name}」是保留字`,
  duplicateName: (name: string) => `agent 名稱「${name}」重複了`,
  badProvider: (name: string) => `agent「${name}」的 provider 無效`,
  badEffort: (name: string, effort: string) => `agent「${name}」的推理強度「${effort}」無效`,
  cwdMissing: (cwd: string) => `工作目錄不存在：${cwd}`,
  cwdNotDirectory: (cwd: string) => `這不是資料夾：${cwd}`,
  cwdCreateFailed: (cwd: string, reason: string) => `無法建立工作目錄 ${cwd}（${reason}）`,
  tooManyCwds: (max: number) => `工作目錄最多 ${max} 個`,
  cwdTwice: (cwd: string) => `工作目錄 ${cwd} 重複了`,
  pickFolderTitle: '選擇工作目錄',
  pickFolderNotHere: '選擇資料夾的視窗只能在執行 Harness Relay 的這台電腦上開啟。',
  pickFolderMissing: '這台電腦沒有可以開啟的選擇資料夾視窗（Linux 上需要 zenity 或 kdialog）。',
  pickFolderBusy: '選擇資料夾的視窗已經開著了，請先在那裡選好資料夾或取消。',
  pickFolderFailed: (reason: string) => `無法開啟選擇資料夾的視窗（${reason}）`,
  invalidField: (field: string) => `「${field}」的值無效`,
  agentHomeTooBroad: (dir: string) => `請用一個專用的資料夾（例如 ~/.relay-agents），不要用 ${dir}`,
  agentHomeCreateFailed: (dir: string, reason: string) => `無法建立資料夾 ${dir}（${reason}）`,
  agentHomeNotAbsolute: (dir: string) => `請填完整路徑，或以 ~ 開頭的路徑（例如 ~/.relay-agents），不要用 ${dir}`,
  agentHomeInside: (dir: string, folder: string) =>
    `${dir} 在 ${folder} 裡面：那裡的快照會把各 CLI 的登入與 session 紀錄一起收進去。請選這個資料夾以外的位置，例如 ~/.relay-agents`,
  agentHomeBusy: '有對話正在執行，或首席 agent 正在替對話分群或調整團隊。請等它們結束（或停止對話、關閉團隊設定）再更改各 CLI 自己的資料夾。',
  agentsViewLinkInvalid: (url: string) => `開啟 AgentsView 的網址無效：${url}。請填 http:// 或 https:// 開頭的網址，例如 https://my-computer.tail1234.ts.net:9999`,
  agentsViewUrlInvalid: (url: string) =>
    `AgentsView 網址無效：${url}。只接受這台電腦上的 http(s) 位址，例如 http://127.0.0.1:8080`,

  // Tool library
  badMcpName: (name: string) => `MCP 伺服器名稱「${name}」無效：只能用英文字母、數字、_ 和 -，最多 40 個字`,
  badVarName: (name: string) => `名稱「${name}」無效或重複：只能用英文字母、數字、_、. 和 -，不能以數字開頭`,
  mcpNeedsCommand: '請填寫要執行的指令',
  mcpNeedsUrl: '請填寫 http:// 或 https:// 開頭的網址',
  mcpNotFound: (name: string) => `找不到 MCP 伺服器「${name}」`,
  mcpExists: (name: string) => `已經有名為「${name}」的 MCP 伺服器`,
  tooManyMcp: (n: number) => `最多可以設定 ${n} 個 MCP 伺服器`,
  secretsFailed: (e: string) => `無法把 MCP 伺服器的變數存進系統的金鑰儲存區：${e}`,
  secretsUnreadable: (name: string) => `讀不到 MCP 伺服器「${name}」存在金鑰儲存區的值（可能被鎖住了），請重新輸入每個值，或解鎖後重新啟動 Harness Relay。`,
  memoryTooLong: (n: number) => `記憶最多 ${n} 個字`,
  tooManySkills: (n: number) => `最多可以加入 ${n} 個 skill`,
  noSkillsIn: (path: string) => `${path} 裡沒有 skill（要有 SKILL.md 的資料夾，或包含這種資料夾的資料夾）`,
  skillMissing: '找不到 SKILL.md',
  skillDuplicate: (name: string) => `已經有另一個名為「${name}」的 skill，這個不會提供給 agent`,

  // What each CLI loads by itself
  nativeTimeout: (cli: string) => `${cli} 沒有在時間內回應。`,
  nativeFileNotListed: '這個檔案不在這個 CLI 回報的清單裡，或已經不存在。',
  grokTrustFailed: (e: string) => `無法記錄 Grok 對這個資料夾的信任：${e}`,
  grokTrustNotTaken: (dir: string) => `記錄信任 ${dir} 後，Grok 仍回報這個資料夾未受信任（可能被組織的設定限制），所以已還原這項變更。`,
  grokTrustFolderChanged: (dir: string) => `Grok 現在是依 ${dir} 決定信任，不是你確認的資料夾。請重新確認。`,
  nativeFailed: (cli: string, detail: string) => `${cli} 回報錯誤：${detail}`,
  nativeNoAnswer: (cli: string, part: 'all' | 'skills' | 'mcp' | 'tools' | 'hooks' | 'agents' | 'plugins') =>
    part === 'all'
      ? `${cli} 沒有回應。`
      : `${cli} 沒有回報它的${{ skills: ' skill', mcp: ' MCP 伺服器', tools: '內建工具', hooks: ' hook', agents: ' subagent', plugins: ' plugin' }[part]}。`,
  nativeAsRunFailed: (cli: string, detail: string) => `依 Harness Relay 啟動 ${cli} 的方式再問一次時失敗，所以沒有標示哪些項目不載入：${detail}`,
  nativeAsRunPartial: (cli: string) => `依 Harness Relay 啟動 ${cli} 的方式再問一次時逾時：已回答的部分有標示不載入的項目，其餘沒有標示。`,

  // Files
  fileNotFound: '找不到這個檔案或資料夾（只能瀏覽工作目錄裡的內容）',
  zipTooBig: (items: number, gb: number) => `這個資料夾太大，無法打包成 zip：最多 ${items.toLocaleString('zh-TW')} 個檔案與資料夾、共 ${gb} GB。請下載其中的子資料夾。`,
  fileRootNotFound: '這個資料夾已經不存在',

  // Workspace
  gitFailed: (cmd: string, out: string) => `git ${cmd} 失敗：${out}`,
  noAutoRepo: (dir: string) => `不會在 ${dir} 自動建立 git repository，請改選一個專案資料夾作為工作目錄。`,
  repoTooBroad: (root: string) =>
    `工作目錄位在 ${root} 這個 git repository 裡，範圍太大（每一輪都要記錄整個資料夾的狀態）。請改選一個專案資料夾，或在專案資料夾裡執行 git init。`,
  outputTooLarge: (cmd: string) => `git ${cmd} 的輸出太大，無法處理`,
  nothingToApply: '沒有可套用的修改',
  applyConflict: (detail: string) =>
    `工作目錄中的檔案跟這些修改有衝突，沒有套用任何變更：\n${detail}\n可以請 agent 改成以目前的工作目錄為基礎重做，或手動合併分支。`,

  // Providers and models
  planDetail: (plan: string) => `方案：${plan}`,
  defaultModelDetail: (model: string) => `預設模型：${model}`,
  logoutFailed: (code: number | null) => `logout 失敗（exit ${code}）`,
  codexLoginFailed: (code: number | null) => `codex login 失敗（exit ${code}）`,
  codexModelsFailed: 'codex debug models 失敗',
  grokModelsEmpty: 'grok models 沒有回傳模型',
  cursorModelsFailed: 'cursor-agent 沒有回傳模型清單',
  antigravityModelsFailed: 'agy models 沒有回傳模型',
  copilotModelsFailed: 'Copilot 沒有回傳模型',
  // Voice input
  voiceNotReady: '語音輸入還沒安裝完成，請到「設定 → 語音輸入」查看。',
  voiceBusy: '語音輸入正在安裝中，請等它完成或先取消。',
  voiceNoJob: '目前沒有進行中的安裝',
  voiceNeedsHomebrew:
    '在 macOS 上要透過 Homebrew 安裝 whisper.cpp，但找不到 brew。請先安裝 Homebrew（https://brew.sh），或自行安裝 whisper.cpp 後在下方指定 whisper-server 的路徑。',
  voiceNoBuild: (platform: string) =>
    `whisper.cpp 沒有提供 ${platform} 的預先編譯版本。請自行安裝 whisper.cpp，再在下方指定 whisper-server 的路徑。`,
  voiceBinNotFound: (bin: string) => `找不到 whisper-server：${bin}`,
  voiceDownloadFailed: (name: string, detail: string) => `下載 ${name} 失敗：${detail}`,
  voiceChecksumMismatch: (name: string) => `${name} 下載後的內容與預期不符（SHA-256 不同），已刪除。請再試一次。`,
  voiceExtractFailed: (detail: string) => `解壓縮 whisper.cpp 失敗：${detail}`,
  voiceBrewFailed: (detail: string) => `brew install whisper-cpp 失敗：${detail}`,
  voiceEngineBroken: (detail: string) => `whisper-server 無法執行：${detail}`,
  voiceServerFailed: (detail: string) => `語音辨識引擎啟動失敗：${detail}`,
  voiceTranscribeFailed: (detail: string) => `語音辨識失敗：${detail}`,
  voiceBadAudio: '無法讀取錄音（需要 WAV 格式）。',
  voiceTooLong: (seconds: number) => `錄音太長，一次最多 ${seconds} 秒。`,
  voiceModelBusy: '這個模型正在下載，不能刪除。',
  voiceNoSpace: (need: string, free: string) => `硬碟空間不足：需要約 ${need}，目前只剩 ${free}。`,
  voiceCancelled: '已取消安裝',
  login: {
    claudeSubscription: ['Claude 訂閱帳號', '用 Claude Pro / Max 帳號登入。開啟連結授權後，把頁面顯示的授權碼貼回來。'],
    claudeConsole: ['Anthropic Console', '用 Console 帳號登入（依 API 用量計費）。'],
    codexDevice: ['ChatGPT 裝置碼', '開啟連結、登入 ChatGPT，輸入下方一次性代碼。'],
    codexBrowser: ['ChatGPT 瀏覽器登入', '在這台電腦開啟瀏覽器完成登入（需要本機 localhost 回呼）。'],
    grokDevice: ['xAI 裝置碼', '開啟連結並確認下方代碼。'],
    grokBrowser: ['xAI 瀏覽器登入', '在這台電腦開啟瀏覽器完成 OAuth 登入。'],
    cursorBrowser: ['Cursor 帳號', '開啟下方連結，在任何一台裝置的瀏覽器登入 Cursor 並允許 CLI。'],
    antigravityGoogle: ['Google 帳號', '開啟下方連結，在任何一台裝置的瀏覽器登入 Google，再把頁面顯示的授權碼（或整個網址）貼回來。'],
    copilotDevice: ['GitHub 帳號（裝置代碼）', '開啟下方的 GitHub 連結，在任何一台裝置的瀏覽器輸入顯示的代碼並授權。'],
  } as Record<string, [string, string]>,
};

export type ServerMessages = typeof zhTW;

const en: ServerMessages = {
  stopped: 'Stopped',
  timedOut: 'Timed out',
  exitedWithoutReply: (cli, code) => `${cli} exited (exit ${code}) without a reply`,
  exitedWithoutTurn: (cli, code) => `${cli} exited (exit ${code}) without finishing the turn`,
  codexMcpListFailed: (detail) =>
    `Codex could not list its MCP servers, so they or their tools could not be left out of this run (${detail}). Update Codex, or clear what is left out on the MCP tools tab of "…this CLI loads by itself" in Codex's settings.`,
  codexLeftOutUnchecked: (detail) =>
    `Could not check that Codex left out the skills, hooks or plugins this run leaves out (${detail}), so it did not run. Try again, or clear them in "…this CLI loads by itself" in Codex's settings.`,
  codexNoProfile: (active) =>
    `Codex did not run this thread in the permission profile Harness Relay gave it (it answered ${active ? `"${active}"` : 'no profile'}; an older Codex that does not know the field, say), so its sandbox would not keep it out of your browsers' folders and Harness Relay's database, and it did not run. Update Codex (0.167 works) and try again.`,
  codexStillLoaded: (parts) =>
    `Codex still loaded ${parts.join(' and ')} that are left out of this run (an older Codex that does not know the setting, say). Update Codex, or clear what is left out on the ${parts.map((p) => (p === 'skills' ? 'Skills' : p === 'hooks' ? 'Hooks' : 'Plugins')).join(' and ')} ${parts.length > 1 ? 'tabs' : 'tab'} of "…this CLI loads by itself" in Codex's settings.`,
  claudePluginsFailed: (detail) =>
    `Claude Code could not list its plugins, so they could not be left out of this run (${detail}). Update Claude Code, or clear "Leave all out" on the Plugins tab of "…this CLI loads by itself" in Claude Code's settings.`,
  claudeAgentsFailed: (detail) =>
    `Claude Code's own subagents could not be left out of this run (${detail}). Update Claude Code, or clear "Leave all out" on the Subagents tab of "…this CLI loads by itself" in Claude Code's settings.`,
  claudeError: 'Claude Code reported an error',
  claudeSandbox: (why) =>
    `Claude Code could not start its sandbox (needed below full access): ${why}. On Linux and WSL2, install bubblewrap and socat (for example sudo apt-get install bubblewrap socat), on Ubuntu 23.10 or later also an AppArmor profile for /usr/bin/bwrap (see "On Linux" in docs/sandboxing.md), and try again; or switch the permission to "Full access" to run without one.`,
  sandboxHost: 'A command in the sandbox wants to connect to this host.',
  commandNotFound: (bin) => `Command "${bin}" not found. Make sure it is installed, or set its path on the Settings page.`,
  windowsShimBroken: (bin, script, target) => `"${bin}" is ${script}, and ${target}, which it runs, is not there: install ${bin} again.`,
  windowsNoNode: (bin, script) => `"${bin}" is ${script}, which runs on Node.js, and no Node.js is on the PATH: install Node.js, or add it to the PATH.`,
  windowsScript: (bin, script) =>
    `"${bin}" is the script ${script}, which Harness Relay cannot start: it starts programs only, never through a shell, and cannot tell which program this script runs. Set the path to the program it runs (an .exe) on the Settings page.`,
  permission: { 'read-only': 'Read-only', edit: 'Edit', full: 'Full access' },
  grokRefusedReadOnly: 'Not allowed in read-only mode; Grok was told to use read-only tools',
  grokRefusedPublish: 'Pushing or publishing is not allowed with edit permission',
  grokCancelledNoReason: 'Grok ended the turn by itself (stopReason: cancelled) without giving a reason.',
  grokCancelled: (tool, reason) => `Grok ended the turn while running "${tool}"${reason ? ` (${reason})` : ''}.`,
  grokCancelHint: (permission) =>
    ` The permission is "${permission}"; if this action is needed, switch the permission to "Full access" and try again.`,
  grokSandbox: (why) => `Grok could not start its sandbox (needed below full access): ${why}. On Linux, the paths it may not read need bubblewrap (for example sudo apt-get install bubblewrap), and on Ubuntu 23.10 or later an AppArmor profile for /usr/bin/bwrap (see "On Linux" in docs/sandboxing.md).`,
  grokNoSession: 'grok returned no session id',
  grokModelsFailed: (path, why) => `Could not write your own endpoints' models into Grok's settings (${path}): ${why}`,
  relaySandboxWindows:
    "Harness Relay's own sandbox does not work on native Windows (the sandbox-runtime it uses is alpha there), so this agent does not run here in read-only or edit mode. Run Harness Relay in WSL2, or set the permission to full access (no sandbox).",
  relaySandboxPathTooLong: (dataDir, max) =>
    `The path of Harness Relay's data folder (${dataDir}) is too long for the sockets its sandbox makes there, so this did not run: set RELAY_DATA_DIR to a folder whose path is at most ${max} bytes (UTF-8: a character outside ASCII takes 2 to 4) and restart Harness Relay; or switch to full access.`,
  relaySandboxNoNode: "Harness Relay's sandbox needs Node.js 22.12 or later to run its sandbox helper, and the desktop app's own runtime cannot be used as Node: install Node.js so that it is on your login shell's PATH, then reopen the app; or switch to full access.",
  relaySandboxPlatform: (platform) =>
    `Harness Relay's own sandbox works on macOS and Linux only (this is ${platform}), so this agent does not run in read-only or edit mode. Set the permission to full access, or run it on macOS or Linux.`,
  relaySandboxMissing: (what, packages) =>
    `Harness Relay's own sandbox needs ${what}, which this computer does not have, so the agent did not run (every permission below full access needs it). Install it with sudo apt-get install ${packages} (Fedora: sudo dnf install ${packages}) and try again, or set the permission to full access.`,
  relaySandboxArch: (arch) =>
    `Harness Relay's own sandbox cannot block Unix sockets on this processor (${arch}; its seccomp filter is built for x64 and arm64 only), so a program in it could leave it through the socket of a service such as Docker, and the agent did not run. Set the permission to full access, or run it on an x64 or arm64 computer.`,
  relaySandboxFailed: (detail, platform) =>
    `Harness Relay's own sandbox could not start (every permission below full access needs it), so the agent did not run: ${detail}. ` +
    (platform === 'darwin'
      ? 'sandbox-exec is part of macOS; it cannot start a sandbox when Harness Relay itself runs inside one (for example, started by a sandboxed command): start Harness Relay from an ordinary terminal. '
      : platform === 'linux'
        ? 'bubblewrap needs unprivileged user namespaces: on Ubuntu 23.10 or later, add the AppArmor profile for /usr/bin/bwrap (see "On Linux" in docs/sandboxing.md); in a container, the container must allow user namespaces and mounting a fresh /proc (for example docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined), or use full access and let the container be the sandbox; WSL1 cannot, use WSL2. '
        : '') +
    'Or set the permission to full access.',
  relaySandboxBadHost: (entry) => `${entry} is not a host the sandbox can connect to (a host name or an IP address, with :port or without), so the agent did not run.`,
  relaySandboxLocalPort: (entry) =>
    `The model backend ${entry} is on this computer but has no port; the sandbox lets programs reach a port on this computer only when it is named, so the agent did not run. Add the model server's port to its address (for example localhost:11434).`,
  relaySandboxRelayPort: (entry) =>
    `The model backend ${entry} is Harness Relay's own port, which programs in the sandbox may not reach, so the agent did not run. Use the model server's own address.`,
  relaySandboxRelative: (path) => `The sandbox's paths must be absolute, and ${path} is not, so the agent did not run.`,
  relaySandboxWritable: (path, folder) =>
    `${path}, which this run may write, holds or is inside ${folder}, whose files decide how Harness Relay or the agents run, so the agent could get around the sandbox, and it did not run.`,
  relaySandboxProgram: (path) =>
    `The program ${path}, which the sandbox runs, is in a folder this run may write, where the agent could replace it and have it run outside the sandbox, so the agent did not run.`,
  relaySandboxNoChannel:
    "Harness Relay's own sandbox did not get its control channel (a bug in Harness Relay: it was started without its channel), so the agent did not run.",
  relaySandboxHost: 'A program in the sandbox wants to connect to this host. Allowing it lets this run reach it (and later runs too, if you allow it always).',
  grokRejectedModel: (value, err) => `Grok does not accept the model "${value}": ${err}`,
  grokRejectedEffort: (value, err) => `Grok does not accept the reasoning effort "${value}": ${err}`,
  cursorRefused: "Refused: not covered by this conversation's permission",
  cursorReadOnlyWrite: 'Not written: Cursor may not write in read-only mode',
  cursorProtectedWrite: "Cursor asks before changing files like this one: a change here could make code run later, outside any sandbox (a git hook, an editor task), or change an agent's settings.",
  cursorOutsideWrite: 'This file is outside the working directory: Cursor asks before writing outside it.',
  cursorOtherCwdWrite: "This file is in another of the chat's working directories: Cursor works in the first one, and asks before writing in the others.",
  cursorCancelled: 'Cursor ended the turn by itself (stopReason: cancelled) without giving a reason.',
  cursorNoSession: 'cursor-agent returned no session id',
  cursorRejectedModel: (value, err) => `Cursor does not accept the model "${value}": ${err}`,
  cursorRejectedEffort: (value, err) => `Cursor does not accept the reasoning effort "${value}": ${err}`,
  cursorRejectedMode: (err) => `Cursor could not switch to Agent mode: ${err}`,
  cursorExitCode: (code) => `exit code ${code}`,
  cursorService: (error) => `Cursor's service reported an error: ${error}`,
  cursorSignIn: (err) => `Cursor is not signed in (${err}). Sign in under Cursor in Settings, or set an API key.`,
  cursorConfigFailed: (err) => `Could not prepare Cursor's config folder for this turn: ${err}`,
  cursorAccountLogin:
    "Cursor keeps one sign-in per computer user (on macOS, in the keychain), so an extra Cursor account cannot sign in with a browser: give it an API key. Only the default account uses Cursor's own sign-in.",
  antigravityRefused: "Refused: not covered by this conversation's permission",
  antigravityProtected: "Refused: a protected path (browser data, Harness Relay's database…), which agents below full access may not read or write",
  antigravityEndsTurn: ' (Antigravity ends its turn after a refusal)',
  antigravityProjectSetup:
    "This project has setup Antigravity starts or runs by itself (MCP servers, hooks or plugins in a folder such as .agents): agy runs them outside any sandbox as soon as its session opens, without asking, in read-only mode too. Another agent, or whoever made the repository, may have put them there. The turn starts once you allow it; it asks again when the files change.",
  antigravityProjectSetupRefused: (files) =>
    `The turn did not start: this project has setup Antigravity would run by itself outside any sandbox (${files}), and it was not allowed. Check and remove those files, allow them, or use full access.`,
  antigravityOutsideWrite: "This file is not in the chat's working directories: edit mode covers writes in them only.",
  antigravityConfigWrite:
    "This is an agent's configuration (such as .agents/, .git/hooks or .vscode/): a change here could make code run later outside any sandbox, or change how an agent works, so it asks first.",
  antigravityExitCode: (code) => `exit code ${code}`,
  antigravityCancelled: 'Antigravity ended the turn by itself (stopReason: cancelled) without giving a reason.',
  antigravityNoSession: 'agy returned no session id',
  antigravityRejectedModel: (value, err) => `Antigravity does not accept the model "${value}": ${err}`,
  antigravityRejectedEffort: (value, err) => `Antigravity does not accept the thinking level "${value}": ${err}`,
  antigravityRejectedMode: (err) => `Antigravity could not switch back to its default mode: ${err}`,
  antigravitySignIn: (err) => `Antigravity is not signed in (${err}). Sign in under Antigravity in Settings, or set a Gemini API key.`,
  antigravityConfigFailed: (err) => `Could not prepare Antigravity's settings for this turn: ${err}`,
  antigravityAccountLogin:
    "Antigravity keeps its Google sign-in in the system keyring, and Harness Relay cannot be sure that another account's sign-in would not replace the default one's, so an extra Antigravity account runs on a Gemini API key only. Only the default account signs in with Google.",
  copilotRefused: "Refused: not covered by this conversation's permission",
  copilotProtected: "Refused: a protected path (browser data, Harness Relay's database…), which agents below full access may not read or write",
  copilotEndsTurn: ' (Copilot ends its turn after a refusal)',
  copilotProjectHooks:
    "This project has hooks Copilot runs by itself (files in .github/hooks, or hooks in its .github/copilot or .claude settings): Copilot runs them when its session opens and before each tool call, without asking, in read-only mode too (below full access inside its sandbox), even when hooks are left out in the account's settings. Another agent, or whoever made the repository, may have put them there. The turn starts once you allow them; if the files change, you are asked again.",
  copilotProjectHooksRefused: (files) =>
    `The turn did not start: this project has hooks Copilot would run by itself (${files}), and they were not allowed. Check and remove those hooks, allow them, or use full access.`,
  copilotOutsideWrite: "This file is not in the chat's working directories: edit mode covers writes in them only.",
  copilotConfigWrite:
    "This is an agent's configuration (such as .github/hooks, .agents/, .git/hooks or .vscode/): a change here could make code run later outside any sandbox, or change how an agent works, so it asks first.",
  copilotExitCode: (code) => `exit code ${code}`,
  copilotCancelled: 'Copilot ended the turn by itself (stopReason: cancelled) without giving a reason.',
  copilotNoSession: 'copilot returned no session id',
  copilotRejectedMode: (err) => `Copilot could not switch to its agent mode, or set allow-all as the permission says: ${err}`,
  copilotSignIn: (err) => `Copilot is not signed in (${err}). Sign in to GitHub under Copilot in Settings, or set a GitHub token.`,
  copilotConfigFailed: (err) => `Could not prepare Copilot's settings for this turn: ${err}`,
  copilotSandbox: (problem) =>
    `The turn did not start: Copilot's sandbox is not as Harness Relay set it up (${problem}), so its commands may not run below full access. Update Copilot CLI, check that this computer can run its sandbox (on Linux it needs bubblewrap and a few other tools), or use full access.`,

  defaultTitle: 'New chat',
  conversationNotFound: 'Conversation not found',
  signedOut: 'This browser is not signed in to Harness Relay. Open the sign-in link it printed in its terminal when it started, or run npm run login.',
  signedOutDesktop: "This browser is not signed in to Harness Relay. Choose Open in browser in the desktop app's menu (for the app's own window, Open Harness Relay): it opens with a new sign-in link.",
  signInWrongCode: 'That code is wrong or has expired.',
  signInTooMany: 'Too many wrong codes. Wait a minute and try again.',
  signInNoSession: 'No such signed-in browser.',
  cwdHoldsAgents: (dir, folder) =>
    `The working directory ${dir} holds or is inside ${folder}, where files decide how the agents run (the settings in your home folder, a CLI's own folder or its program). In edit mode agents change files there without asking, so they could get around their sandbox. Choose your project's folder instead, or read-only.`,
  protectedPattern: (path) =>
    `Harness Relay cannot protect ${path}: its name has *, ? or [, which the agents' sandboxes read as a pattern. Rename or move it, or use full access.`,
  grokSettingsChanged: (names) =>
    `Grok's own settings or program changed during this turn (${names}). A command the agent ran may have changed them: Harness Relay put them back (the changed ones are kept beside them, ending in .changed-…); look at the skills folder yourself. Look at these changes before you run Grok with full access.`,
  openNotImplemented: (cli) => `Harness Relay cannot run ${cli} yet: its adapter is not implemented yet. Use another agent for now.`,
  openNoModel: (cli) =>
    `${cli} has no model. Pick one for this member in the team editor, or set ${cli}'s default model in Settings, as "backend/model", such as openai/gpt-5.4-nano or homelab/muse-glimmer-30b-nvfp4.`,
  openBadModel: (cli, id) =>
    `${cli}'s model "${id}" is not "backend/model" (such as anthropic/claude-haiku-5-5, xai/grok-4.3, or your endpoint's id and a model name).`,
  openBackendMissing: (cli, backend, id) =>
    `${cli} is to use the model "${id}", but no ${backend} API key is set up. Add one under Settings → Model backends, or pick another model.`,
  openEndpointMissing: (cli, endpoint, id) =>
    `${cli} is to use the model "${id}", but there is no custom endpoint with the id "${endpoint}". Add it under Settings → Model backends, or pick another model.`,
  endpointDeleted: (cli, endpoint, id) =>
    `${cli} is to use the model "${id}", but its custom endpoint "${endpoint}" was deleted under Settings → Model backends. The turn did not run, and was not sent to ${cli}'s own service instead. Pick another model, or add the endpoint again; if "${id}" is a model of ${cli}'s own, forget "${endpoint}" under Settings → Model backends → Deleted endpoints.`,
  openNoHome: 'Harness Relay gave this agent no home of its own.',
  openNoWindowsSandbox: (cli) =>
    `On Windows, Harness Relay's sandbox cannot protect ${cli} yet, so it only runs with full access. Use full access (only in a folder you trust), or run Harness Relay in WSL.`,
  openSandboxUnavailable: (cli, reason) =>
    `Harness Relay's sandbox could not set up this run of ${cli} (it is needed below full access), so it did not run: ${reason}. See docs/sandboxing.md.`,
  openPrepareFailed: (cli, e) => `Could not write this run's settings into ${cli}'s home: ${e}`,
  openRefusedReadOnly: (cli) => `Not allowed in read-only mode; ${cli} was told to use tools that only read`,
  openToolNotRun: 'Not run',
  openStateNotEmptied: (cli, e) =>
    `The permission went up, so ${cli}'s folder for this member must be emptied before it runs, but it could not be (${e}); it did not run. Please try again.`,
  openStateShared: (cli, path) =>
    `${cli} did not run: it was to write in "${path}", which is not in this member's own folder, so other conversations' runs would read it. This is a fault of the ${cli} adapter; please report it.`,
  openToolNotFinished: 'Did not finish',
  openCannotResume: (cli) => `${cli} offers no way to resume a session (session/resume or session/load).`,
  openResumeFailed: (cli, e) => `${cli} could not resume the earlier session: ${e}`,
  openNoSession: (cli) => `${cli} returned no session id`,
  openCancelled: (cli, tool, reason) => `${cli} ended the turn while running "${tool}"${reason ? ` (${reason})` : ''}.`,
  openCancelledNoReason: (cli) => `${cli} ended the turn by itself (stopReason: cancelled) without giving a reason.`,
  openRefusal: (cli) => `${cli}'s model refused to answer this turn (stopReason: refusal).`,
  openRejectedMode: (cli, mode, e) => `${cli} does not accept the session mode "${mode}": ${e}`,
  openRejectedModel: (cli, model, e) => `${cli} does not accept the model "${model}": ${e}`,
  openRejectedEffort: (cli, effort, e) => `${cli} does not accept the reasoning effort "${effort}": ${e}`,
  openNativeNotYet: (cli) => `Harness Relay cannot list what ${cli} loads by itself yet.`,
  openNoLogin: (cli) => `${cli} needs no sign-in: it uses the API keys and endpoints under Settings → Model backends.`,
  openBackendsReady: (names) => `Model backends: ${names}`,
  openNoBackend: 'No model backend set up yet (Settings → Model backends)',

  // Goose (src/server/agents/goose.ts)
  gooseSessionNotChecked: (detail) =>
    `Harness Relay could not check the extension list Goose keeps for this session (${detail}), so it did not resume it: an earlier run's command could have added a program there that starts without asking. The turn starts a fresh session instead.`,
  gooseAuthFailed: (backend) => `Goose could not sign in with the ${backend} API key. Check that key under Settings → Model backends.`,
  gooseModelNotFound: (backend, model) => `${backend} has no model "${model}" (404). Pick another model in the member's settings.`,
  gooseUnreachable: (backend, host) => `Goose could not reach ${backend} (${host}). Check the network, or the endpoint's address under Settings → Model backends.`,
  // Pi (src/server/agents/pi.ts)
  piSessionMissing: (id) => `The file of session ${id} is gone (it may have been deleted)`,
  piSessionMoved: (then, now) => `the session's working directory is ${then}, this turn's is ${now}`,
  piSessionMismatch: (want, got) => `Pi opened session ${got}, not ${want}`,
  piGateMissing:
    "Harness Relay's gate extension did not load in Pi (it asks about every tool call before it runs), so this turn did not start. Check that src/server/agents/piGate.js is in Harness Relay's folder.",
  piGateWritable: (path) => `Harness Relay's gate extension (${path}) is inside a folder this turn may write, so Pi did not run. Pick another working directory.`,
  piModelMismatch: (want, got) => `Pi picked the model "${got}", not "${want}"`,
  piEffortLevels: (levels) => `this model takes: ${levels}`,
  piPromptRejected: (e) => `Pi did not take this turn's message: ${e}`,
  piKeyRejected: (backend, e) => `${backend} rejected the API key (${e}). Check it under Settings → Model backends.`,
  piModelRejected: (model, backend, e) => `${backend} has no model "${model}" it can use (${e}). Pick another model.`,
  piUnreachable: (backend, e) => `Could not reach ${backend}: ${e}`,
  piEndpointUnreachable: (name, url, e) => `Could not reach the endpoint "${name}" (${url}): ${e}. Check that the server is running and the address is right.`,
  piModelError: (e) => `The model reported an error: ${e}`,

  // Cline (src/server/agents/cline.ts)
  clineBadKey: (where, e) => `The model backend "${where}" refused Cline's API key: ${e}. Check the key in Settings → Model backends.`,
  clineBadModel: (model, where, e) => `The model backend "${where}" has no model "${model}" for Cline: ${e}. Pick a model this backend offers.`,
  clineUnreachable: (where, e) => `Cline cannot reach the model backend "${where}": ${e}. Check that the endpoint is running and its URL is right (Settings → Model backends).`,
  clineFailed: (e) => `Cline did not finish this turn: ${e}`,
  // OpenHands (agents/openhands.ts)
  openhandsSubagentRefused: "Not allowed below full access: OpenHands' subagents run commands and edit files without asking",
  openhandsNoSuchSession: 'its session folder holds no such session',
  openhandsBadKey: (backend) => `${backend} refused the API key OpenHands used (401). Check the key under Settings → Model backends.`,
  openhandsBadModel: (backend, model) => `${backend} has no model "${model}", or this key cannot use it. Pick another model for this member.`,
  openhandsUnreachable: (backend, e) => `OpenHands could not reach the model backend ${backend}: ${e}`,
  openhandsRateLimited: (backend, e) => `${backend} turned OpenHands' requests away for now (quota or rate limit): ${e}`,
  openhandsTerminal: (e) => `OpenHands could not start its terminal (tmux): ${e}`,
  openhandsFailed: (e) => `OpenHands did not finish this turn: ${e}`,
  openhandsNoCatalog: "LiteLLM's model list was not found in the OpenHands install",
  openhandsUnknownAction: 'Not allowed by itself: Harness Relay could not tell which OpenHands action this is',
  openhandsLeftover: (n) => `its session still holds ${n} action(s) left unfinished by an earlier turn (stopped or cut off), which must not run without asking`,
  openhandsAction: 'OpenHands action',
  openhandsBatchTitle: (title, more) => `${title} (+${more} more)`,
  openhandsBatch: (n, calls) => `One answer covers all ${n} actions:\n${calls.map((c) => `• ${c}`).join('\n')}`,
  openhandsNoTerminal:
    'Below full access OpenHands runs only with a terminal in the sandbox: turn on "Let OpenHands use a terminal in the sandbox: its commands can then read and write your other terminal windows" under Settings → OpenHands (its commands can then print text into your other terminal windows, read what you type there and change their settings, but still cannot type into them), or give this conversation full access.',
  openhandsStuck: 'OpenHands stopped this turn by itself: its stuck detector found it repeating the same action (or getting the same error) without getting anywhere. Ask again, put it differently, or pick another model for this member.',
  openhandsBatchRefused: 'Refused along with the rest of its batch: OpenHands asks once for all of them, and another one is not allowed',
  openhandsOddLog: "its session's history is not laid out as OpenHands writes it (something else may have changed it), so Harness Relay cannot tell which of its actions OpenHands would run without asking",
  openhandsNoEffort: (backend, model) => `${backend}'s model "${model}" takes no reasoning effort. Set this member's effort to none (or the default).`,
  openhandsSandboxRefusedReadOnly: "Harness Relay's sandbox refused it: this conversation is read-only.",
  openhandsSandboxProtected: "Harness Relay's sandbox refused it: this is a protected path, which Harness Relay keeps agents from reading (its own database and temporary files, browsers' data).",
  openhandsSandboxRefused: "Harness Relay's sandbox refused it: that is outside the folders this conversation may write.",
  openSandboxRefusedReadOnly: "Harness Relay's sandbox refused it: this conversation is read-only.",
  openSandboxRefused: "Harness Relay's sandbox refused it: that is outside the folders this conversation may write.",

  tooManyEndpoints: (n) => `At most ${n} custom endpoints can be set up.`,
  endpointNotFound: (id) => `No endpoint "${id}"`,
  deletedEndpointNotFound: (id) => `No deleted endpoint "${id}" is remembered`,
  endpointIdInvalid: (id) => `The endpoint id "${id}" may only hold lowercase letters, digits and - (not first or last; at most 32 characters).`,
  endpointIdReserved: (id) => `"${id}" is the name of a built-in model backend; give the endpoint another id.`,
  endpointNameMissing: 'Enter a name for the endpoint',
  endpointUrlInvalid: (url) => `"${url}" is not an endpoint address that can be used: it must start with http:// or https://, without a user name, password, query or #.`,
  endpointUrlRelay: (url) => `"${url}" is Harness Relay's own address; it cannot be a model endpoint.`,
  endpointModelsInvalid: (n, chars) => `At most ${n} model names, each at most ${chars} characters, without spaces.`,
  backendUnknown: (id) => `Unknown model backend: ${id}`,
  claudeReopens: (file, entry) =>
    `sandbox.filesystem in your Claude Code settings (${file}) lets its sandbox reach ${entry}, which opens paths Harness Relay protects (the browsers' folders or its database). Remove it and try again, or use full access.`,
  cwdHoldsVoice: (dir, voice, fromEnv) =>
    `The working directory ${dir} holds voice input's folder ${voice}, or is inside it${fromEnv ? ' (RELAY_VOICE_DIR)' : ''}. Harness Relay runs the voice engine there outside any sandbox, and in edit mode agents change files there without asking. Choose another folder, or read-only.`,
  cwdIsRelay: (dir) =>
    `The working directory ${dir} holds Harness Relay itself (its code or its data). In edit mode agents change files there without asking, so they could change Harness Relay's code or database and get around its sandbox and sign-in. Choose another folder, or read-only; to work on Harness Relay itself, run the copy you use from another folder.`,
  opencodeBackendError: (backend, e) =>
    `The model backend ${backend} answered with an error, so OpenCode could not finish the turn: ${e}. Check the API key, the endpoint's URL and the model name under Settings → Model backends.`,
  opencodeAuthRequired: (backend) => `OpenCode cannot use the model backend ${backend}: its API key is missing or was refused. Check it under Settings → Model backends.`,
  opencodeForeignControl: (detail) =>
    `Security problem, so this run was stopped: OpenCode's own server was driven by something other than Harness Relay (${detail}). A command the agent ran may have read its server's password. The sandbox's file and network rules still held; check what this turn did.`,
  opencodeNoLinuxSandbox:
    "On Linux, OpenCode runs only with full access: Harness Relay's sandbox gives it a network of its own, where Harness Relay cannot watch its server (needed below full access), so it did not run it. Use full access (only in a folder you trust), or another agent.",
  opencodeDatabaseNotChecked: (detail) =>
    `Harness Relay could not take out of OpenCode's database the permission rules an earlier run's command could have put there (${detail}), so it emptied this member's OpenCode state and did not resume the session. The turn starts a fresh session instead.`,
  opencodeWatchFailed: (e) => `Harness Relay cannot watch OpenCode's own server, so it did not run it (needed below full access): ${e}`,
  opencodeWriteRefused: (path) => `The sandbox does not allow writing ${path} (read-only, or outside the folders this run may write)`,

  shareEmpty: 'Nothing to share',
  shareTooLarge: (mb) => `This page is ${mb} MB, over the 1 MB that gistpreview can show. Share up to an earlier reply instead.`,
  shareNoGh: (min) => `GitHub CLI (gh) not found. Install ${min} or later from https://cli.github.com, run gh auth login in a terminal, then try again.`,
  ghTooOld: (min, version) =>
    `GitHub CLI (gh) is too old${version ? ` (this one is ${version})` : ''}: Harness Relay needs ${min} or later. Update gh from https://cli.github.com (installed with Homebrew: brew upgrade gh), then try again.`,
  shareSignedOut: 'GitHub CLI (gh) is not signed in. Run gh auth login in a terminal, then try again.',
  shareFailed: (detail) => `Could not create the gist: ${detail}`,
  shareNoDetail: 'gh gave no reason',
  shareNoUrl: 'gh did not return a gist address on github.com (gistpreview can only show gists on github.com). If a gist was created, find it with gh gist list and delete it',
  unshareFailed: (detail) => `Could not delete the gist: ${detail}`,
  unshareNotOwner:
    'The gist is still on GitHub, but it belongs to another account than the one gh is signed in to, so it could not be deleted. Switch back with gh auth switch, then remove it again.',
  shareNotFound: 'Share not found',
  shareNoFileUrl: 'GitHub returned no address for the uploaded files',
  shareNotGithub: 'the gist is not on github.com, the only place gistpreview can show gists from',
  shareBadFiles: 'The list of files to include is not valid',
  shareFileProblem: {
    missing: 'it is not there (or it is a folder)',
    outside: "it is outside this chat's folders (or in .git)",
  },
  shareFileTooLarge: (mb) => `it is larger than ${mb}`,
  shareFileRefused: (name, reason) => `Cannot include "${name}": ${reason}. Choose the files to include again, then try once more.`,
  shareFilesTooMany: (max) => `At most ${max} files can be included.`,
  shareFilesFailed: (detail) => `Could not upload the files to include: ${detail}`,
  shareBeingMade: 'This share is still being made: it can be removed once it is done.',
  shareFilesTooLarge: (mb, max) => `The files to include come to ${mb} MB, over the ${max} they may take in all.`,
  shareFilesUndone: (detail) => `Could not make the shared page (${detail}), so the files uploaded for it were deleted again. Try once more.`,
  shareFilesLeftover: (detail) =>
    `Could not make the shared page (${detail}), and could not delete the files uploaded for it either: they are still on GitHub, in a secret gist without the page. Remove it under Settings → Shared conversations.`,
  shareFilesUnknown: (detail, token) =>
    `Could not make the shared page (${detail}), nor tell whether the files went up. If GitHub has a gist whose description holds "${token}", find it with gh gist list and delete it.`,
  reportShotsNone: 'No screenshots to upload.',
  updateNone: 'There is no newer version to update to.',
  updateUnderWay: 'An update is already under way.',
  reportShotsTooMany: (max) => `At most ${max} screenshots can be uploaded.`,
  reportShotTooLarge: (n, mb) => `Screenshot ${n} is over the ${mb} MB limit.`,
  reportShotNotImage: (n) => `Screenshot ${n} is not a PNG, JPEG or WebP image.`,
  reportShotUnreadable: (n) => `Screenshot ${n} could not be read through, so its metadata could not be left behind: it is not uploaded. Take it again, or save it as a PNG and try again.`,
  reportShotsUndone: (detail) => `Could not upload the screenshots (${detail}), so the gist made for them was deleted again. Try once more.`,
  reportShotsLeftover: (detail, url) =>
    `Could not upload the screenshots (${detail}), and could not delete the gist made for them either: it is still on GitHub, at ${url}. Delete it there.`,
  reportShotsUnknown: (detail, token) =>
    `Could not upload the screenshots (${detail}), nor tell whether their gist was made. If GitHub has a gist whose description holds "${token}", find it with gh gist list and delete it.`,
  reportShotsNotGithub: 'gh is signed in to a host other than github.com: screenshots go only to gists on github.com',
  reportShotsNotFound: 'This upload is not known here (the server may have restarted since): delete its gist on GitHub.',
  messageNotFound: 'Message not found',
  branchTitle: (title) => `Branch · ${title}`,
  branchOnlyReply: "Only an agent's reply can be branched from",
  branchStreaming: 'A reply before this one is still being written; branch once it has finished',
  emptyMessage: 'The message cannot be empty',
  typeFirst: 'Type a message first',
  badAttachment: 'An attached file is malformed',
  tooManyAttachments: (n) => `You can attach up to ${n} files to one message`,
  attachmentTooLarge: (name, max) => `"${name}" is too large (limit ${Math.round(max / 1024 / 1024)} MB)`,
  attachmentNotFound: 'Attachment not found',
  mediaNotFound: 'Image or video not found (only images and videos in the working directory can be shown)',
  downloadNotFound: 'File not found (only files in the working directory can be downloaded)',
  busy: 'The team is still replying — wait or press Stop',
  busySettings: 'The team is replying; settings cannot be changed now',
  busyApply: 'The team is still replying — apply once it has finished',
  shuttingDown: 'The server is shutting down',
  noAgents: 'This conversation has no agents',
  runFailed: (msg) => `Run failed: ${msg}`,
  stoppedNote: 'Stopped.',
  queuedNotFound: 'That message was already delivered or withdrawn',
  queueFull: (n: number) => `Up to ${n} messages can wait to be delivered — wait for the team to reply`,
  gitInitNote: (root) => `The working directory was not a git repository; ran git init: ${root}`,
  dirLocked: (title, root) =>
    `Conversation "${title}" is changing ${root}; try again when it finishes (or use read-only / parallel mode).`,
  noWorktree: 'This member has no worktree',
  resultStale: 'The working directory has changed since; this result is out of date. Let the team run again.',
  appliedNote: (name, files) =>
    `Applied @${name}'s changes to the working directory (${files} files, not committed). The next parallel round starts from the new state.`,
  noChanges: 'This message changed no files',
  relayLimit: (hops) => `Reached the relay limit (${hops} hand-offs); back to you. Press Continue to let the team keep going.`,

  approvalNotFound: 'This request was already answered or has expired',
  approvalDeclined: 'The user declined this action.',
  retryAgentGone: (name) => `@${name} is no longer on the team, so this reply cannot be retried`,

  planNotFound: 'Team design not found',
  planNotSavable: 'Only a team the lead agent designed or adapted can be saved as a template',
  planFailed: (why) => `The lead agent did not produce a usable team design (${why}); using the default template instead.`,
  planUnparsable: 'no JSON team design found in the reply',
  planUnknownTemplate: (id) => `there is no template with id "${id}"`,
  planTemplateTooBig: (name, max) => `the template "${name}" has more members than a team may have (${max})`,
  planTemplateFits: (name) => `The lead agent found the template "${name}" a good fit for this question and uses it as it is.`,
  planFailedKept: (why) => `The lead agent did not produce a usable team design (${why}); keeping the current team.`,
  planKeepFits: 'The lead agent found the current team a good fit for this question too and keeps it as it is.',
  planNoCurrentTeam: 'this conversation has no team to keep yet',
  planAwaitingConfirm: 'Confirm the team the lead agent designed first; then the team answers',
  reviseEmpty: 'Say how the team should change first',
  reviseTooLong: (max) => `The request can be at most ${max} characters`,
  reviseStopped: 'Stopped changing the team',
  reviseFailed: (why) => `The lead agent could not change the team (${why}). The team is as it was; try saying it another way.`,

  scheduleNotFound: 'This conversation has no schedule',
  scheduleTextRequired: 'Type the message the schedule sends the team',
  scheduleTextTooLong: (max) => `A scheduled message can be at most ${max} characters`,
  scheduleBadRepeat: 'The schedule does not say when to repeat',
  scheduleBadTime: 'Times are HH:MM (24-hour clock)',
  scheduleNeedDays: 'Pick at least one day for a weekly schedule',
  scheduleBadHours: (max) => `The interval is a whole number of hours from 1 to ${max}`,
  scheduleBadMoment: 'Pick a date and time',
  scheduleInPast: 'That time has passed; pick a later one',
  scheduleBadTimeZone: (tz) => `Unknown time zone "${tz}"`,
  scheduleNeedsTeam: 'Confirm the team before you set a schedule',
  scheduleNoTeam: 'the team is not confirmed yet',
  scheduleWaitsForAnswer: 'the team is waiting for your answer',
  scheduleStillQueued: 'the previous scheduled message is still waiting to be delivered',
  scheduleBusy: 'The conversation is being updated; try again in a moment',
  scheduleQueueFull: 'the queue of waiting messages is full',
  scheduleRefused: 'Refused automatically: nobody may be watching a scheduled run',
  scheduleConvBusy: 'the conversation is busy with a settings change or an apply',
  scheduleMissedNote: (when) => `The scheduled message of ${when} was not sent: Harness Relay was not running then.`,
  scheduleSkippedNote: (when, why) => `The scheduled message of ${when} was not sent: ${why}.`,
  scheduleFailedNote: (when, why) => `The scheduled message of ${when} could not be sent: ${why}`,
  scheduleChatNote: (title) => `The schedule of "${title}" opened this conversation to send its message here.`,
  scheduleNoLead: 'The lead agent does not design the team in this conversation',
  scheduleHasTeam: 'This schedule has a team already',
  scheduleCreatedNote: 'Schedule created. The lead agent designs a team for its message; once the team is confirmed, the schedule sends it the message at the set times. Nothing runs now.',

  unknownProvider: (p) => `Unknown provider: ${p}`,
  dirNotFound: (cwd) => `Directory not found: ${cwd}`,
  keyringFailed: (e) => `Could not save the API key to the system credential store: ${e}`,
  noLogin: 'No sign-in in progress',
  unknownAccount: (provider, id) => `${provider} has no account ${id}`,
  tooManyAccounts: (provider, max) => `${provider} can have up to ${max} ${max === 1 ? 'account' : 'accounts'} (the default one included)`,
  badAccountLabel: (max) => `An account name has up to ${max} characters, on one line`,
  defaultAccountStays: 'The default account cannot be removed',
  accountBusy: 'A conversation is running, or the lead agent is sorting one into a group or changing a team. Wait until they finish (or stop the conversation, or close Team settings) before removing an account.',
  presetNameRequired: 'Enter a template name',
  otherGroup: 'Other',
  groupNameRequired: 'Enter a group name',
  groupNameTooLong: (max) => `A group name can be at most ${max} characters`,
  groupNameTaken: (name) => `There is already a group called "${name}"`,
  groupNotFound: 'Group not found',
  tooManyGroups: (max) => `You can have at most ${max} groups`,

  needAgent: 'At least one agent is needed',
  tooManyAgents: (max) => `At most ${max} ${max === 1 ? 'agent' : 'agents'}`,
  badName: (i, name) => `Agent ${i}'s name "${name}" is invalid: use letters, digits, _ or -, up to 32 characters`,
  reservedName: (name) => `"${name}" is a reserved name`,
  duplicateName: (name) => `The agent name "${name}" is used twice`,
  badProvider: (name) => `Agent "${name}" has an invalid provider`,
  badEffort: (name, effort) => `Agent "${name}" has an invalid reasoning effort "${effort}"`,
  cwdMissing: (cwd) => `Working directory not found: ${cwd}`,
  cwdNotDirectory: (cwd) => `Not a folder: ${cwd}`,
  cwdCreateFailed: (cwd, reason) => `Could not create the working directory ${cwd} (${reason})`,
  tooManyCwds: (max) => `At most ${max} working directories`,
  cwdTwice: (cwd) => `The working directory ${cwd} is listed twice`,
  pickFolderTitle: 'Choose a working directory',
  pickFolderNotHere: 'The folder dialog opens only on the computer that runs Harness Relay.',
  pickFolderMissing: 'This computer has no folder dialog to open (on Linux it takes zenity or kdialog).',
  pickFolderBusy: 'A folder dialog is open already: choose a folder there, or cancel it, first.',
  pickFolderFailed: (reason) => `Could not open the folder dialog (${reason})`,
  invalidField: (field) => `Invalid value for "${field}"`,
  agentHomeTooBroad: (dir) => `Use a folder of its own (for example ~/.relay-agents), not ${dir}`,
  agentHomeCreateFailed: (dir, reason) => `Could not create the folder ${dir} (${reason})`,
  agentHomeNotAbsolute: (dir) => `Enter a full path, or one that starts with ~ (for example ~/.relay-agents), not ${dir}`,
  agentHomeInside: (dir, folder) =>
    `${dir} is inside ${folder}: its snapshots would take in the CLIs' sign-ins and session records. Pick a place outside it, such as ~/.relay-agents`,
  agentHomeBusy: 'A conversation is running, or the lead agent is sorting one into a group or changing a team. Wait until they finish (or stop the conversation, or close Team settings) before changing the CLIs\' own folder.',
  agentsViewLinkInvalid: (url) => `Invalid address to open AgentsView: ${url}. Enter one that starts with http:// or https://, such as https://my-computer.tail1234.ts.net:9999`,
  agentsViewUrlInvalid: (url) =>
    `Invalid AgentsView address: ${url}. Only http(s) addresses on this computer are accepted, such as http://127.0.0.1:8080`,

  badMcpName: (name) => `Invalid MCP server name "${name}": use letters, digits, _ and - only, up to 40 characters`,
  badVarName: (name) => `Invalid or repeated name "${name}": use letters, digits, _, . and -, not starting with a digit`,
  mcpNeedsCommand: 'Enter the command to run',
  mcpNeedsUrl: 'Enter a URL starting with http:// or https://',
  mcpNotFound: (name) => `No MCP server named "${name}"`,
  mcpExists: (name) => `There is already an MCP server named "${name}"`,
  tooManyMcp: (n) => `You can set up at most ${n} MCP servers`,
  secretsFailed: (e) => `Could not save the MCP server's values to the system credential store: ${e}`,
  secretsUnreadable: (name) => `The values of MCP server "${name}" could not be read from the credential store (it may be locked): enter every value again, or unlock it and restart Harness Relay.`,
  memoryTooLong: (n) => `Memory can be at most ${n} characters`,
  tooManySkills: (n) => `You can add at most ${n} skills`,
  noSkillsIn: (path) => `No skills in ${path} (pick a folder with a SKILL.md, or a folder of such folders)`,
  skillMissing: 'SKILL.md not found',
  skillDuplicate: (name) => `Another skill is already named "${name}"; agents do not get this one`,

  nativeTimeout: (cli) => `${cli} did not answer in time.`,
  nativeFileNotListed: 'This file is not one the CLI reported, or it no longer exists.',
  grokTrustFailed: (e) => `Could not record Grok's trust in this folder: ${e}`,
  grokTrustNotTaken: (dir) =>
    `After trust in ${dir} was recorded, Grok still reported the folder as untrusted (an organisation policy may prevent it), so the change was undone.`,
  grokTrustFolderChanged: (dir) => `Grok now decides trust for ${dir}, not the folder you confirmed. Please confirm again.`,
  nativeFailed: (cli, detail) => `${cli} reported an error: ${detail}`,
  nativeNoAnswer: (cli, part) =>
    part === 'all'
      ? `${cli} did not answer.`
      : `${cli} did not report its ${{ skills: 'skills', mcp: 'MCP servers', tools: 'built-in tools', hooks: 'hooks', agents: 'subagents', plugins: 'plugins' }[part]}.`,
  nativeAsRunFailed: (cli, detail) => `Asking ${cli} again the way Harness Relay starts it failed, so what is left out is not marked: ${detail}`,
  nativeAsRunPartial: (cli) => `Asking ${cli} again the way Harness Relay starts it ran out of time: what it had answered is marked, the rest is not.`,

  fileNotFound: 'File or folder not found (only what is inside the working directory can be browsed)',
  zipTooBig: (items, gb) => `This folder is too large for a ZIP file: at most ${items.toLocaleString('en')} files and folders, ${gb} GB in all. Download a folder inside it instead.`,
  fileRootNotFound: 'This folder no longer exists',

  gitFailed: (cmd, out) => `git ${cmd} failed: ${out}`,
  noAutoRepo: (dir) => `Will not create a git repository in ${dir}; pick a project folder as the working directory.`,
  repoTooBroad: (root) =>
    `The working directory is inside the git repository at ${root}, which is too broad (every turn records the state of the whole folder). Pick a project folder, or run git init in the project folder.`,
  outputTooLarge: (cmd) => `The output of git ${cmd} is too large to handle`,
  nothingToApply: 'Nothing to apply',
  applyConflict: (detail) =>
    `Files in the working directory conflict with these changes; nothing was applied:\n${detail}\nAsk an agent to redo the work on top of the current directory, or merge the branch by hand.`,

  planDetail: (plan) => `Plan: ${plan}`,
  defaultModelDetail: (model) => `Default model: ${model}`,
  logoutFailed: (code) => `logout failed (exit ${code})`,
  codexLoginFailed: (code) => `codex login failed (exit ${code})`,
  codexModelsFailed: 'codex debug models failed',
  grokModelsEmpty: 'grok models returned no models',
  cursorModelsFailed: 'cursor-agent returned no model list',
  antigravityModelsFailed: 'agy models returned no models',
  copilotModelsFailed: 'Copilot returned no models',
  voiceNotReady: 'Voice input is not set up yet. See Settings → Voice input.',
  voiceBusy: 'Voice input is being installed. Wait for it to finish, or cancel it first.',
  voiceNoJob: 'No install is running',
  voiceNeedsHomebrew:
    'On macOS whisper.cpp is installed with Homebrew, but brew was not found. Install Homebrew (https://brew.sh) first, or install whisper.cpp yourself and set the path to whisper-server below.',
  voiceNoBuild: (platform) =>
    `whisper.cpp has no prebuilt engine for ${platform}. Install whisper.cpp yourself, then set the path to whisper-server below.`,
  voiceBinNotFound: (bin) => `whisper-server not found: ${bin}`,
  voiceDownloadFailed: (name, detail) => `Downloading ${name} failed: ${detail}`,
  voiceChecksumMismatch: (name) => `${name} did not match its expected contents (SHA-256) and was deleted. Please try again.`,
  voiceExtractFailed: (detail) => `Unpacking whisper.cpp failed: ${detail}`,
  voiceBrewFailed: (detail) => `brew install whisper-cpp failed: ${detail}`,
  voiceEngineBroken: (detail) => `whisper-server does not run: ${detail}`,
  voiceServerFailed: (detail) => `The speech-recognition engine did not start: ${detail}`,
  voiceTranscribeFailed: (detail) => `Speech recognition failed: ${detail}`,
  voiceBadAudio: 'The recording could not be read (it must be WAV).',
  voiceTooLong: (seconds) => `The recording is too long: at most ${seconds} seconds at a time.`,
  voiceModelBusy: 'This model is being downloaded and cannot be deleted.',
  voiceNoSpace: (need, free) => `Not enough disk space: about ${need} is needed, ${free} is free.`,
  voiceCancelled: 'Install cancelled',
  login: {
    claudeSubscription: ['Claude subscription', 'Sign in with a Claude Pro / Max account. Open the link, authorise, then paste back the code the page shows.'],
    claudeConsole: ['Anthropic Console', 'Sign in with a Console account (billed by API usage).'],
    codexDevice: ['ChatGPT device code', 'Open the link, sign in to ChatGPT and enter the one-time code below.'],
    codexBrowser: ['ChatGPT browser sign-in', 'Opens a browser on this computer to sign in (needs a localhost callback).'],
    grokDevice: ['xAI device code', 'Open the link and confirm the code below.'],
    grokBrowser: ['xAI browser sign-in', 'Opens a browser on this computer to finish the OAuth sign-in.'],
    cursorBrowser: ['Cursor account', 'Open the link below in a browser on any device, sign in to Cursor and allow the CLI.'],
    antigravityGoogle: ['Google account', 'Open the link below in a browser on any device, sign in to Google, then paste back the code the page shows (or its whole address).'],
    copilotDevice: ['GitHub account (device code)', 'Open the GitHub link below in a browser on any device, enter the code shown, and authorize it.'],
  },
};

const MESSAGES: Record<Lang, ServerMessages> = { 'zh-TW': zhTW, en };

/** Messages in the language of the current request or run. */
export function t(): ServerMessages {
  return MESSAGES[currentLang()];
}

/** The default group's name in any language: no group may be called that. */
export function isOtherGroupName(name: string): boolean {
  return LANGS.some((l) => MESSAGES[l].otherGroup.toLowerCase() === name.toLowerCase());
}

/** Titles a conversation gets before its first message, in any language. */
export function isDefaultTitle(title: string): boolean {
  return LANGS.some((l) => MESSAGES[l].defaultTitle === title);
}

/** The title a branch of the conversation called `fromTitle` gets when it is made, in any language. */
export function isBranchTitle(title: string, fromTitle: string): boolean {
  return LANGS.some((l) => MESSAGES[l].branchTitle(fromTitle).slice(0, 200) === title);
}
