import { AsyncLocalStorage } from 'node:async_hooks';
import type { FileNameProblem } from '../shared/fileNames';
import type { CliInstallBlock, OAuthUse, Permission } from '../shared/types';
import { FIXED_COMMAND_NEWS, LANGS, type FixedCommandRun, type Lang } from '../shared/types';

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

/** A provider account is managed in its app row. A library MCP server signs in on its own row. */
function signInSettings(lang: Lang, use?: OAuthUse): string {
  if (!use) return lang === 'en' ? 'Settings → Apps and tools → Tool library → MCP servers' : '設定 → App 與工具 → 工具庫 → MCP 伺服器';
  const name = {
    mail: lang === 'en' ? 'Mail' : '郵件',
    calendar: lang === 'en' ? 'Calendar' : '行事曆',
    drive: 'Google Drive',
    documents: 'Google Drive',
    teams: 'Microsoft Teams',
  }[use];
  return lang === 'en' ? `Settings → Apps and tools → Common apps → ${name}` : `設定 → App 與工具 → 常用 App → ${name}`;
}

/** A fence for `text` in a message: one backtick more than its longest run of them, three at least. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const mark = '`'.repeat(longest + 1);
  return `${mark}\n${text}\n${mark}`;
}

/** How a fixed command's run went, in a line (zh-TW). */
function runLineZh(run: FixedCommandRun): string {
  const why = run.reason ? `：${run.reason}` : '';
  switch (run.status) {
    case 'running':
      return '執行中';
    case 'passed':
      return '完成（結束碼 0）';
    case 'news':
      return `完成，有新的內容（結束碼 ${FIXED_COMMAND_NEWS}）`;
    case 'failed':
      return `失敗（結束碼 ${run.exitCode ?? '?'}）${why}`;
    case 'changed':
      return `沒有執行：儲存之後，它的程式碼改過了（${(run.changed ?? []).slice(0, 5).join('、')}${(run.changed?.length ?? 0) > 5 ? '…' : ''}）。請在它的卡片上檢查變更再試跑。`;
    default:
      return `無法執行${why}`;
  }
}

/** How a fixed command's run went, in a line (English). */
function runLineEn(run: FixedCommandRun): string {
  const why = run.reason ? `: ${run.reason}` : '';
  switch (run.status) {
    case 'running':
      return 'running';
    case 'passed':
      return 'done (exit code 0)';
    case 'news':
      return `done, with something new (exit code ${FIXED_COMMAND_NEWS})`;
    case 'failed':
      return `failed (exit code ${run.exitCode ?? '?'})${why}`;
    case 'changed':
      return `not run: its code changed since it was saved (${(run.changed ?? []).slice(0, 5).join(', ')}${(run.changed?.length ?? 0) > 5 ? '…' : ''}). Check the changes on its card, then try it again.`;
    default:
      return `could not run${why}`;
  }
}

const zhTW = {
  handoffs: {
    storage: '這台電腦沒有可用的憑證儲存區，無法保存密鑰。',
    badName: (name: string) => `「${name}」不是有效的密鑰名稱：只能用大寫英文字母、數字和底線，而且不能以數字開頭。`,
    badValue: (name: string, problem: 'empty' | 'long' | 'lines') =>
      problem === 'empty' ? `${name} 是空的。` : problem === 'long' ? `${name} 太長了（最多 16 KB）。` : `${name} 不能有換行。`,
    tooManySecrets: (n: number) => `一個工作目錄最多保存 ${n} 個密鑰。`,
    secretNotFound: (name: string) => `這個工作目錄沒有叫 ${name} 的密鑰。`,
    commandNotFound: '找不到這個固定指令，可能已經刪除了。',
    tooManyCommands: (n: number) => `一個工作目錄最多保存 ${n} 個固定指令。`,
    tooManyFiles: (n: number) => `這個資料夾的程式碼和設定檔超過 ${n} 個，無法鎖定固定指令的程式碼。`,
    windows: '固定指令要在 Harness Relay 自己的沙箱裡執行，原生 Windows 上還沒有這個沙箱。',
    missingSecrets: (names: string) => `還沒有提供這些密鑰：${names}。`,
    inputTooLong: (n: number) => `要交給指令的輸入太長了（最多 ${Math.round(n / 1024)} KB）。`,
    timedOut: (min: number) => `執行超過 ${min} 分鐘，已經停止。`,
    hostsRefused: (hosts: string) => `沙箱擋下了它要連的主機：${hosts}。需要的話，請把這些主機加進這個固定指令。`,
    networkRefused: '沙箱擋下了它的網路連線。',
    sandboxRefused: '沙箱擋下了它要做的事（例如寫到工作目錄以外）。',
    noCommand: (name: string) => `這個工作目錄沒有叫「${name}」的固定指令，所以沒有放進待送出匣。`,
    outboxTitle: (name: string) => `執行一次固定指令「${name}」`,
    fieldCommand: '指令',
    fieldFolder: '資料夾',
    fieldHosts: '可連的主機',
    cardNotFound: '找不到這張卡片。',
    cardDecided: '這張卡片已經回覆過了。',
    noValues: '請至少填一個值，或選擇不提供。',
    badCommand: '這個固定指令的內容無效：請檢查名稱、指令、主機和密鑰名稱。',
    commandRunning: '這個固定指令正在執行，請等它結束。',
    commandDismissed: (name: string) => `我不儲存固定指令「${name}」。`,
    commandAnswer: (name: string, run?: FixedCommandRun) =>
      run
        ? `我已儲存固定指令「${name}」並試跑了一次：${runLineZh(run)}。${run.output ? `\n\n輸出（密鑰已遮蔽）：\n${fenced(run.output)}` : ''}`
        : `我已儲存固定指令「${name}」。`,
    secretsAnswer: (saved: string[], declined: string[]) =>
      [
        saved.length ? `我已提供 ${saved.join('、')}，它存在這個工作目錄的憑證儲存區，只會交給列出它的固定指令。` : '',
        declined.length ? `我現在不提供 ${declined.join('、')}。` : '',
      ]
        .filter(Boolean)
        .join(''),
    notKept: (why: string) => `它寫回的新值沒有保存：${why}`,
    commandChangedSince: (name: string) => `固定指令「${name}」在這次執行放進待送出匣之後改過了，所以沒有執行。`,
    runLine: runLineZh,
  },
  publish: {
    unreachable: (host: string) => `無法連到 ${host}，或它的回應無法讀取。請稍後再試。`,
    badAnswer: '雲端服務的回應不是預期的格式。',
    renderKey: 'Render API 金鑰無效或已失效。請在 Render 的 Account settings → API Keys 建立一把，再貼上。',
    renderPayment: 'Render 要求這個工作區先加上付款資訊，才能建立服務。',
    renderScope: (scope: string) =>
      `Render API 金鑰缺少發布需要的權限${scope ? `（${scope}）` : ''}。請在 Render 的 Account settings → API Keys 建立一把，權限選 Services「Read & write」、它的環境變數「Write」、Deploys「Run」，再貼到這裡取代它。`,
    renderNoOwner: '這把 Render 金鑰沒有可用的工作區。',
    rateLimited: (host: string) => `${host} 暫時限制了請求次數。請稍等一下再試。`,
    renderFailed: (detail: string) => `Render 拒絕了這個請求：${detail}`,
    repoAccess: (link: string) =>
      `Render 讀不到這個 GitHub 儲存庫。請讓 Render 的 GitHub App 能存取它（所有儲存庫，或加入這一個）：${link}，然後再發布一次。`,
    renderName: (name: string) => `Render 上已經有叫做「${name}」的服務。請換一個名稱。`,
    serviceGone: '這個應用程式在 Render 上的服務已被刪除。請先取消發布，再重新發布。',
    neonKey: 'Neon API 金鑰無效或已失效。請在 Neon 建立一把個人 API 金鑰（帳號選單 → Settings → Personal API keys），再貼上。',
    neonFailed: (detail: string) => `Neon 無法建立或讀取資料庫：${detail}`,
    workspace: '這個 npm workspace 成員的資料夾名稱無法用在 Render 的指令裡。',
    onlyDatabase: '這個 compose 檔只執行資料庫，沒有可以發布的應用程式服務。',
    composeService: (name: string) =>
      `Render 的免費方案只執行一個服務，而這個 compose 檔還有「${name}」。只有一個應用程式服務加上 PostgreSQL 的 compose 檔可以發布。`,
    composeBuild: (name: string) => `服務「${name}」沒有 build：Render 要從這個專案的 Dockerfile 建置它。`,
    composeBuildOptions: (name: string) => `服務「${name}」的 build 用了 build 參數、target 或內嵌的 Dockerfile，Render 的建置不支援。`,
    composeMounts: (name: string) => `服務「${name}」掛載了專案檔案；Render 只從 Dockerfile 建置映像，那些檔案不會在裡面。`,
    composeEntrypoint: (name: string) => `服務「${name}」改寫了 entrypoint，Render 不支援。請改在 Dockerfile 裡設定。`,
    noGh: '發布需要 GitHub CLI（gh），用來建立私人儲存庫並推送檔案。',
    github: (detail: string) => `GitHub 沒有完成這個請求：${detail || '沒有說明'}`,
    repoExists: (name: string) => `你的 GitHub 帳號已經有名為「${name}」的儲存庫。請換一個名稱。`,
    push: (detail: string) => `無法把檔案推送到 GitHub：${detail || '沒有說明'}`,
    otherWorkspace: (name: string) =>
      `「${name}」發布在另一個 Render 工作區，目前的金鑰碰不到它。請改用能存取那個工作區的金鑰，再更新或取消發布。`,
    databasesChanged: '這個應用程式的資料庫和上次發布時不同（例如 compose 檔多了 PostgreSQL 服務）。請先取消發布，再重新發布。',
    initMeta: (name: string, command: string) =>
      `${name} 用了 psql 自己的指令（${command}）。Relay 只把初始化腳本當成一般的 SQL 送到 Neon 執行，所以請改成只有 SQL 的腳本。`,
    initSize: (name: string, kb: number) => `${name} 超過 ${kb} KB，太長了，無法當成初始化腳本執行。`,
    initBinary: (name: string) => `${name} 含有 NUL 位元組，不是可以執行的 SQL 文字。`,
    initTransaction: (name: string, statement: string) =>
      `${name} 有 ${statement}。Relay 把每個初始化腳本當成一個 transaction 執行，自己結束 transaction 或無法在 transaction 裡執行的陳述式都不支援。`,
    initChanged: (name: string) => `${name} 在它已經於資料庫上執行之後改變了。要重新執行，請取消發布並勾選刪除資料庫，再重新發布。`,
    initFailed: (name: string, detail: string) => `在 Neon 上執行 ${name} 失敗：${detail || '沒有說明'}`,
    storage: '無法存取這台電腦的憑證儲存區，金鑰無法保存。',
    interrupted: 'Harness Relay 在發布途中停止了。請再發布一次。',
    setupRender: '請先在 設定 → 發布到雲端 設定 Render 的 API 金鑰與工作區。',
    setupNeon: '這個應用程式需要資料庫：請先在 設定 → 發布到雲端 設定 Neon 的 API 金鑰與組織。',
    notFound: '找不到這個已發布的應用程式。',
    confirmPublic: '請先確認：任何拿到網址的人都能開啟這個應用程式。',
    busy: '這個應用程式正在發布中。',
    tooMany: '同時進行的發布太多了。請等其中一個完成。',
    name: '名稱只能有小寫英文字母、數字和連字號，最多 40 個字元，且不能以連字號開頭或結尾。',
    nameTaken: (name: string) => `已經有一個叫「${name}」的已發布應用程式。`,
    kindChanged: '這個資料夾的應用程式類型改變了（例如從靜態網站變成後端），Render 無法直接轉換。請先取消發布，再重新發布。',
    deployFailed: (status: string) => `Render 的部署沒有成功（${status}）。請到 Render 查看建置記錄。`,
    failed: '發布失敗。',
    notReady: '請等預覽的頁面成功開啟，確認沒問題後再發布。',
    changed: '預覽開始後，這個資料夾的檔案已經改變。請重新建置預覽並確認後再發布。',
  },
  previewDocker: {
    invalidLock: 'npm 專案或鎖定檔格式無效。',
    standalone: '預覽不支援巢狀的 npm 工作區。',
    workspaceLock: '工作區根目錄的 package-lock.json 沒有列出這個專案。請在工作區根目錄執行 npm install 更新鎖定檔。',
    spec: '預覽的相依套件必須指定公開 npm registry 的版本。',
    lock: '應用程式預覽需要 npm 的 package-lock.json。',
    lockSync: (name: string) => `package.json 中的 ${name} 不在 package-lock.json 裡。請執行 npm install 更新鎖定檔，再重試預覽。`,
    config: '預覽不支援自訂 npm 設定或 npm-shrinkwrap.json。',
    lockVersion: '預覽需要第 2 或第 3 版的 npm 鎖定檔。',
    manifest: '應用程式預覽需要 package.json。',
    script: (name: string) => `預覽需要 package.json 中的 ${name} 指令碼。`,
    count: '預覽鎖定的套件過多。',
    tarball: '預覽只接受來自公開 npm registry 且含有 SHA-512 校驗值的標準套件封存檔。',
    downloadSize: '預覽鎖定套件超出下載大小上限。',
    integrity: '預覽鎖定套件未通過 SHA-512 完整性檢查。',
    missing: '這台執行 Relay 的電腦找不到 Docker CLI。',
    manual: 'Relay 未提供此系統的自動安裝方式。請在執行 Relay 的電腦安裝可執行 Linux x64 或 arm64 容器的 Docker。',
    existing: (path: string) => `在 ${path} 找到了應用程式，但找不到 Docker CLI。請檢查現有的安裝。`,
    launchFailed: 'Docker Desktop 未啟動。請在 Relay 電腦查看安裝紀錄及簽章檢查結果。',
    openDesktop: '請在 Relay 電腦手動開啟 Docker Desktop 並完成初始設定。',
    linuxAccess:
      'Relay 的帳號無法存取 Docker 通訊端。請為這個帳號設定 rootless Docker，或請管理員授予存取權。變更群組後，請登出、重新登入，再重新啟動 Relay。',
    noWinget: '請在 Relay 電腦安裝 Microsoft App Installer 以使用 WinGet，或手動安裝 Docker Desktop。',
    startEngine: '無法連上本機 Docker 引擎。請在這台電腦啟動 Docker Desktop 並完成設定，或啟動 Docker Engine 服務。',
    permission: 'Relay 的使用者無權存取本機 Docker 通訊端。請以此帳號設定可使用的本機引擎。',
    local: '目前選用的 Docker 連線不是本機通訊端。請在 Relay 電腦選擇使用 Unix 通訊端或 Windows 本機具名管道的 Docker 環境。',
    arch: '預覽需要 Docker 搭配 Linux x64 或 arm64 容器。',
    invalidDocker: 'Docker 傳回無效的容器識別碼。',
    invalidOwner: '預覽擁有者識別碼無效。',
    containerCount: '預覽容器過多，無法完整列出。',
    distSize: '預覽建置輸出超出大小上限。',
    invalidFile: '預覽檔案路徑無效。',
    dist: '建置必須產生 dist/index.html。',
    invalidOutput: '預覽建置輸出格式無效。',
    headers: '預覽請求的標頭過大。',
    body: '預覽請求本文超過 1 MiB。',
    invalidResponse: '預覽回應格式無效。',
    responseSize: '預覽的 HTTP 回應過大。',
    exited: '預覽伺服器已結束。',
    context: 'Docker 環境',
    remove: '移除預覽容器',
    find: '尋找預覽容器',
    engine: '本機 Docker 引擎',
    pull: '下載指定的預覽映像檔',
    create: '建立預覽容器',
    start: '啟動預覽容器',
    limits: '檢查 Docker 資源限制',
    copy: '複製預覽檔案',
    ci: '安裝預覽鎖定的相依套件',
    build: '建置預覽',
    collect: '收集 dist 輸出',
    server: '啟動預覽伺服器',
    ready: '等候預覽伺服器',
    http: '預覽 HTTP 請求',
    failed: (step: string) => `${step}失敗。`,
    timeout: (step: string) => `${step}逾時。`,
    fetch: (url: string, status: number) => `無法下載鎖定套件 ${url}（HTTP ${status}）。`,
    composeMissing:
      '預覽 Dockerfile 或 compose 專案需要 Docker Compose v2，這台電腦的 Docker 沒有它。請安裝 Docker Desktop，或在 Linux 安裝 docker-compose-plugin。',
    imageBuild: (service: string) => `建置 ${service} 的映像檔`,
    mountCopy: (service: string) => `複製 ${service} 掛載的專案檔案`,
    composeUp: '啟動預覽服務',
    composeDown: '移除預覽服務',
    inspect: '讀取預覽容器狀態',
    attach: '連接應用程式的終端機',
    notRunning: '應用程式目前沒有在執行。',
    buildxMissing:
      '建置 Dockerfile 需要 Docker buildx，這台電腦的 Docker 沒有它。請安裝 Docker Desktop，或在 Linux 安裝 docker-buildx-plugin。',
    builder: '準備預覽專用的建置器',
    builderEndpoint: (name: string) => `建置器 ${name} 指向另一個 Docker 引擎。請用 docker buildx rm ${name} 移除它，再重試預覽。`,
    imagePull: (image: string) => `下載 ${image}`,
    runBusy: '應用程式正在啟動，請稍候再執行。',
    runFailed: '這次預覽已失敗或已停止。請重建預覽。',
  },
  previewCompose: {
    yaml: (detail: string) => `無法讀取 compose 檔：${detail}`,
    tooLarge: 'compose 檔超過 256 KB。',
    noServices: 'compose 檔沒有可以執行的服務。',
    tooMany: (max: number) => `預覽最多執行 ${max} 個服務。`,
    invalid: (where: string) => `compose 檔的 ${where} 格式無效。`,
    refused: (key: string) => `預覽不支援 compose 檔的 ${key}：它會接觸到主機或其他容器。`,
    remote: (where: string) => `預覽不支援 ${where} 指向網址或 Git 儲存庫的建置內容。`,
    outside: (where: string, path: string) => `${where} 的 ${path} 在專案資料夾之外。預覽只使用專案內的檔案。`,
    missingFile: (path: string) => `專案裡找不到 ${path}。`,
    undeclaredVolume: (service: string, volume: string) => `${service} 使用的 volume ${volume} 沒有在最上層的 volumes 宣告。`,
    serviceName: (name: string) => `服務名稱 ${name} 無效或保留給 Relay。`,
    noImage: (service: string) => `${service} 需要 image 或 build。`,
    unknownDependency: (service: string, dependency: string) => `${service} 依賴的服務 ${dependency} 不存在或沒有執行。`,
    interpolation: (text: string) => `compose 檔的變數 ${text} 格式無效。`,
    required: (variable: string, message: string) =>
      `compose 檔需要變數 ${variable}${message ? `（${message}）` : ''}，但預覽不從主機或 .env 帶入變數。`,
    mountSkipped: (service: string, source: string, target: string) =>
      `Relay 略過 ${service} 的掛載 ${source} → ${target}：專案快照裡沒有它（相依套件、.env 與資料庫檔不會複製）。`,
    envFileSkipped: (service: string) => `Relay 略過 ${service} 的 env_file：預覽不帶入 .env 這類檔案。`,
    profileSkipped: (service: string) => `Relay 略過 ${service}：它屬於 compose profile，預設不會啟動。`,
  },
  previewFolderChanged: '工作目錄已變更。請重新開啟檔案並確認要預覽的資料夾。',
  previewTarget: '找不到選定的預覽入口，或路徑不在工作目錄內。',
  previewFolderEntry: '請選擇工作目錄內含有 index.html、package.json、Dockerfile 或 compose.yaml 的資料夾，或直接預覽 HTML 檔案。',
  previewNoWay: '它沒有 Dockerfile、compose 檔、有 start 或 build 指令碼的 package.json，也沒有首頁 HTML。',
  previewNotReady: (shown: string, reason: string) => `${shown} 的應用程式還無法預覽：${reason}`,
  previewManifestLimit: 'package.json 太大，無法判斷預覽指令。請選擇較小的專案或已建置的 HTML 頁面。',
  previewProjectEntry:
    '這個資料夾沒有預覽的做法。請加上 Dockerfile（需要資料庫時加上 compose.yaml），或在 package.json 加入 start 或 build 指令碼，或選擇可直接開啟的 HTML 頁面。',
  previewOrigin: '請從 Harness Relay 的介面開啟預覽。',
  previewRemote: '遠端預覽需要專用的 HTTPS 網域。請設定 RELAY_PREVIEW_DOMAIN，或從本機開啟。',
  previewBusy: '預覽正在啟動或已達數量上限，請稍後再試。',
  previewFailed: '無法啟動預覽。',
  previewServiceFailed: '預覽伺服器沒有回應。請重建預覽並檢查啟動訊息。',
  previewCookie: '無法驗證預覽。請重新開啟預覽，並確認瀏覽器允許這個內嵌頁面的分區 Cookie。',

  // Runs and adapters
  stopped: '已停止',
  timedOut: '執行逾時',
  exitedWithoutReply: (cli: string, code: number | null) => `${cli} 結束（exit ${code}）但沒有回應`,
  exitedWithoutTurn: (cli: string, code: number | null) => `${cli} 結束（exit ${code}）但沒有完成回合`,
  codexMcpListFailed: (detail: string) =>
    `Codex 無法列出它的 MCP 伺服器，因此無法在這次執行中不載入它們或它們的工具（${detail}）。請更新 Codex，或在「設定」裡 Codex 的「這個 CLI 自己載入的…」中，取消「MCP 工具」分頁的不載入勾選。`,
  codexLeftOutUnchecked: (detail: string) =>
    `無法確認 Codex 在這次執行中沒有載入設為不載入的 skill、hook 或 plugin（${detail}），所以沒有執行。請再試一次，或在「設定」裡 Codex 的「這個 CLI 自己載入的…」中取消這些不載入勾選。`,
  copilotHooksUnchecked: '無法確認 Copilot 已載入團隊的 hook，因此未開始這個回合。',
  codexHookShell: 'Codex 的團隊 hook 需要 POSIX shell，PowerShell 帳號的這個回合未開始。',
  codexHooksUnprotected: 'Codex 的編輯沙箱無法保護團隊的 hook 程式，因此未開始這個回合。',
  codexHooksUnchecked:
    '無法確認 Codex 已載入並信任團隊的 hook，因此未開始這個回合。請確認 Codex 已啟用 hook 並更新到 0.167.0 或以上，再試一次。',
  codexNoProfile: (active: string | undefined) =>
    `Codex 沒有在 Harness Relay 給它的權限設定檔中執行這個 thread（它回報的是${active ? `「${active}」` : '沒有設定檔'}，可能是不認得這個欄位的舊版 Codex），它的沙箱就擋不住你瀏覽器的資料夾與 Harness Relay 的資料庫，所以沒有執行。請更新 Codex（0.167 可以）再試一次。`,
  codexStillLoaded: (parts: ('skills' | 'hooks' | 'plugins')[]) =>
    `Codex 仍載入了設為不載入的${parts.map((p) => ` ${p === 'skills' ? 'skill' : p === 'hooks' ? 'hook' : 'plugin'}`).join(' 與')}（可能是不認得這項設定的舊版 Codex）。請更新 Codex，或在「設定」裡 Codex 的「這個 CLI 自己載入的…」中，取消${parts.map((p) => `「${p === 'skills' ? 'Skills' : p === 'hooks' ? 'Hooks' : 'Plugins'}」`).join('與')}分頁的不載入勾選。`,
  claudePluginsFailed: (detail: string) =>
    `Claude Code 無法列出它的 plugin，因此無法在這次執行中不載入它們（${detail}）。請更新 Claude Code，或在「設定」裡 Claude Code 的「這個 CLI 自己載入的…」中，取消「Plugins」分頁的「全部不載入」。`,
  claudeAgentsFailed: (detail: string) =>
    `無法讓 Claude Code 在這次執行中不載入它自己的 subagent（${detail}）。請更新 Claude Code，或在「設定」裡 Claude Code 的「這個 CLI 自己載入的…」中，取消「Subagents」分頁的「全部不載入」。`,
  claudeError: 'Claude Code 回報錯誤',
  claudeBudgetReached: (usd: number) =>
    `這一輪已用到這位成員的上限 US$${usd}（Claude Code 自己估的費用），所以 Claude Code 停了下來。要讓它做得更多，請在團隊設定中提高或拿掉這位成員的上限。`,
  claudeSandbox: (why: string) =>
    `Claude Code 無法啟動它的沙箱（完全存取以外的權限都需要）：${why}。在 Linux 與 WSL2 上請安裝 bubblewrap 與 socat（例如 sudo apt-get install bubblewrap socat），Ubuntu 23.10 以後還需要給 /usr/bin/bwrap 的 AppArmor 設定檔（見 docs/sandboxing.zh-TW.md 的「在 Linux 上」），再試一次；或把權限改成「完全存取」，在沙箱外執行。`,
  sandboxHost: '沙箱中的指令想連到這個主機。',
  commandNotFound: (bin: string) => `找不到指令「${bin}」。請確認已安裝，或在「設定」頁指定執行檔路徑。`,
  windowsShimBroken: (bin: string, script: string, target: string) =>
    `「${bin}」是 ${script}，它執行的 ${target} 不在了：請重新安裝 ${bin}。`,
  windowsNoNode: (bin: string, script: string) =>
    `「${bin}」是 ${script}，它要用 Node.js 執行，但 PATH 上找不到 Node.js：請安裝 Node.js，或把它加到 PATH。`,
  windowsScript: (bin: string, script: string) =>
    `「${bin}」是腳本 ${script}，Harness Relay 無法啟動它：它只啟動程式，從不透過 shell，而且讀不出這個腳本執行的是哪個程式。請在「設定」頁把執行檔路徑改成它執行的程式（.exe）。`,
  permission: { 'read-only': '唯讀', edit: '可編輯', full: '完全存取' } as Record<Permission, string>,
  grokRefusedReadOnly: '唯讀模式不允許，已告知 Grok 改用唯讀工具',
  grokRefusedPublish: '可編輯模式不允許推送或發佈',
  grokCancelledNoReason: 'Grok 自行中止了這一輪（stopReason: cancelled），沒有給出原因。',
  grokCancelled: (tool: string, reason: string | undefined) => `Grok 在執行工具「${tool}」時中止了這一輪${reason ? `（${reason}）` : ''}。`,
  grokCancelHint: (permission: string) => `目前的權限是「${permission}」；若這個操作是必要的，可以把權限改成「完全存取」再試。`,
  grokSandbox: (why: string) =>
    `Grok 無法啟動沙箱（完全存取以外的權限都需要）：${why}。在 Linux 上，它禁止讀取的路徑需要 bubblewrap（例如 sudo apt-get install bubblewrap），Ubuntu 23.10 以後還需要給 /usr/bin/bwrap 的 AppArmor 設定檔（見 docs/sandboxing.zh-TW.md 的「在 Linux 上」）。`,
  grokNoSession: 'grok 沒有回傳 session id',
  grokModelsFailed: (path: string, why: string) => `無法把你自己的端點的模型寫進 Grok 的設定（${path}）：${why}`,
  // Harness Relay's own sandbox (relaySandbox.ts), for the CLIs that have none of their own
  relaySandboxWindows:
    'Harness Relay 自己的沙箱無法在原生 Windows 上使用（它用的 sandbox-runtime 在 Windows 上還是 alpha 版），所以這個 agent 在「唯讀」與「可編輯」下不會在這裡執行。請在 WSL2 裡執行 Harness Relay，或把權限改成「完全存取」（不使用沙箱）。',
  relaySandboxPathTooLong: (dataDir: string, max: number) =>
    `Harness Relay 的資料資料夾路徑（${dataDir}）太長，沙箱放不下它要建立的 socket，所以沒有執行：請把 RELAY_DATA_DIR 設成路徑不超過 ${max} 個位元組的資料夾（UTF-8：中文字每個佔 3 個），再重新啟動 Harness Relay；或改用完全存取。`,
  relaySandboxNoNode:
    'Harness Relay 的沙箱需要 Node.js 22.12 或更新版本才能執行它的沙箱程式，而桌面 app 自己的執行環境不能當成 Node 使用：請到「設定 → 沙箱」安裝（放進 Harness Relay 的資料夾），或自行安裝 Node.js，讓它出現在登入 shell 的 PATH 上，再重新開啟 app；或改用完全存取。',
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
  cursorProtectedWrite:
    'Cursor 對這類檔案會先詢問：改動這裡可能讓程式碼之後在沙箱外執行（例如 git hook、編輯器的工作設定），或改變 agent 的設定。',
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
  guardRefused: '這是團隊檢查的受保護路徑，已在寫入前拒絕',
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
  copilotKeptWritable: (dir: string) =>
    `這一輪沒有開始：Copilot 的沙箱本身就讓 ${dir} 可寫入（它是暫存資料夾），所以唯讀的對話保護不了它。請為這個對話換一個工作目錄，或換一種權限。`,
  museRefused: '超出這個對話的權限，已拒絕',
  museProtected: '這是受保護的路徑（瀏覽器資料、Harness Relay 的資料庫等），低於完整權限時不能讀寫，已拒絕',
  museProtectedPattern: (path: string) =>
    `這一輪沒有開始：受保護的路徑 ${path} 含有 *、? 或 [，Muse Code 會把它當成萬用字元樣式，無法照原樣拒絕它。請改名或移走它，或改用完全存取。`,
  museCommandAsked: '唯讀對話裡每個指令都先詢問。允許後它在 Muse Code 的沙箱裡執行，可以寫入工作目錄。',
  museNetwork: '這個指令要連網：Muse Code 的沙箱讓它連到的每個主機都先詢問。允許後只有這個指令能連網，仍在沙箱裡執行。',
  museSessionGrant: '這個 Muse Code session 是在另一種權限下建立的（Muse 會沿用建立時的權限），所以這一輪開新的 session。',
  musePublish:
    '這個指令會推送或發布到這台電腦之外（git push、npm publish 等），或執行它從標準輸入讀到的內容，編輯權限不涵蓋，所以先詢問。允許後它仍在 Muse Code 的沙箱裡執行。',
  museOutsideWrite: '這個檔案不在這個對話的工作目錄裡：編輯權限只涵蓋工作目錄內的寫入。',
  museConfigWrite:
    '這裡是 agent 的設定（例如 .muse/、.agents/、.git/hooks、.vscode/）：寫在這裡可能讓程式碼之後在沒有沙箱的情況下執行，或改變 agent 的行為，所以先詢問。',
  museExitCode: (code: number) => `結束代碼 ${code}`,
  museCancelled: 'Muse Code 自行中止了這一輪（stopReason: cancelled），沒有給出原因。',
  museNoSession: 'muse 沒有回傳 session id',
  museRejectedMode: (err: string) => `Muse Code 無法切換權限模式：${err}`,
  museSignIn: (err: string) => `Muse Code 尚未登入（${err}）。請到「設定」的 Muse Code 登入，或設定 Meta API key。`,
  museConfigFailed: (err: string) => `無法替這一輪準備 Muse Code 的設定：${err}`,
  museAccountLogin:
    'Muse Code 在 macOS 把 Meta 登入存在登入鑰匙圈裡，名稱不隨它的資料夾改變，另一個帳號的登入可能取代預設帳號的，所以額外的 Muse Code 帳號只能用 Meta API key。預設帳號才用 Meta 帳號登入。',

  // Long-term memory
  memoryNoteNotFound: '找不到這則記憶',
  memoryNoteEmpty: '記憶的內容不能是空的',
  memoryFull: (max: number) => `長期記憶最多 ${max} 則，請先刪掉一些再新增。`,
  memoryTidying: '首席 agent 正在整理記憶，請等它完成。',
  memoryTidyUnparsable: '首席 agent 的回覆裡沒有 JSON 格式的變更。',
  memoryReplyRemoved: '記下它的回覆已重試或因編輯而移除',
  memoryOff: '長期記憶已關閉。',
  memoryNothingToTidy: '還沒有記憶可以整理。',

  // Conversations and runs
  defaultTitle: '新對話',
  conversationNotFound: '找不到對話',
  signedOut: '這個瀏覽器尚未登入 Harness Relay。請打開它啟動時在終端機印出的登入連結，或執行 npm run login。',
  signedOutDesktop:
    '這個瀏覽器尚未登入 Harness Relay。請從桌面 app 的選單選「在瀏覽器打開」（app 自己的視窗則選「打開 Harness Relay」），它會用新的登入連結打開。',
  signInWrongCode: '代碼錯誤或已過期。',
  signInTooMany: '錯誤的代碼太多次了，請等一分鐘再試。',
  signInNoSession: '找不到這個已登入的瀏覽器。',
  // Notifications (push.ts, alerts.ts): what a phone or a closed browser is told
  alert: {
    done: (agent?: string) => (agent ? `${agent} 回覆完了` : '回覆完了'),
    error: (agent?: string) => (agent ? `${agent} 出錯了` : '回覆出錯了'),
    approval: (agent?: string) => (agent ? `${agent} 等你核准` : '有 agent 等你核准'),
    confirm: (_agent?: string) => '首席 agent 設計好團隊了，等你確認',
    answer: (agent?: string) => (agent ? `${agent} 問了你一個問題` : '有 agent 問了你一個問題'),
    blocked: (agent?: string) => (agent ? `${agent} 回報目標卡住了，需要你處理` : '自動任務的目標卡住了，需要你處理'),
    testTitle: 'Harness Relay',
    testBody: '通知已開啟：agent 回覆完或需要你的時候，會在這裡通知你。',
  },
  pushEndpointRefused: (host: string) =>
    `Harness Relay 不會把通知送到「${host}」：它只送到瀏覽器的推播服務（Google、Apple、Mozilla、Microsoft 的），而且要用 HTTPS。`,
  pushBadKeys: '這個推播訂閱的金鑰不正確。',
  pushNotSubscribed: '這個瀏覽器還沒有訂閱推播通知。',
  pushUnavailable: (detail: string) =>
    `這台伺服器現在無法送出推播通知${detail ? `（${detail}）` : ''}：Harness Relay 開著的時候，頁面仍會通知你。`,
  pushTestFailed: '測試通知沒有送出：瀏覽器的推播服務沒有接受。請關掉通知再打開，然後再試一次。',
  pushTaken: '這個推播訂閱屬於另一個已登入的瀏覽器。',
  pushGone: '瀏覽器的推播服務說這個訂閱已經不存在：請重新訂閱。',
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
    `${cli} 要用模型「${id}」，但還沒有設定 ${backend} 的 API key。請到「設定 → 模型連線」設定，或改選其他模型。`,
  openEndpointMissing: (cli: string, endpoint: string, id: string) =>
    `${cli} 要用模型「${id}」，但沒有 id 為「${endpoint}」的自訂端點。請到「設定 → 模型連線」新增，或改選其他模型。`,
  endpointDeleted: (cli: string, endpoint: string, id: string) =>
    `${cli} 要用模型「${id}」，但它的自訂端點「${endpoint}」已在「設定 → 模型連線」刪除。這一輪沒有執行，也沒有改送到 ${cli} 自己的服務。請改選其他模型，或重新新增這個端點；如果「${id}」是 ${cli} 自己的模型，到「設定 → 模型連線 → 已刪除的端點」忘掉「${endpoint}」。`,
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
  openCancelled: (cli: string, tool: string, reason: string | undefined) =>
    `${cli} 在執行工具「${tool}」時中止了這一輪${reason ? `（${reason}）` : ''}。`,
  openCancelledNoReason: (cli: string) => `${cli} 自行中止了這一輪（stopReason: cancelled），沒有給出原因。`,
  openRefusal: (cli: string) => `${cli} 的模型拒絕回答這一輪（stopReason: refusal）。`,
  openRejectedMode: (cli: string, mode: string, e: string) => `${cli} 不接受 session 模式「${mode}」：${e}`,
  openRejectedModel: (cli: string, model: string, e: string) => `${cli} 不接受模型「${model}」：${e}`,
  openRejectedEffort: (cli: string, effort: string, e: string) => `${cli} 不接受推理強度「${effort}」：${e}`,
  openNativeNotYet: (cli: string) => `Harness Relay 還不能列出 ${cli} 自己載入的項目。`,
  openNoLogin: (cli: string) => `${cli} 不需要登入：它使用「設定 → 模型連線」裡的 API key 與端點。`,
  openBackendsReady: (names: string) => `模型連線：${names}`,
  openNoBackend: '請到「設定 → 模型連線」加入 API 金鑰或端點',

  // Goose (src/server/agents/goose.ts)
  gooseSessionNotChecked: (detail: string) =>
    `Harness Relay 無法檢查 Goose 這個 session 存的擴充功能清單（${detail}），所以沒有接續它：先前執行的指令可能在裡面加了不經詢問就會啟動的程式。這一輪改用新的 session。`,
  gooseAuthFailed: (backend: string) => `Goose 無法用 ${backend} 的 API key 登入。請到「設定 → 模型連線」檢查這把 key。`,
  gooseModelNotFound: (backend: string, model: string) => `${backend} 沒有模型「${model}」（404）。請在成員設定換一個模型。`,
  gooseUnreachable: (backend: string, host: string) =>
    `Goose 連不上 ${backend}（${host}）。請檢查網路，或在「設定 → 模型連線」檢查端點的網址。`,
  // Pi (src/server/agents/pi.ts)
  piSessionMissing: (id: string) => `找不到 session ${id} 的檔案（可能已被刪除）`,
  piSessionMoved: (then: string, now: string) => `這個 session 的工作目錄是 ${then}，這一輪的是 ${now}`,
  piSessionMismatch: (want: string, got: string) => `Pi 開啟的是 session ${got}，不是 ${want}`,
  piGateMissing:
    'Harness Relay 的把關擴充套件沒有在 Pi 裡載入（它負責在每個工具呼叫前詢問），所以這一輪沒有開始。請確認 Harness Relay 的資料夾裡有 src/server/agents/piGate.js。',
  piGateWritable: (path: string) =>
    `Harness Relay 的把關擴充套件（${path}）在這一輪可以寫入的資料夾裡，所以沒有執行 Pi。請換一個工作目錄。`,
  piModelMismatch: (want: string, got: string) => `Pi 選了模型「${got}」，不是指定的「${want}」`,
  piEffortLevels: (levels: string) => `這個模型可用的強度：${levels}`,
  piPromptRejected: (e: string) => `Pi 沒有接受這一輪的訊息：${e}`,
  piKeyRejected: (backend: string, e: string) => `${backend} 拒絕了 API key（${e}）。請到「設定 → 模型連線」檢查金鑰。`,
  piModelRejected: (model: string, backend: string, e: string) => `${backend} 沒有可用的模型「${model}」（${e}）。請改選其他模型。`,
  piUnreachable: (backend: string, e: string) => `連不上 ${backend}：${e}`,
  piEndpointUnreachable: (name: string, url: string, e: string) =>
    `連不上端點「${name}」（${url}）：${e}。請確認伺服器正在執行，網址正確。`,
  piModelError: (e: string) => `模型回報錯誤：${e}`,

  // Cline (src/server/agents/cline.ts)
  clineBadKey: (where: string, e: string) => `Cline 的模型來源「${where}」拒絕了 API key：${e}。請到「設定 → 模型連線」檢查這把 key。`,
  clineBadModel: (model: string, where: string, e: string) =>
    `模型來源「${where}」沒有 Cline 要用的模型「${model}」：${e}。請改選這個來源提供的模型。`,
  clineUnreachable: (where: string, e: string) =>
    `Cline 連不上模型來源「${where}」：${e}。請確認端點正在執行、網址正確（設定 → 模型連線）。`,
  clineFailed: (e: string) => `Cline 沒有完成這一輪：${e}`,
  // OpenHands (agents/openhands.ts)
  openhandsSubagentRefused: '完全存取以外不允許：OpenHands 的 subagent 會不經詢問執行指令與修改檔案',
  openhandsNoSuchSession: '它的 session 資料夾裡沒有這個 session',
  openhandsBadKey: (backend: string) => `${backend} 不接受 OpenHands 用的 API key（401）。請到「設定 → 模型連線」檢查金鑰。`,
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
  openhandsStuck:
    'OpenHands 自己停止了這一輪：它的卡住偵測發現它一直重複相同的動作（或得到相同的錯誤）卻沒有進展。請再問一次、換個說法，或為這位成員選另一個模型。',
  openhandsBatchRefused: '跟同一批動作一起被拒絕：OpenHands 對整批只問一次，而其中另一個動作不被允許',
  openhandsOddLog:
    '它的 session 紀錄跟 OpenHands 自己寫下的樣子不同（可能被別的程式改過），Harness Relay 無法確定 OpenHands 接續時會不經詢問執行其中哪些動作',
  openhandsNoEffort: (backend: string, model: string) =>
    `${backend} 的模型「${model}」不接受推理強度。請把這位成員的推理強度設成 none（或預設）。`,
  openhandsSandboxRefusedReadOnly: 'Harness Relay 的沙箱拒絕了：這個對話是唯讀的。',
  openhandsSandboxProtected:
    'Harness Relay 的沙箱拒絕了：這是受保護的路徑，Harness Relay 不讓代理讀取（它自己的資料庫與暫存檔、瀏覽器的資料）。',
  openhandsSandboxRefused: 'Harness Relay 的沙箱拒絕了：這個位置不在這個對話可以寫入的資料夾內。',
  openSandboxRefusedReadOnly: 'Harness Relay 的沙箱拒絕了：這個對話是唯讀的。',
  openSandboxRefused: 'Harness Relay 的沙箱拒絕了：這個位置不在這個對話可以寫入的資料夾內。',

  tooManyEndpoints: (n: number) => `最多只能設定 ${n} 個自訂端點。`,
  endpointNotFound: (id: string) => `找不到端點「${id}」`,
  deletedEndpointNotFound: (id: string) => `沒有記著已刪除的端點「${id}」`,
  endpointIdInvalid: (id: string) => `端點 id「${id}」只能用小寫英文字母、數字與 -（開頭與結尾不能是 -，最多 32 個字元）。`,
  endpointIdReserved: (id: string) => `「${id}」是內建模型來源的名稱，請為端點取別的 id。`,
  endpointNameMissing: '請輸入端點的名稱',
  endpointUrlInvalid: '請輸入以 http:// 或 https:// 開頭的端點網址，不含帳號密碼、查詢字串或 #。',
  endpointUrlRelay: '這是 Harness Relay 自己的位址，不能當成模型端點。',
  endpointCatalogKeyUnreadable: '無法讀取已儲存的 API key。請重新輸入，或解鎖憑證庫後重新啟動 Harness Relay。',
  endpointNoMetadata: '伺服器未提供模型清單或個別模型資料。Relay 已連到伺服器，但無法確認模型 ID 或金鑰能否用於對話。',
  endpointVerifyNeedsModel: '端點不支援列出模型。請輸入至少一個模型 ID，讓 Harness Relay 在儲存前確認端點。',
  endpointVerifyMismatch: (id: string) => `端點未回傳符合「${id}」的模型資料。請檢查模型 ID。`,
  endpointVerifyModelHttp: (id: string, status: number) => `無法確認模型「${id}」（HTTP ${status}）。請檢查模型 ID 與 API key 的存取權限。`,
  endpointVerifyModelError: (id: string, reason: string) => `無法確認模型「${id}」。${reason}`,
  endpointVerifyChanged: '確認模型時，端點設定已有變更。請重新開啟設定，確認後再儲存。',
  endpointVerifyTimeout: '模型檢查逾時。請確認端點可連線後再試一次。',
  endpointCatalogConnection: '無法讀取端點回應。請確認網址與連線後再試一次。',
  endpointResponseTooLarge: (single: number, total: number) =>
    `模型資料超過大小上限。每個回應最多 ${single} MiB，每次驗證總計最多 ${total} MiB。`,
  endpointCatalogDenied: (status: number) => `端點拒絕讀取模型清單（HTTP ${status}）。請檢查 API key 與存取權限。`,
  endpointCatalogHttp: (status: number) => `端點的 /models 回傳 HTTP ${status}。請檢查 OpenAI 相容 API 的基底網址。`,
  endpointCatalogInvalid: (mib: number) =>
    `/models 需要回傳含有 data 陣列的 JSON 模型清單，每個模型以 id 標示，回應大小上限為 ${mib} MiB。`,
  endpointModelsInvalid: (n: number, chars: number) => `模型名稱最多 ${n} 個，每個最多 ${chars} 個字元，不能含空白。`,
  endpointLimitsInvalid: (minContext: number, maxContext: number, minOutput: number, maxOutput: number) =>
    `上下文長度要是 ${minContext} 到 ${maxContext} 之間的整數（token），輸出上限要是 ${minOutput} 到 ${maxOutput} 之間的整數，並小於同一個模型的上下文長度；只能設定這個端點列出的模型。`,
  endpointOutputTooLarge: (model: string, output: number, context: number) =>
    `模型「${model}」的輸出上限（${output} token）要小於它的上下文長度（伺服器回報為 ${context} token）。請調低輸出上限，或填入上下文長度。`,
  backendUnknown: (id: string) => `未知的模型來源：${id}`,
  claudeReopens: (file: string, entry: string) =>
    `你的 Claude Code 設定（${file}）中的 sandbox.filesystem 讓沙箱可以存取「${entry}」，這會開放 Harness Relay 保護的路徑（瀏覽器的資料夾或它的資料庫）。請移除這一項後再試，或改用完全存取。`,
  cwdHoldsVoice: (dir: string, voice: string, fromEnv: boolean) =>
    `工作目錄「${dir}」包含語音輸入的資料夾「${voice}」，或就在它裡面${fromEnv ? '（RELAY_VOICE_DIR）' : ''}。Harness Relay 會在沙箱外執行那裡的語音引擎，而可編輯模式下 agent 不經詢問就能修改這裡的檔案。請改用其他資料夾或唯讀模式。`,
  cwdIsRelay: (dir: string) =>
    `工作目錄「${dir}」包含 Harness Relay 本身（它的程式或資料）。可編輯模式下，agent 不經詢問就能修改這裡的檔案，也就能改動 Harness Relay 的程式碼或資料庫，繞過它的沙箱與登入。請改用其他資料夾或唯讀模式；要開發 Harness Relay 本身，請從另一個資料夾執行你使用的那份 Harness Relay。`,
  // OpenCode (agents/opencode.ts)
  opencodeBackendError: (backend: string, e: string) =>
    `模型來源 ${backend} 回報錯誤，OpenCode 無法完成這一輪：${e}。請檢查「設定 → 模型連線」裡的 API key、端點網址與模型名稱。`,
  opencodeAuthRequired: (backend: string) => `OpenCode 無法使用模型來源 ${backend}：缺少 API key 或它被拒絕。請到「設定 → 模型連線」檢查。`,
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
  shareTooLarge: (mb: string, max: string) => `這個分享頁有 ${mb} MB，超過分享頁能放的 ${max}。請改成分享到比較前面的某則回覆。`,
  shareNoGh: (min: string) =>
    `找不到 GitHub CLI（gh）。請從 https://cli.github.com 安裝 ${min} 以上的版本，並在終端機執行 gh auth login 後再試一次。`,
  ghTooOld: (min: string, version?: string) =>
    `GitHub CLI（gh）版本太舊${version ? `（目前是 ${version}）` : ''}：需要 ${min} 以上。請從 https://cli.github.com 更新 gh（用 Homebrew 裝的可以執行 brew upgrade gh）後再試一次。`,
  ghLoginTokenSet: (name: string) =>
    `gh 會用 Harness Relay 環境裡的 ${name} 登入：它優先於 gh 保存的登入，而且有它在，gh 就不肯保存另一個登入。請在啟動 Harness Relay 的地方修正或移除 ${name}，再重新啟動。`,
  shareSignedOut: 'GitHub CLI（gh）尚未登入。請在這裡登入 GitHub，或在終端機執行 gh auth login，再試一次。',
  shareFailed: (detail: string) => `無法建立 gist：${detail}`,
  shareNoDetail: 'gh 沒有說明原因',
  shareNoUrl:
    'gh 沒有回傳 github.com 上的 gist 網址（分享頁只能顯示 github.com 的 gist）。如果已經建立了 gist，可以用 gh gist list 找到它再刪除',
  unshareFailed: (detail: string) => `無法刪除 gist：${detail}`,
  unshareNotOwner: '這個 gist 還在 GitHub 上，但不屬於 gh 目前登入的帳號，所以無法刪除。請用 gh auth switch 切回建立它的帳號，再移除一次。',
  shareNotFound: '找不到這個分享',
  shareNoFileUrl: 'GitHub 沒有回傳上傳檔案的網址',
  shareNotGithub: 'gist 不在 github.com 上，分享頁只能顯示 github.com 的 gist',
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
  reportShotUnreadable: (n: number) =>
    `第 ${n} 張截圖讀不懂它的檔案結構，沒辦法確定拿掉了中繼資料，所以不上傳：請重新截圖，或另存成 PNG 再試。`,
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
  appInstallManual: '這台電腦需要手動安裝。請依畫面上的指引安裝後重新檢查。',
  appInstallMissing: '安裝程式已結束，但 Relay 還找不到這項工具。請查看安裝紀錄後重試。',
  noAgents: '這個對話沒有任何 agent',
  runFailed: (msg: string) => `執行失敗：${msg}`,
  stoppedNote: '已停止。',
  queuedNotFound: '這則訊息已經送出或撤回了',
  queueFull: (n: number) => `最多 ${n} 則訊息等待送出，請等團隊回覆後再送`,
  gitInitNote: (root: string) => `工作目錄原本不是 git repository，已自動執行 git init：${root}`,
  dirLocked: (title: string, root: string) => `對話「${title}」正在修改 ${root}，請等它結束後再試（或改用唯讀 / 平行模式）。`,
  applyLocked: (title: string, root: string) => `對話「${title}」正在修改 ${root}，請等它結束後再套用。`,
  teamWorktreeNote: (title: string, root: string) =>
    `對話「${title}」正在修改 ${root}，所以這個對話的團隊改在自己的 worktree（資料夾的副本）裡工作，兩邊可以同時進行。團隊的修改要等你按「套用到工作目錄」才會寫進資料夾；套用之前，這個對話之後的回覆也都在這個 worktree 裡進行。`,
  noWorktree: '這位成員沒有 worktree',
  noTeamWorktree: '這個對話沒有自己的 worktree',
  teamName: '團隊',
  resultStale: '工作目錄已經更新過，這份結果已過期；請讓團隊再跑一輪。',
  appliedNote: (name: string, files: number) =>
    `已把 @${name} 的修改套用到工作目錄（${files} 個檔案，尚未 commit）。下一次平行作業會從新的工作目錄狀態開始。`,
  appliedTeamNote: (files: number) =>
    `已把團隊在這個對話 worktree 裡的修改套用到工作目錄（${files} 個檔案，尚未 commit）。之後團隊會回到工作目錄裡工作，除非那時有別的對話正在修改它。`,
  noChanges: '這則訊息沒有檔案修改',
  relayLimit: (hops: number) => `已達接力上限（${hops} 棒），交還給使用者。可按「繼續」讓團隊接著做。`,

  // Team checks
  checksTooManyFiles: (max: number) =>
    `要比對的檔案超過 ${max} 個，無法檢查受保護路徑；請把路徑寫得更明確（例如 config/*.pem，而不是 *.pem）。`,
  checksListChanged: '檢查清單在這一輪開始後改過，這一輪的受保護路徑無法用新清單比對；下一輪會照新清單檢查。',
  checksNoBaseline: '找不到這一輪開始時的狀態，無法重新比對。',
  checksCommitsParallel: '平行模式套用結果時不帶 commit 歷史，所以不檢查 commit 格式。',
  checksCommitsTeam: '團隊在這個對話自己的 worktree 裡工作，套用結果時不帶 commit 歷史，所以不檢查 commit 格式。',
  checksNoCommits: '這一輪沒有新的 commit。',
  checksPatternSlow: 'commit 格式的正規表示式跑太久，已中止；請改寫得簡單一點。',
  checksTooManyCommits: (n: number) => `新的 commit 超過 ${n} 個，只檢查了最新的 ${n} 個。`,
  checksBadPath: (p: string) => `受保護路徑「${p}」無法使用：請寫工作目錄裡的相對路徑，不能有 ..`,
  checksTooManyPaths: (n: number) => `受保護路徑最多 ${n} 條`,
  checksBadCommitPattern: (why: string) => `commit 格式不是有效的正規表示式：${why}`,
  checksCommitPatternTooLong: (n: number) => `commit 格式最長 ${n} 個字元`,
  checksNotFound: '找不到這份檢查結果',
  checksNotLatest: '只有最新的一份檢查結果可以這樣處理',
  checksPassedAlready: '這份檢查結果沒有未通過的項目',
  checksFixMessage: (name: string) => `@${name} 請修正上一份團隊檢查未通過的項目（整份結果都要通過）。`,
  checksAutoFixMessage: (name: string, attempt: number, of: number) =>
    `@${name} 團隊檢查沒有通過：請修正（Relay 自動送出，第 ${attempt} 次，共 ${of} 次）。`,
  checksPreviewNoApp: '這次沒有任何一輪做出或修改應用程式。',
  checksScheduleFailed: '團隊檢查未通過',
  checksScheduleError: '團隊檢查無法執行',
  checksSandboxDenial: (kind: string, on: boolean) =>
    ({
      localPorts: on
        ? '沙箱擋下了本機連接埠。'
        : '沙箱擋下了它要開的本機連接埠（macOS）。如果這個指令的測試需要自己的伺服器，可以在這條指令開啟「允許所有本機連接埠」，但它就能連到這台電腦所有本機服務，包括 Harness Relay 的 API。',
      unixSockets: on
        ? '沙箱擋下了 Unix socket。'
        : '沙箱擋下了它要開的 Unix socket（Linux）。如果這個指令需要，可以在這條指令開啟「允許所有 Unix socket」，但它就能連到 Docker、ssh agent 等所有 socket。',
      readOnly: '它要寫入工作目錄以外的地方（例如 /tmp），沙箱只讓它寫工作目錄和它自己的暫存資料夾。',
      phantom: '它讀到沙箱在工作目錄最上層放的保護項目（例如 .zshrc、.vscode；Linux）。請讓指令略過這些名稱，或只檢查需要的資料夾。',
      browser: '沙箱裡無法啟動瀏覽器，端對端測試請在沙箱外執行。',
      network: '沙箱裡沒有網路，指令要連的主機無法連線。',
      denied: '沙箱擋下了它要做的事（Operation not permitted）。',
    })[kind] ?? '沙箱擋下了它要做的事。',
  checksCommandTimedOut: (min: number) => `超過 ${min} 分鐘還沒結束，已停止。`,
  checksCommandNotFound: '找不到要執行的程式（exit 127）。Harness Relay 不會自己安裝缺少的東西。',
  checksCommandWindows: '原生 Windows 上還不能執行指令檢查（沒有 Harness Relay 的沙箱）；只檢查受保護路徑和 commit 格式。',
  gatewayFromCode: '由代理用 run_code 執行的程式碼發出。',
  labsBadMode: '實驗室的模式只能是關閉、讓助理寫程式呼叫工具，或分段閱讀長文字。',
  labsNoModel: '分段閱讀長文字需要選一個模型（「來源/模型」）。',
  labsBadModel: (id: string) =>
    `「${id}」不是「來源/模型」的格式，例如 anthropic/claude-haiku-5-5、你的端點 id 加上模型名稱，或透過 CLI 的 cli:claude/haiku。`,
  labsNoConnection: (backend: string) => `「模型連線」裡沒有設定 ${backend}：請先在「設定 → 模型連線」加上它的金鑰或端點。`,
  labsNoCliAccount: (cli: string, account: string) => `${cli} 沒有「${account}」這個帳號：請到「設定 → ${cli}」加上它，或選另一個帳號。`,
  labsCliConnectionModel: (cli: string, model: string) =>
    `「${model}」是你自己的端點或 API 金鑰的模型，透過 ${cli} 問會把問題送到 ${cli} 自己的服務：請改成透過模型連線問它，或填 ${cli} 自己的模型。`,
  labsWindows: '原生 Windows 上還不能用：Harness Relay 在這裡沒有可以執行程式的沙箱。',
  labsNoNode: '這台電腦上找不到可以執行程式的 Node.js。',
  checksCommandNoFolder: (cwd: string) =>
    cwd ? `找不到要執行指令的資料夾「${cwd}」，或它不在對話的工作目錄裡。` : '找不到對話的工作目錄。',
  checksCommandsAtEnd: '團隊做完這一輪後才會執行指令檢查。',
  checksCommandsParallel: '平行模式的結果套用到工作目錄之前不在工作目錄裡，所以指令會在套用時檢查。',
  checksCommandsTeam: '團隊的修改在這個對話自己的 worktree 裡，套用到工作目錄之前不在工作目錄裡，所以指令會在套用時檢查。',
  checksConfigChanged: (files: string) =>
    `團隊改到了檢查會讀的設定（${files}），還沒確認，所以先不執行；確認沒問題後按「確認後執行指令」執行。`,
  checksNetworkRefused: (hosts: string) => `沙箱裡沒有網路，它要連的主機被擋下了：${hosts}。`,
  checksAlsoRefused: (hosts: string) => `沙箱也擋下了它要連的主機（${hosts}），但輸出看不出它是因此失敗。`,
  checksCommandsReadOnly: '唯讀權限下不執行指令檢查。',
  checksTryReadOnly: '唯讀權限下不能試跑指令：檢查不會執行指令。',
  checksInterrupted: '伺服器在指令執行中停止了，這條沒有跑完。',
  checksConfigChangedUnattended: (files: string) => `團隊改到了檢查會讀的設定（${files}），沒有人確認，所以算未通過。`,
  checksTooManyCommands: (n: number) => `指令檢查最多 ${n} 條`,
  checksCommandEmpty: '指令檢查不能是空的',
  checksCommandTooLong: (n: number) => `一條指令最長 ${n} 個字元`,
  checksBadFolder: (f: string) => `無法使用資料夾「${f}」：請寫第一個工作目錄裡的相對路徑（不能有 ..），或工作目錄裡的完整路徑`,
  checksBadTimeout: (max: number) => `時間上限是 1 到 ${max} 分鐘`,
  hooksTooMany: (n: number) => `hook 最多 ${n} 個`,
  hookTimedOut: (sec: number) => `超過 ${sec} 秒的時間上限，已停止。`,
  hooksBadTimeout: (max: number) => `hook 的時間上限是 1 到 ${max} 秒`,
  hookRefused: (hook: string, call: string, why: string) => `團隊的 hook「${hook}」拒絕了 ${call}：${why}`,
  hookFailed: (hook: string, call: string, why: string) => `${call} 之後，團隊的 hook「${hook}」沒有通過，已告訴 agent：${why}`,
  hookNoOutput: '（沒有輸出）',
  hooksTooLate: '沒有在時間內跑完，已停止',
  hookCallTooLong: (call: string) => `團隊的 hook 拒絕了 ${call}：這次呼叫太長，hook 讀不完`,
  hookRefusedLabel: '團隊的 hook 拒絕了這次呼叫',
  hooksNoProgram: (cli: string) =>
    `這一輪沒有開始：不能把團隊的 hook 交給 ${cli}（找不到可以啟動 hook 程式的 Node.js，或 Harness Relay 的 gateway 沒有在執行）。請安裝 Node.js 22.12 以上（設定 → 沙箱可以安裝），或在團隊檢查裡拿掉 hook。`,
  hookMoreNotices: '這一輪之後的 hook 拒絕或沒有通過，不再一一列出。',
  hooksUnsupported: (cli: string) => `${cli} 還不能執行團隊的 hook：這位成員這一輪的工具呼叫不經過它們，團隊答完後的檢查照常。`,

  // What a CLI reports about its own run (notes in the reply), and its subagents
  backgroundCutOff: '這一輪在這項工作完成之前就結束了。',
  cliCompacted: (cli: string) => `${cli} 壓縮了對話的上下文，騰出空間繼續。`,
  cliCompactFailed: (cli: string, why?: string) => `${cli} 沒能壓縮對話的上下文${why ? `：${why}` : '。'}`,
  cliRetrying: (cli: string, attempt?: number, max?: number, why?: string) =>
    `${cli} 向模型的請求失敗，正在重試${attempt ? `（第 ${attempt}${max ? ` / ${max}` : ''} 次）` : ''}${why ? `：${why}` : '。'}`,
  cliRetryFailed: (cli: string, why?: string) => `${cli} 重試之後仍然失敗${why ? `：${why}` : '。'}`,
  cliModelSwitched: (cli: string, from: string, to: string) =>
    from ? `${cli} 把模型從 ${from} 換成了 ${to}。` : `${cli} 換成了模型 ${to}。`,

  // Approvals
  approvalNotFound: '這個請求已經處理過或已失效',
  approvalDeclined: '使用者拒絕了這個操作。',
  retryAgentGone: (name: string) => `@${name} 已不在團隊中，無法重試這則回覆`,

  // Auto team
  planNotFound: '找不到這份團隊設計',
  planNotSavable: '只有首席 agent 設計或調整過的團隊可以存成範本',
  planUnparsable: '回覆中找不到 JSON 團隊設計',
  reviewUnparsable: '回覆中找不到 JSON 審閱結果',
  planUnknownTemplate: (id: string) => `沒有 id 為「${id}」的範本`,
  planTemplateTooBig: (name: string, max: number) => `範本「${name}」的成員比隊伍上限（${max} 位）多`,
  planTemplateFits: (name: string) => `首席 agent 判斷範本「${name}」適合這個問題，直接套用。`,
  planKeepFits: '首席 agent 判斷目前的團隊也適合這個問題，沿用不變。',
  planCheckAccounts: '檢查帳號與用量',
  planCheckModel: '測試模型回覆',
  planModelDefault: '預設模型',
  planModelNoReply: '模型未回傳預期的測試回覆。',
  planModelChecksFailed: (models: string) =>
    models ? `以下模型未通過驗證：${models}。請檢查帳號與模型來源，再重新設計團隊。` : '模型驗證逾時，請重新設計團隊。',
  planNoAvailableModel: (schedule: boolean) =>
    `目前沒有可用的模型可以組隊。請到設定與登入查看帳號與用量，或稍後${schedule ? '在自動任務面板重新設計團隊' : '按「繼續」重試'}。`,
  planEndpointUnavailable: (model: string) => `私人端點的模型「${model}」目前無法使用。請檢查 CLI 帳號與模型來源。`,
  planAssignmentsAdjusted: '已調整部分成員的帳號或模型，讓他們使用可用的配置。',
  planCurrentUnavailable: '目前的團隊有成員使用暫時無法執行的帳號或模型',
  planLeadUnavailable: '首席 agent 的帳號或模型目前無法使用',
  planNoCurrentTeam: '這個對話還沒有團隊可以沿用',
  planAwaitingConfirm: '請先確認首席 agent 設計的團隊，團隊才會開始回答',
  // Asking the lead agent to change a team (team drawer)
  reviseEmpty: '請先說明想怎麼調整團隊',
  reviseTooLong: (max: number) => `調整說明最多 ${max} 個字`,
  reviseStopped: '已停止調整團隊',
  reviseFailed: (why: string) => `首席 agent 沒能調整團隊（${why}）。團隊維持原樣，可以換個說法再試一次。`,

  // Schedules
  scheduleNotFound: '這個對話沒有自動任務',
  scheduleTextRequired: '請輸入自動任務要傳給團隊的訊息',
  scheduleTextTooLong: (max: number) => `自動任務的訊息最多 ${max} 個字`,
  scheduleBadRepeat: '自動任務的時間設定無效',
  scheduleBadTime: '時間的格式應為 HH:MM（24 小時制）',
  scheduleNeedDays: '每週的時間至少要選一天',
  scheduleBadHours: (max: number) => `間隔應為 1 到 ${max} 小時的整數`,
  scheduleBadMoment: '請選擇日期與時間',
  scheduleInPast: '這個時間已經過了，請選擇之後的時間',
  scheduleBadTimeZone: (tz: string) => `不認得時區「${tz}」`,
  scheduleNeedsTeam: '請先確認團隊，再設定自動任務',
  scheduleNoTeam: '團隊還沒確認',
  scheduleDesigning: '首席 agent 正在為一個問題組隊，稍後再送出',
  scheduleWaitsForAnswer: '團隊在等你回答問題',
  scheduleStillQueued: '自動任務的上一則訊息還在等待送出',
  scheduleBusy: '對話正在更新，請稍後再試',
  scheduleQueueFull: '等待送出的訊息已經滿了',
  scheduleRefused: '自動任務執行時可能沒人看著，已自動拒絕',
  approvalReviewPublish: '推送與發佈一律由你決定，首席 agent 不會替你核准',
  approvalReviewGrant: '在這一輪剩下的時間取得更多權限，一律由你決定，首席 agent 不會替你核准',
  approvalReviewNoDecision: '首席 agent 的回答裡沒有可以讀懂的決定',
  approvalReviewFailedRefused: (why: string) => `首席 agent 無法審查，而自動任務執行時可能沒人看著，已自動拒絕${why ? `（${why}）` : ''}`,
  approvalReviewTimeout: '首席 agent 太久沒有完成審查',
  approvalReviewFailed: (why: string) => `首席 agent 無法審查：${why}`,
  approvalReviewRefused: (why: string) => `首席 agent 認為可能不安全，而自動任務執行時可能沒人看著，已自動拒絕${why ? `：${why}` : ''}`,
  scheduleConvBusy: '對話正在更新設定或套用結果',
  scheduleFolderWritten: '團隊正在資料夾裡寫，或剛寫完；寫完後的下一次檢查會送出',
  scheduleMissedNote: (when: string) => `自動任務 ${when} 的訊息沒有送出：當時 Harness Relay 沒有在執行。`,
  scheduleSkippedNote: (when: string, why: string) => `自動任務 ${when} 的訊息沒有送出：${why}。`,
  scheduleSkippedNotes: (first: string, last: string, count: number, why: string) =>
    `自動任務 ${first} 到 ${last} 的訊息（共 ${count} 次）都沒有送出：${why}。`,
  scheduleFailedNote: (when: string, why: string) => `自動任務 ${when} 的訊息無法送出：${why}`,
  scheduleChatNote: (title: string) => `這個對話由「${title}」的自動任務開啟，自動任務的訊息在這裡送出。`,
  scheduleNoLead: '這個對話沒有讓首席 agent 組隊',
  scheduleHasTeam: '這個自動任務已經有團隊了',
  scheduleCreatedNote: '已建立自動任務。首席 agent 會為它的訊息組隊；團隊確認後，每次自動任務執行時都會把訊息傳給它，現在不會先執行。',
  scheduleGoalTooLong: (max: number) => `目標最多 ${max} 個字`,
  trackingDoneNote: (agent: string, note: string) => `@${agent} 回報目標已達成，自動任務已關閉${note ? `：${note}` : '。'}`,
  trackingBlockedNote: (agent: string, note: string) => `@${agent} 回報目標卡住了，需要你處理${note ? `：${note}` : '。'}`,
  trackingRetryNotNeeded: '之後已經有新的進度回報，不再重試',
  trackingRetryNote: (when: string, attempt: number, minutes: number) =>
    `自動任務 ${when} 的執行失敗，${minutes} 分鐘後重試（第 ${attempt} 次重試）。`,
  trackingGaveUpNote: (when: string, tries: number) => `自動任務 ${when} 的執行失敗，重試 ${tries} 次後仍未成功，等下一個設定的時間。`,
  trackingRestartNote: (when: string) => `自動任務 ${when} 的執行在 Harness Relay 停止時中斷，馬上重試。`,
  trackingRunFailed: '這次執行的回覆全都失敗了',
  hookNotFound: '找不到這個 webhook',
  oauthClientDisabled: (provider: string) => `${provider} 登入已停用。請在「常用 App → 帳號登入設定」重新啟用。`,
  oauthNoClient: (provider: string) => `請先在「常用 App → 帳號登入設定」設定 ${provider} 的 OAuth 用戶端。`,
  oauthTokenNotSaved: (why: string) => `無法把登入的權杖存進憑證儲存區：${why}`,
  oauthHostRefused: (host: string) => `登入的權杖不會送到「${host}」：它只送到這個帳號的服務`,
  oauthAccountGone: '找不到這個登入的帳號：它可能已經被移除了',
  oauthSignInAgain: (email: string, why: string, use?: OAuthUse) =>
    `${email} 的登入已經失效，請到「${signInSettings('zh-TW', use)}」重新登入${why ? `（${why}）` : ''}`,
  oauthNoToken: (email: string, use?: OAuthUse) => `讀不到 ${email} 的登入權杖：請到「${signInSettings('zh-TW', use)}」重新登入`,
  oauthRefreshFailed: (email: string, why: string) => `無法更新 ${email} 的登入：${why}`,
  oauthBadAddress: '這不是一個網址：請貼上登入頁面最後帶你去的完整網址',
  oauthWrongAddress: '這個網址不是這次登入的：請貼上這次登入最後帶你去的網址',
  oauthExpired: '登入等太久，已經失效了：請重新登入',
  oauthTooMany: '同時等待中的登入太多了：請先完成或取消其中幾個',
  oauthNoDevice: (provider: string) => `${provider} 不能用另一台裝置登入這些權限`,
  oauthStartFailed: (provider: string, why: string) => `無法開始 ${provider} 的登入：${why}`,
  oauthSignInNotFound: '找不到這次登入：它可能已經完成、取消或過期了',
  oauthRefused: (provider: string, why: string) => `${provider} 沒有完成登入：${why}`,
  oauthNoCode: '登入頁面沒有帶回授權碼',
  oauthNoRefresh: (provider: string) => `${provider} 沒有給更新用的權杖，所以這個登入一小時後就會失效：請重新登入，並允許離線存取`,
  oauthCalendarFixed: '這個行事曆是透過登入的帳號使用的，不能改成用密碼：請移除它，再重新加入',
  oauthCallbackTooOften: '登入的回呼太多次失敗了：請稍後再試',
  oauthAppChanged: '登入時用的 app 在「設定」裡換掉了',
  oauthNoCalendarAccess: (provider: string) => `${provider} 沒有給行事曆的存取權限：請重新登入，並在登入頁面上允許存取你的行事曆`,
  oauthNoTeamsAccess: '請用 Microsoft 工作或學校帳號登入，並允許讀取 Teams 頻道。',
  oauthNoDocumentsAccess: '若要建立或編輯 Google 文件，請重新登入 Google 並授權文件編輯。',
  oauthNoDriveAccess: '請用 Google 重新登入，並允許讀取雲端硬碟。',
  macAppFinderDenied:
    'Finder 未取得複製應用程式所需的權限。請在這台 Mac 的「系統設定」→「隱私權與安全性」→「自動化」允許 Relay 或其終端機控制 Finder。',
  macAppPublishFailed: (dest: string) => `無法在 ${dest} 安裝應用程式。`,
  macAppDestinationExists: (dest: string) => `${dest} 已有應用程式。`,
  macAppMissingBundle: (name: string) => `下載的磁碟映像檔中找不到 ${name}。`,
  githubArchiveDownload: '無法下載或驗證 GitHub CLI。請檢查網路連線和磁碟空間後重試。',
  githubArchiveRun: '無法解壓縮或啟動下載的 GitHub CLI。請重新安裝或使用 GitHub 的官方安裝方式。',
  teamsRuntimeUnsupported: '這個系統或處理器沒有可自動安裝的 PowerShell 7 版本。請依 Microsoft 的指示手動安裝，再重試。',
  teamsRuntimeDownload: '無法從 Microsoft 的 PowerShell 發行頁下載或驗證套件。請檢查連線和磁碟空間，再重試。',
  teamsRuntimeTools: '安裝 PowerShell 7 需要系統的 curl 與 tar。請安裝這兩個工具，或手動安裝 PowerShell 7，再重試。',
  teamsRuntimeRun: '無法解壓縮或啟動 PowerShell 7。請確認系統支援 Microsoft 的 PowerShell 發行版本，且已安裝其原生相依套件。',
  teamsSetupFailed: '無法設定 Microsoft Graph。請確認已安裝 PowerShell 7 並可連至 PowerShell Gallery，再試一次。',
  teamsForbidden: 'Teams 拒絕存取這個目的地（HTTP 403）。請檢查該頻道或聊天的存取權限。',
  teamsPostingConnect: '請先在「設定 → App 與工具 → 常用 App → Microsoft Teams」允許發送訊息。',
  teamsPostingTarget: '請貼上現有 Teams 頻道、聊天或訊息的連結，並確認此帳號可開啟該目的地。',
  teamsPostingChanged: 'Teams 的傳送帳號或目的地與預覽不符。請重新準備訊息。',
  teamsPostFailed: '無法確認 Teams 是否已發送訊息。請先查看目的地，再決定是否重試。',
  teamsReadFailed: '無法讀取 Teams。請確認網路連線和帳號權限，再試一次。',
  appsGithubChanged: 'GitHub 帳號已變更。請確認目前顯示的帳號，再選擇是否登出。',
  appsGithubToken: (name: string) => `請從啟動 Relay 的環境移除 ${name}，然後重新啟動 Relay。`,
  appsGithubSignOutFailed: 'GitHub CLI 無法登出這個帳號。請重新檢查帳號後再試一次。',
  appsGithubFailed: '無法讀取 GitHub。請確認網路連線和帳號權限，再試一次。',
  appsTooLarge: '內容太大，請縮小讀取範圍。',
  appsConnectFirst: '請先在「設定 → App 與工具 → 常用 App」連結帳號。',
  obsidianChoose: '請用 obsidian_list_vaults 查詢筆記庫，並以 vault 參數指定其中一個 ID。',
  obsidianMultiple: '已連結多個筆記庫。請選擇要管理的個別筆記庫。',
  obsidianOverlap: '不能同時連結一個筆記庫及其上層或下層筆記庫。',
  obsidianVaultMissing: '找不到這個已連結的筆記庫。',
  docsGrant: '請先在「常用 App」的 Google Drive 帳號授權 Google 文件編輯。',
  docsAccount: '請指定一個已授權 Google 文件編輯的 Google 帳號電子郵件。',
  docsChanged: '文件、帳號、授權或版本已變更。請重新預覽。',
  docsInvalid: 'Google 文件回應的檔案、分頁或版本無法驗證。',
  docsMatch: '請提供一般內文段落中唯一符合的完整文字。涉及建議修訂或其他文件結構的文字無法修改。',
  docsTabs: (tabs: string) => `請指定要編輯的分頁 ID（${tabs}）。`,
  docsCreate: (title: string) => `建立 Google 文件「${title}」`,
  docsEdit: (title: string) => `編輯 Google 文件「${title}」`,
  docsSaved: (title: string, link: string) => `已儲存 Google 文件「${title}」。\n${link}`,
  docsFailed: (title: string, why: string) => `Google 文件「${title}」的變更未確認完成。${why}`,
  docsDiscarded: (title: string) => `已捨棄 Google 文件「${title}」的變更。`,
  docsUnknown: (target: string) => `無法確認最後結果。請在 Google 文件中檢查「${target}」後再提出新要求。`,
  docsCreatedCheck: (title: string, link: string) => `已建立 Google 文件「${title}」。請開啟檢查內容後再提出新要求。\n${link}`,
  docsHttp: (code: number) => `Google 文件回應 HTTP ${code}。請檢查文件權限及版本後再試。`,
  obsidianPath: '請指定現有資料夾中的 .md 筆記，路徑須相對於筆記庫，且不得包含隱藏項目。',
  obsidianWriteFailed: '無法完成筆記寫入。請檢查檔案系統的狀態。',
  obsidianContent: '每份筆記的原文與新內容都必須是 48 KiB 以內的 UTF-8 文字。',
  obsidianChanged: '筆記、資料夾或所選筆記庫已變更。請重新預覽後儲存。',
  obsidianExists: '這個筆記路徑已被使用。請選擇其他檔名，或提出編輯現有筆記的預覽。',
  obsidianCreate: (path: string) => `建立筆記「${path}」`,
  obsidianEdit: (path: string) => `編輯筆記「${path}」`,
  obsidianSaved: (path: string) => `已儲存筆記「${path}」。`,
  obsidianFailed: (path: string, why: string) => `未儲存「${path}」。${why}`,
  obsidianDiscarded: (path: string) => `已捨棄「${path}」的變更。`,
  obsidianInterrupted: '儲存途中 Harness Relay 已停止。請先檢查筆記，再提出新的變更。',
  messageSetup: (app: string) => `請先在「常用 App」的 ${app} 開啟 Relay 發送訊息。`,
  messageChanged: '連線或目的地已變更，請重新產生預覽。',
  messageUnknown: (app: string) => `無法確認是否已送達。請先到 ${app} 檢查，Relay 不會重送。`,
  slackToken: 'Slack 權杖無效或已失效。請輸入工作區 App 的 OAuth 權杖。',
  slackScope: '請在 Slack App 開啟 chat:write 與目的地的讀取權限，重新安裝後再連結。',
  slackDestination: '請使用此工作區中 App 能存取的頻道或對話連結或 ID。請確認 App 已加入。',
  slackStorage: '無法存取這台電腦的憑證儲存區。',
  slackCheck: '無法向 Slack 確認連線或對話，請再試一次。',
  messageNewPost: '新頻道貼文',
  messageChat: '聊天對象',
  messageFrom: '發送身分',
  messageTo: '目的地',
  messageWorkspace: '工作區',
  messageTenant: '組織',
  messageTitle: (app: string) => `傳送 ${app} 訊息`,
  messageSent: (app: string) => `已送達 ${app}。`,
  appsVault: '請選擇 Obsidian 筆記庫的資料夾（裡面有 .obsidian）。',
  appsSlackInAssistant: '請到「設定 → App 與工具 → 常用 App → Slack」，在 Claude 或 Codex 連結 Slack。',
  oauthNoMailAccess: (provider: string) => `${provider} 沒有給郵件的存取權限：請重新登入，並在登入頁面上允許存取你的郵件`,
  oauthNoUse: (label: string) => `${label} 的權杖要指定用途（行事曆或郵件）才能取得`,
  oauthNotFor: (email: string, use: OAuthUse) =>
    use === 'documents'
      ? `請為 ${email} 開啟 Google 文件編輯。`
      : use === 'teams'
        ? `請為 ${email} 連結 Teams`
        : use === 'drive'
          ? `請為 ${email} 連結 Google Drive`
          : `${email} 登入時沒有允許${use === 'mail' ? '郵件' : '行事曆'}：請先在「${signInSettings('zh-TW', use)}」選擇服務並登入同一個帳號`,
  oauthMailFixed: '這個郵件帳號是透過登入的帳號使用的，用的是該服務自己的伺服器，不能改成用密碼或其他伺服器：請移除它，再重新加入',
  oauthSignInCancelled: '這次登入已經取消，或是它用的 app 在「設定」裡換掉了',
  oauthAccountRemoved: '這次登入要用的帳號在登入期間被移除了，所以什麼都沒有改變',
  oauthOtherAccount: (signedIn: string, meant: string) =>
    `你登入的是 ${signedIn}，不是 ${meant}：${meant} 沒有改變。要加入另一個帳號，請用「用 … 登入」`,
  oauthSecretNotSaved: (why: string) => `無法把 app 的用戶端密碼存進憑證儲存區：${why}`,
  oauthNotHere: (name: string) => `「${name}」是透過登入的帳號使用的，但這裡無法使用登入的帳號`,
  oauthTokenRanOut: '它登入時沒有拿到更新用的權杖，而存取權杖已經過期了',
  oauthTokenTooLong: (max: number) => `回應裡的權杖超過 ${max} 個字元：不接受`,
  oauthNotConfirmed: (provider: string) => `${provider} 的登入頁面還沒經過你確認，卻有回應回來了：不接受，請重新登入`,
  oauthOtherIssuer: (provider: string, iss: string) =>
    `回應來自另一個授權伺服器（${iss}），不是 ${provider} 這次登入的：不接受（可能是混淆攻擊），請重新登入`,
  oauthNoIssuer: (provider: string) => `${provider} 的授權伺服器說它會在回應裡寫明自己（iss），這次卻沒有：不接受，請重新登入`,
  mcpServerLabel: (name: string) => `MCP 伺服器「${name}」`,
  mcpBadAddress: (url: string) => `「${url}」不是一個網址`,
  mcpInsecureAddress: (url: string) => `「${url}」不是 HTTPS（純 HTTP 只能連到這台電腦上的伺服器）`,
  mcpNotJson: '它的回應不是 JSON 物件',
  mcpUnreachable: (why: string) => `連不上這個伺服器：${why}`,
  mcpUnresolved: (host: string, why: string) => `找不到 ${host} 的位址${why ? `：${why}` : ''}`,
  mcpLookupSlow: (seconds: number) => `查詢超過 ${seconds} 秒還沒有結果`,
  mcpNearbyAddress: (host: string) => `${host} 指向這台電腦或區域網路上的位址：不在這台電腦上的伺服器，它的登入只能連到網際網路上的位址`,
  mcpMetadataFailed: (url: string, why: string) => `讀不到它的受保護資源中繼資料（${url}）：${why}`,
  mcpNoResourceMetadata: '它要求登入，卻沒有說要到哪裡登入：它沒有提供受保護資源中繼資料（RFC 9728）',
  mcpOtherResource: (resource: string) => `它的中繼資料是另一個資源的（${resource}），不是這個伺服器的`,
  mcpNoAuthServer: '它的中繼資料沒有列出授權伺服器',
  mcpNoAuthServerMetadata: (issuer: string) => `授權伺服器 ${issuer} 沒有提供中繼資料（RFC 8414 或 OpenID）`,
  mcpOtherIssuer: (issuer: string) => `授權伺服器的中繼資料寫的是另一個發行者（${issuer}）`,
  mcpNoEndpoints: (issuer: string) => `授權伺服器 ${issuer} 的中繼資料沒有授權或權杖端點`,
  mcpNoPkce: (issuer: string) => `授權伺服器 ${issuer} 不支援 S256 的 PKCE，而 Harness Relay 一定要用它`,
  mcpNoRegistration: (issuer: string) =>
    `授權伺服器 ${issuer} 不讓 Harness Relay 自己註冊（它不支援動態用戶端註冊），所以 Harness Relay 目前還不能登入它。如果這個服務提供存取權杖（例如 GitHub 的 personal access token），請按「編輯」，加一個 HTTP 標頭：名稱填 Authorization，值填 Bearer <你的權杖>`,
  mcpRegistrationFailed: (issuer: string, why: string) => `在 ${issuer} 註冊用戶端被拒絕了：${why}`,
  mcpSignInNotHttp: (name: string) => `MCP 伺服器「${name}」不是 HTTP 伺服器：只有 HTTP 的 MCP 伺服器能登入`,
  mcpSignInCannotStart: (name: string, why: string) => `無法開始 MCP 伺服器「${name}」的登入：${why}`,
  mcpNoSignIn: (name: string) => `MCP 伺服器「${name}」沒有要求登入：不登入就能用它`,
  mcpServerChanged: (name: string) => `登入的時候，MCP 伺服器「${name}」被移除了，或是它的網址改了：請重新登入`,
  mcpLeftOutSignIn: (name: string, why: string) =>
    `這一輪沒有給 MCP 伺服器「${name}」：它的登入已經失效${why ? `（${why}）` : ''}。請到「設定 → App 與工具 → 工具庫 → MCP 伺服器」重新登入。`,
  mcpLeftOut: (name: string, why: string) => `這一輪沒有給 MCP 伺服器「${name}」：${why}`,
  watchNoAccount: '找不到這個自動任務要檢查的郵件帳號：請到「設定 → App 與工具 → 常用 App → 郵件」新增，或重新選一個',
  watchNoPassword: (name: string) => `讀不到郵件帳號「${name}」的密碼：請到「設定 → App 與工具 → 常用 App → 郵件」重新輸入`,
  watchNoFolder: (folder: string, why: string) => `打不開資料夾「${folder}」：${why}`,
  watchBadTrigger: '要等待的事情設定得不完整：請選一個來源，以及它的帳號或行事曆',
  watchNotEvent: '這個自動任務不是「當某件事發生時」，沒有東西可以檢查',
  watchNoScheduler: '這個伺服器沒有在檢查自動任務等待的事情：請重新啟動 Harness Relay',
  watchFailedNote: (why: string) => `自動任務等待的事情發生了，但它的訊息無法送出：${why}`,
  watchNoCalendar: '找不到這個自動任務要檢查的行事曆：請到「設定 → App 與工具 → 常用 App → 行事曆」新增，或重新選一個',
  watchNoCalendarPassword: (name: string) => `讀不到行事曆「${name}」的密碼：請到「設定 → App 與工具 → 常用 App → 行事曆」重新輸入`,
  watchBadMinutes: (max: number) => `行程開始前的分鐘數要是 1 到 ${max} 的整數`,
  watchBadRepo: '請填 GitHub 儲存庫，格式是「擁有者/名稱」，例如 octocat/hello-world',
  watchBadPattern: '請填工作目錄中的檔案樣式，例如 reports/*.csv（不能是絕對路徑，也不能有 ..）',
  watchNoGh: '找不到 GitHub CLI（gh）：請先安裝它，並執行 gh auth login 登入',
  watchGhSignedOut: 'GitHub CLI（gh）還沒有登入：請在終端機執行 gh auth login',
  watchGhFailed: (repo: string, why: string) => `無法讀取 GitHub 儲存庫 ${repo}：${why}`,
  watchBadBranch: '分支名稱不是 git 接受的名稱：不能有空白或 ~^:?*[\\，不能有 ..，也不能以 - 開頭',
  watchTriggerCount: (max: number) => `一個自動任務可以等 1 到 ${max} 件事`,
  watchSameTrigger: '有兩件要等的事一樣（同一個來源，例如同一個郵件帳號和資料夾）：請修改或移除其中一件',
  watchGhTimedOut: (repo: string) => `GitHub CLI（gh）一分鐘內沒有回答 ${repo} 的情況：下次檢查會再試`,
  watchGhNoJson: (repo: string) => `GitHub CLI（gh）對 ${repo} 的回答不是 JSON：請更新 gh`,
  watchNoCwd: (cwd: string) => `工作目錄「${cwd}」不存在`,
  watchCwdNoAccess: (cwd: string) => `沒有權限讀取工作目錄「${cwd}」：請檢查這個資料夾的權限`,
  watchCwdUnreadable: (cwd: string, code: string) => `讀不到工作目錄「${cwd}」（${code}）`,
  watchTooManyEntries: (max: number) =>
    `要看過的檔案和資料夾超過 ${max.toLocaleString('zh-TW')} 個，無法每次都看一遍：請在樣式裡寫出要看的資料夾，例如用 reports/*.csv 而不是 **/*.csv`,
  watchTooManyFiles: (max: number) => `符合樣式的檔案超過 ${max.toLocaleString('zh-TW')} 個：請把樣式縮小一點，例如寫出資料夾`,
  hookTooOften: (seconds: number) => `這個 webhook 每 ${seconds} 秒最多呼叫一次`,
  hookNeedsSchedule: '請先設定自動任務，再建立 webhook',
  browserNotFound: (path: string) => `「${path}」不是檔案：請填瀏覽器執行檔的完整路徑`,
  hookGoalReached: '這個自動任務追蹤的目標已經達成；重新開啟它之後才能再呼叫',
  hookBodyTooLarge: (kb: number) => `webhook 的內容最多 ${kb} KB`,
  outboxInterrupted: 'Harness Relay 在送出時停止了，不確定有沒有送出；沒有再送一次。',
  outboxNotFound: '找不到這個待送出的項目',
  outboxDecided: '這個項目已經處理過了',
  outboxNoTool: (tool: string) => `沒有工具能送出這個項目（${tool}）`,
  outboxSentNote: (title: string, result: string) => `已送出「${title}」：${result}`,
  outboxFailedNote: (title: string, why: string) => `「${title}」沒有送出：${why}`,
  outboxDiscardedNote: (title: string) => `已捨棄「${title}」，沒有送出。`,
  outboxTakenBack: '要求送出它的回覆已被收回，所以沒有送出。',
  // What a call of Harness Relay's own tools shows the user (approval and outbox cards)
  /** Harness Relay's own mail and calendar clients: what a card, Test or Find calendars shows (a server's own words after it). */
  conn: {
    timedOut: (host: string, port: number, seconds: number) => `${host}:${port} 在 ${seconds} 秒內沒有回應`,
    connectFailed: (host: string, port: number, why: string) => `連不上 ${host}:${port}：${why}`,
    tlsSlow: (host: string) => `與 ${host} 的 TLS 沒有及時開始`,
    tlsFailed: (host: string, why: string) => `與 ${host} 的 TLS 失敗：${why}`,
    mailTooMuch: '郵件伺服器送來的內容超過一個回應能有的大小',
    mailAnnouncedTooMuch: '郵件伺服器宣告的內容超過一個回應能有的大小',
    mailReplyTooMuch: '郵件伺服器送來的內容超過一個回覆能有的大小',
    mailClosed: '郵件伺服器關閉了連線',
    mailRefused: (text: string) => `郵件伺服器拒絕連線：${text}`,
    mailLogin: (why: string) => `郵件伺服器不接受這組使用者名稱與密碼：${why}`,
    mailTokenRefused: (why: string) => `郵件伺服器不接受登入的權杖：${why}`,
    mailTokenFailed: (why: string) => `郵件伺服器沒有完成以權杖的登入：${why}`,
    mailNoXoauth2: (host: string, said?: string) => `郵件伺服器 ${host} 不接受以權杖登入（XOAUTH2）${said ? `：${said}` : ''}`,
    mailNoAnswer: (seconds: number) => `郵件伺服器在 ${seconds} 秒內沒有回應`,
    mailIdleEnded: (line: string) => `郵件伺服器結束了等待新郵件的連線：${line}`,
    calTooMuch: '行事曆送來的內容超過一個回應能有的大小',
    calListFailed: '列出活動失敗',
    calAddFailed: '新增活動失敗',
    calFindFailed: '尋找行事曆失敗',
    calLogin: (what: string, status: number) => `${what}：行事曆不接受這組使用者名稱與密碼（${status}）`,
    calMoved: (what: string, where: string) => `${what}：行事曆在另一個位址（${where}），請改用那個位址`,
    calStatus: (what: string, status: string) => `${what}：行事曆回應 ${status}`,
    accountGone: '卡片顯示的帳號已經不在了：沒有寄出任何東西',
    noMail: (name?: string) => (name ? `沒有「${name}」這個郵件帳號` : '還沒有設定郵件帳號'),
    noCalendar: (name?: string) => (name ? `沒有「${name}」這個行事曆` : '還沒有設定行事曆'),
  },
  gw: {
    open: (url: string) => `開啟 ${url}`,
    openReason: '在它自己的瀏覽器中開啟這個網頁',
    openNearbyReason: '在它自己的瀏覽器中開啟這個網頁。它在這台電腦或區域網路上：允許之後，它的網頁也能連到這個主機的這個 port。',
    mailSent: (id: string, host: string, answer: string) => `${host} 已收下 ${id}${answer ? `（${answer}）` : ''}`,
    inviteSent: (calendar: string) => `已加到「${calendar}」，邀請由行事曆寄出`,
    click: (what: string) => `在開啟的網頁上點擊${what}`,
    refLink: (label: string, href: string) => `連結「${label}」（${href}）`,
    refButton: (label: string) => `按鈕「${label}」`,
    refField: (name: string, label: string) => `欄位${name ? ` ${name}` : ''}${label ? `「${label}」` : ''}`,
    refGone: (n: number) => `元素 ${n}（不在最新的快照中）`,
    type: (field: string, enter: boolean) => `在${field}輸入下面的文字${enter ? '，然後按 Enter' : ''}`,
    typed: (text: string, length: number) => (text.length < length ? `${text}…（共 ${length} 個字元）` : text),
    draft: (to: string, subject: string) => `存一封草稿給 ${to}：「${subject}」`,
    mail: (to: string, subject: string) => `寄信給 ${to}：「${subject}」`,
    addEvent: (summary: string, when: string, calendar: string) => `把「${summary}」（${when}）加進行事曆「${calendar}」`,
    invite: (who: string, summary: string) => `邀請 ${who} 參加「${summary}」`,
    noSubject: '（沒有主旨）',
    fields: {
      from: '寄件人',
      to: '收件人',
      cc: '副本',
      bcc: '密件副本',
      subject: '主旨',
      event: '活動',
      when: '時間',
      where: '地點',
      invites: '邀請',
      calendar: '行事曆',
    },
  },
  mcpNameReserved: (name: string) => `「${name}」是 Harness Relay 自己工具的名稱（relay，以及 relay_ 開頭的名稱），請換一個`,
  connectorTooMany: (max: number) => `最多 ${max} 個帳號`,
  connectorNameTaken: (name: string) => `已經有叫「${name}」的帳號了`,
  connectorPasswordRequired: '請輸入密碼（建議用應用程式專用密碼）',
  connectorPasswordAgain: '伺服器的位址換了，請再輸入一次密碼（保存的密碼只會送到原本的伺服器）',
  connectorPasswordNotSaved: (e: string) => `無法把帳號的密碼存進金鑰儲存區，帳號沒有儲存：${e}`,
  connectorNotFound: (id: string) => `找不到帳號：${id}`,
  connectorBadHost: (field: string) => `${field} 的主機名稱無效`,
  connectorBadPort: (field: string) => `${field} 的連接埠應為 1 到 65535`,
  connectorPlainRemote: (field: string) => `${field} 只有連到這台電腦時才能不加密`,
  connectorRelayPort: (field: string) => `${field} 不能是 Harness Relay 自己的連接埠`,
  connectorBadAddress: (field: string) => `${field} 不是有效的電子郵件地址`,
  connectorBadUrl: '行事曆網址應為 https（連到這台電腦時可以用 http），而且不能含帳號密碼',
  connectorTestOk: '連線成功，帳號與密碼可以使用。',
  connectorTestOkSignedIn: '連線成功，登入可以使用。',
  connectorTestFailed: (why: string) => `連不上：${why}`,
  connectorDiscoverFailed: (why: string) => `找不到行事曆：${why}`,

  // HTTP
  unknownProvider: (p: string) => `未知的 provider：${p}`,
  dirNotFound: (cwd: string) => `目錄不存在：${cwd}`,
  keyringFailed: (e: string) => `無法把 API key 存進金鑰儲存區：${e}`,
  noLogin: '沒有進行中的登入',
  unknownAccount: (provider: string, id: string) => `${provider} 沒有這個帳號：${id}`,
  tooManyAccounts: (provider: string, max: number) => `${provider} 最多 ${max} 個帳號（含預設帳號）`,
  badAccountLabel: (max: number) => `帳號名稱最多 ${max} 個字，不能換行`,
  defaultAccountStays: '預設帳號不能移除',
  accountBusy: '有對話正在執行，或首席助理正在替對話分群或調整團隊。請等它們結束（或停止對話、關閉團隊設定）再移除帳號。',
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
  badLimit: (name: string, min: number, max: number) => `agent「${name}」的上限無效：須介於 ${min} 與 ${max} 之間`,
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
  desktopLangNotHere: '只有在執行 Harness Relay 的這台電腦上，桌面 app 自己的視窗才能設定它選單的語言。',
  agentHomeTooBroad: (dir: string) => `請用一個專用的資料夾（例如 ~/.relay-agents），不要用 ${dir}`,
  agentHomeCreateFailed: (dir: string, reason: string) => `無法建立資料夾 ${dir}（${reason}）`,
  agentHomeNotAbsolute: (dir: string) => `請填完整路徑，或以 ~ 開頭的路徑（例如 ~/.relay-agents），不要用 ${dir}`,
  agentHomeInside: (dir: string, folder: string) =>
    `${dir} 在 ${folder} 裡面：那裡的快照會把各 CLI 的登入與 session 紀錄一起收進去。請選這個資料夾以外的位置，例如 ~/.relay-agents`,
  agentHomeBusy: '有對話正在執行，或首席助理正在替對話分群或調整團隊。請等它們結束（或停止對話、關閉團隊設定）再更改各 CLI 自己的資料夾。',
  agentsViewLinkInvalid: (url: string) =>
    `開啟 AgentsView 的網址無效：${url}。請填 http:// 或 https:// 開頭的網址，例如 https://my-computer.tail1234.ts.net:9999`,
  agentsViewUrlInvalid: (url: string) => `AgentsView 網址無效：${url}。只接受這台電腦上的 http(s) 位址，例如 http://127.0.0.1:8080`,

  // Tool library
  badMcpName: (name: string) => `MCP 伺服器名稱「${name}」無效：只能用英文字母、數字、_ 和 -，最多 40 個字`,
  badVarName: (name: string) => `名稱「${name}」無效或重複：只能用英文字母、數字、_、. 和 -，不能以數字開頭`,
  mcpNeedsCommand: '請填寫要執行的指令',
  mcpNeedsUrl: '請填寫 http:// 或 https:// 開頭的網址',
  mcpNotFound: (name: string) => `找不到 MCP 伺服器「${name}」`,
  mcpExists: (name: string) => `已經有名為「${name}」的 MCP 伺服器`,
  tooManyMcp: (n: number) => `最多可以設定 ${n} 個 MCP 伺服器`,
  secretsFailed: (e: string) => `無法把 MCP 伺服器的變數存進金鑰儲存區：${e}`,
  secretsUnreadable: (name: string) =>
    `讀不到 MCP 伺服器「${name}」存在金鑰儲存區的值（可能被鎖住了，或加密它們的金鑰檔不見了），請重新輸入每個值，或解鎖後重新啟動 Harness Relay。`,
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
  nativeAsRunFailed: (cli: string, detail: string) =>
    `依 Harness Relay 啟動 ${cli} 的方式再問一次時失敗，所以沒有標示哪些項目不載入：${detail}`,
  nativeAsRunPartial: (cli: string) => `依 Harness Relay 啟動 ${cli} 的方式再問一次時逾時：已回答的部分有標示不載入的項目，其餘沒有標示。`,

  // Files
  previewSnapshotChanged: '複製期間檔案有變動。請在編輯結束後重建預覽。',
  previewSnapshotLimit: '這個資料夾超過預覽上限。請選較小的資料夾（最多 4,096 個項目、32 層、每個檔案 16 MiB、合計 64 MiB）。',
  fileNotFound: '找不到這個檔案或資料夾（只能瀏覽工作目錄裡的內容）',
  zipTooBig: (items: number, gb: number) =>
    `這個資料夾太大，無法打包成 zip：最多 ${items.toLocaleString('zh-TW')} 個檔案與資料夾、共 ${gb} GB。請下載其中的子資料夾。`,
  fileRootNotFound: '這個資料夾已經不存在',
  // Changing files from the Files panel (fileEdit.ts)
  filesEdit: {
    worktreeReadOnly: '助理的 worktree 在這裡只能檢視：要改動工作目錄，請套用它的結果。',
    relayFolder: '「檔案」不會改動這個資料夾：裡面有 Harness Relay 本身、它的資料或語音輸入的資料夾。',
    agentFolder: (folder: string) =>
      `「檔案」不會改動這個資料夾：它包含 ${folder}，那裡決定助理怎麼執行（家目錄或某個程式助理自己的資料夾）。`,
    link: '「檔案」不會透過符號連結寫入：請到它實際所在的位置開啟。',
    protectedPath: '「檔案」不會寫入這裡：Harness Relay 不讓助理碰這個位置（它的資料、瀏覽器的設定檔或存放權杖的檔案）。',
    isFolder: (name: string) => `這裡已經有一個叫「${name}」的資料夾。`,
    readOnlyFile: (name: string) => `「${name}」是唯讀檔案。`,
    badName: (name: string, problem: FileNameProblem) =>
      `「${name}」不能當檔名：${
        {
          empty: '請輸入檔名。',
          separator: '檔名不能有 / 或 \\。',
          dots: '「.」和「..」不是檔名。',
          control: '檔名不能有控制字元或不完整的字元。',
          reserved: '檔名不能有 < > : " | ? *、不能以句點或空格結尾，也不能是 Windows 保留給裝置的名稱（CON、NUL、COM1…）。',
          git: '.git 是 git 自己的資料夾。',
          tooLong: '檔名最多 255 個位元組。',
        }[problem]
      }`,
    notText: '這裡只能儲存文字：不能有 NUL 字元或不完整的字元。',
    textTooLarge: (kb: number) => `內容太大，無法在這裡儲存：最多 ${kb} KB 的文字。`,
    uploadTooLarge: (name: string, mb: number) => `「${name}」太大，無法上傳：最多 ${mb} MB。`,
    tooLarge: '要傳送的內容太大。',
    exists: (name: string) => `「${name}」已經存在。`,
    changed: (name: string) => `你開啟「${name}」之後，它已經被改過了。請重新載入以查看最新版本。`,
    gone: (name: string) => `「${name}」已經不在了。`,
    moved: '儲存期間資料夾有變動，請再試一次。',
    cannotWrite: (name: string, why: string) => `無法寫入「${name}」（${why}）。如果有其他程式開著它，請先關閉再試一次。`,
    busy: '有任務正在改動這個資料夾裡的檔案（這個對話或其他對話的團隊）。請等它結束後再儲存。',
  },

  // Workspace
  gitMissing: '這個操作需要 Git。請安裝 Git 後再試一次。',
  gitInstallUnavailable: '這台電腦目前無法自動安裝 Git。',
  gitInstallStillMissing: '安裝程式結束後，Harness Relay 仍找不到可用的 Git。',
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
  copilotTokenUnconfirmed: (said?: string) =>
    `Copilot 接受這個 GitHub token，卻沒有回報它的方案，所以無法確認這個帳號能不能使用 Copilot${said ? `：${said}` : '。'}`,
  logoutFailed: (code: number | null) => `logout 失敗（exit ${code}）`,
  codexLoginFailed: (code: number | null) => `codex login 失敗（exit ${code}）`,
  codexModelsFailed: 'codex debug models 失敗',
  grokModelsEmpty: 'grok models 沒有回傳模型',
  cursorModelsFailed: 'cursor-agent 沒有回傳模型清單',
  antigravityModelsFailed: 'agy models 沒有回傳模型',
  copilotModelsFailed: 'Copilot 沒有回傳模型',
  museSkillsFailed: 'muse skills list 沒有回傳技能清單',
  // Installing a CLI from Settings
  cliInstallRunning: (cli: string) => `${cli} 正在安裝中，請等它完成或先取消。`,
  cliInstallNone: (cli: string) => `目前沒有進行中的 ${cli} 安裝`,
  cliAlreadyInstalled: (cli: string) => `Harness Relay 已經安裝了 ${cli}。要重新安裝，請先移除它。`,
  cliNotInstalledHere: (cli: string) => `${cli} 不是透過 Harness Relay 安裝的，這裡沒有可以移除的東西。`,
  cliRemoveBusy: (cli: string) => `有對話正在執行，或首席助理正在替對話分群或調整團隊。請等它們結束（或停止對話）再移除 ${cli}。`,
  cliInstallBlocked: (cli: string, block: CliInstallBlock) =>
    block === 'system'
      ? `Harness Relay 無法在這個系統上安裝 ${cli}，請照它官方頁面的說明安裝。`
      : block === 'npm'
        ? `安裝 ${cli} 需要 npm（隨 Node.js 一起安裝），但在 PATH 上找不到 npm。請先安裝 Node.js（https://nodejs.org）。`
        : block === 'gitBash'
          ? `在 Windows 上安裝 ${cli} 需要 Git for Windows 附的 bash（Git Bash），但找不到。請安裝 Git for Windows（https://git-scm.com/download/win；MinGit 沒有附 bash）。`
          : block === 'powershell'
            ? `安裝 ${cli} 需要 Windows PowerShell，但找不到。`
            : block === 'tar'
              ? `安裝 ${cli} 需要 tar 來解開 Node.js 的下載檔（在 Windows 上是 System32 裡的那個），但找不到。`
              : `安裝 ${cli} 需要 ${block}，但在 PATH 上找不到。`,
  cliInstallFailed: (command: string, code: number | null) => `${command} 失敗（exit ${code}）。它的輸出在下方。`,
  cliInstallTimedOut: (command: string) => `${command} 執行太久，已經停止。`,
  cliInstallNoProgram: (path: string) => `安裝程式跑完了，卻沒有留下它的程式 ${path}。`,
  cliInstallDoesNotRun: (detail: string) => `裝好的程式無法執行（--version）：${detail}`,
  sandboxSetupRunning: '沙箱需要的東西正在安裝中，請等它完成或先取消。',
  sandboxSetupNone: '目前沒有進行中的沙箱安裝',
  sandboxSetupCannotStop: '系統的套件管理工具正以系統管理員身分安裝中，中途停止可能讓它的資料庫需要修復，所以無法取消；請等它完成。',
  sandboxSetupNothing: '這台電腦上沒有缺少、而且 Harness Relay 能安裝的沙箱元件。',
  sandboxSetupNoAdmin:
    '這裡沒辦法取得系統管理員權限（不是 root、sudo 需要密碼、也沒有桌面環境能顯示 pkexec 的密碼視窗），所以沒有安裝套件：請在終端機執行下方的指令。',
  sandboxSetupAdminRefused:
    '沒有輸入系統管理員密碼（或不允許、或無法顯示密碼視窗），所以什麼都沒安裝。可以再試一次，或在終端機執行下方的指令。',
  sandboxSetupStillMissing: (items: string) => `安裝跑完了，但還是缺少：${items}。輸出在下方。`,
  cliNodeDoesNotRun: (linux: boolean): string =>
    linux
      ? '放進資料夾的 Node.js 在這台電腦上無法執行（輸出在下方）。Node.js 的 Linux 版本需要 glibc 2.28 以上與 libatomic（Debian 與 Ubuntu 的 libatomic1 套件，Fedora 的 libatomic）：缺 libatomic 的話請安裝它，或自行安裝附 npm 的 Node.js，再試一次。'
      : '放進資料夾的 Node.js 在這台電腦上無法執行（輸出在下方）：請自行安裝附 npm 的 Node.js，再試一次。',
  cliNodeChecksum: (url: string, expected: string, actual: string) =>
    `下載的 Node.js（${url}）和 Harness Relay 記下的檢查碼不符，所以沒有使用它：應為 SHA-256 ${expected}，實際是 ${actual}。`,
  cliInstallCancelled: '已取消安裝',
  cliRemoveFailed: (dir: string, detail: string) => `無法刪除 ${dir}：${detail}`,
  cliRemoving: (cli: string) => `正在移除 ${cli}，請等它移除完。`,
  cliUserPathUnread: (detail: string) => `無法讀取你的使用者 PATH，所以沒有執行安裝程式（它跑完後，PATH 會還原成執行前的樣子）：${detail}`,
  cliUserPathNotBack: (detail: string) =>
    `無法把你的使用者 PATH 還原成安裝程式執行前的樣子：${detail}。Harness Relay 下次啟動時，或下次執行安裝程式之前，會再試一次。`,
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
    museMeta: ['Meta 帳號', '開啟下方連結，在任何一台裝置的瀏覽器登入 Meta 帳號，確認頁面上的代碼和下方的一樣。'],
  } as Record<string, [string, string]>,
};

export type ServerMessages = typeof zhTW;

const en: ServerMessages = {
  handoffs: {
    storage: 'There is no credential store on this computer to keep secrets in.',
    badName: (name) => `"${name}" is not a valid secret name: capital letters, digits and underscores only, not starting with a digit.`,
    badValue: (name, problem) =>
      problem === 'empty'
        ? `${name} is empty.`
        : problem === 'long'
          ? `${name} is too long (16 KB at most).`
          : `${name} cannot have line breaks.`,
    tooManySecrets: (n) => `A working directory keeps ${n} secrets at most.`,
    secretNotFound: (name) => `This working directory has no secret named ${name}.`,
    commandNotFound: 'This fixed command was not found; it may have been removed.',
    tooManyCommands: (n) => `A working directory keeps ${n} fixed commands at most.`,
    tooManyFiles: (n) => `This folder has more than ${n} code and configuration files, too many to pin a fixed command's code to.`,
    windows: "Fixed commands run in Harness Relay's own sandbox, which native Windows does not have yet.",
    missingSecrets: (names) => `These secrets were not given yet: ${names}.`,
    inputTooLong: (n) => `The input for the command is too long (${Math.round(n / 1024)} KB at most).`,
    timedOut: (min) => `It ran for more than ${min} minutes and was stopped.`,
    hostsRefused: (hosts) => `The sandbox refused the hosts it tried to reach: ${hosts}. Add them to this fixed command if it needs them.`,
    networkRefused: 'The sandbox refused its network connection.',
    sandboxRefused: 'The sandbox refused something it tried to do (such as writing outside the working directory).',
    noCommand: (name) => `This working directory has no fixed command named "${name}", so nothing was put in the outbox.`,
    outboxTitle: (name) => `Run the fixed command "${name}" once`,
    fieldCommand: 'Command',
    fieldFolder: 'Folder',
    fieldHosts: 'Hosts it may reach',
    cardNotFound: 'This card was not found.',
    cardDecided: 'This card was answered already.',
    noValues: 'Fill in at least one value, or choose not to give them.',
    badCommand: "This fixed command is not valid: check its name, command, hosts and secrets' names.",
    commandRunning: 'This fixed command is running; wait until it ends.',
    commandDismissed: (name) => `I did not save the fixed command "${name}".`,
    commandAnswer: (name, run) =>
      run
        ? `I saved the fixed command "${name}" and tried it once: ${runLineEn(run)}.${run.output ? `\n\nIts output (secrets masked):\n${fenced(run.output)}` : ''}`
        : `I saved the fixed command "${name}".`,
    secretsAnswer: (saved, declined) =>
      [
        saved.length
          ? `I gave ${saved.join(', ')}: kept in this working directory's credential store, for the fixed commands that name ${saved.length > 1 ? 'them' : 'it'} only.`
          : '',
        declined.length ? `I will not give ${declined.join(', ')} for now.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    notKept: (why) => `The new value it wrote back was not kept: ${why}`,
    commandChangedSince: (name) => `The fixed command "${name}" changed after this run was put in the outbox, so it was not run.`,
    runLine: runLineEn,
  },
  publish: {
    unreachable: (host: string) => `${host} could not be reached, or its answer could not be read. Try again in a moment.`,
    badAnswer: 'The cloud service answered in a form Harness Relay does not expect.',
    renderKey: 'The Render API key is not valid. Create one in Render under Account settings → API Keys and paste it here.',
    renderPayment: 'Render asks for payment information in this workspace before it creates a service.',
    renderScope: (scope) =>
      `The Render API key lacks a permission publishing needs${scope ? ` (${scope})` : ''}. Create a key in Render under Account settings → API Keys with Services: Read & write, its environment variables: Write, and Deploys: Run, and save it here in its place.`,
    renderNoOwner: 'This Render key reaches no workspace.',
    rateLimited: (host: string) => `${host} is limiting requests for now. Wait a moment and try again.`,
    renderFailed: (detail: string) => `Render refused the request: ${detail}`,
    repoAccess: (link: string) =>
      `Render cannot read the GitHub repository. Let Render's GitHub app access it (all repositories, or this one added): ${link}, then publish again.`,
    renderName: (name: string) => `Render already has a service named "${name}". Choose another name.`,
    serviceGone: "This app's service was deleted on Render. Unpublish it, then publish it again.",
    neonKey:
      'The Neon API key is not valid. Create a personal one in Neon (your account menu → Settings → Personal API keys) and paste it here.',
    neonFailed: (detail: string) => `Neon could not make or read the database: ${detail}`,
    workspace: "This npm workspace member's folder name cannot be used in Render's commands.",
    onlyDatabase: 'This compose file runs only a database: there is no app service to publish.',
    composeService: (name: string) =>
      `Render's free plan runs one service, and this compose file also has "${name}". Only a compose file with one app service and PostgreSQL can be published.`,
    composeBuild: (name: string) => `The service "${name}" has no build: Render builds it from the project's Dockerfile.`,
    composeBuildOptions: (name: string) =>
      `The service "${name}" builds with build arguments, a target or an inline Dockerfile, which Render's build does not take.`,
    composeMounts: (name: string) =>
      `The service "${name}" mounts project files. Render builds the image from the Dockerfile alone, so they would be missing.`,
    composeEntrypoint: (name: string) =>
      `The service "${name}" overrides its entrypoint, which Render does not take. Set it in the Dockerfile.`,
    noGh: 'Publishing needs the GitHub CLI (gh), to make a private repository and push the files to it.',
    github: (detail: string) => `GitHub did not complete the request: ${detail || 'no details'}`,
    repoExists: (name: string) => `Your GitHub account already has a repository named "${name}". Choose another name.`,
    push: (detail: string) => `The files could not be pushed to GitHub: ${detail || 'no details'}`,
    otherWorkspace: (name: string) =>
      `"${name}" was published in another Render workspace, which the current key does not reach. Use a key for that workspace to update or unpublish it.`,
    databasesChanged:
      "This app's databases differ from its last publish (its compose file has another PostgreSQL service, say). Unpublish it, then publish it again.",
    initMeta: (name: string, command: string) =>
      `${name} uses psql's own commands (${command}). Relay sends an init script to Neon as plain SQL, so keep it to SQL alone.`,
    initSize: (name: string, kb: number) => `${name} is over ${kb} KB, too long to run as an init script.`,
    initBinary: (name: string) => `${name} holds a NUL byte: it is not SQL text that can run.`,
    initTransaction: (name: string, statement: string) =>
      `${name} has ${statement}. Relay runs each init script as one transaction, so a statement that ends it, or cannot run inside one, is not supported.`,
    initChanged: (name: string) =>
      `${name} changed after it ran on the database. To run it again, unpublish the app with its database ticked, then publish it again.`,
    initFailed: (name: string, detail: string) => `Running ${name} on Neon failed: ${detail || 'no details'}`,
    storage: 'The credential store on this computer is unavailable, so the key cannot be kept.',
    interrupted: 'Harness Relay stopped during the publish. Publish again.',
    setupRender: 'Set up Render first, in Settings → Publish to the cloud: its API key and workspace.',
    setupNeon: 'This app needs a database: set up Neon first, in Settings → Publish to the cloud: its API key and organization.',
    notFound: 'This published app was not found.',
    confirmPublic: 'Confirm first that anyone with its address can open the app.',
    busy: 'This app is being published.',
    tooMany: 'Too many publishes are under way. Wait for one to finish.',
    name: 'A name has lowercase letters, digits and hyphens, at most 40 characters, and no hyphen at either end.',
    nameTaken: (name: string) => `A published app is already named "${name}".`,
    kindChanged:
      "This folder's app changed kind (from a static site to a backend, say), which Render cannot convert. Unpublish it, then publish it again.",
    deployFailed: (status: string) => `Render's deploy did not succeed (${status}). See the build logs on Render.`,
    failed: 'The publish failed.',
    notReady: "Wait until the preview's page has opened and works, then publish.",
    changed: "The folder's files changed since the preview started. Rebuild the preview, check it, then publish.",
  },
  previewDocker: {
    invalidLock: 'Invalid npm project or lockfile.',
    standalone: 'Preview does not support nested npm workspaces.',
    workspaceLock: "The workspace root's package-lock.json does not list this project. Run npm install at the workspace root to update it.",
    spec: 'Preview dependencies must use public npm registry versions.',
    lock: 'App preview requires an npm package-lock.json.',
    lockSync: (name: string) =>
      `${name} is in package.json but not in package-lock.json. Run npm install to update the lockfile, then retry the preview.`,
    config: 'Custom npm configuration and shrinkwrap are unsupported in preview.',
    lockVersion: 'Preview requires npm lockfile version 2 or 3.',
    manifest: 'App preview requires a package.json.',
    script: (name: string) => `Preview requires a ${name} script in package.json.`,
    count: 'Too many locked preview packages.',
    tarball: 'Preview requires canonical npm registry tarballs with SHA-512 integrity.',
    downloadSize: 'Locked preview packages exceed the download size limit.',
    integrity: 'Locked preview package failed its SHA-512 integrity check.',
    missing: 'The Docker CLI is missing on the computer running Relay.',
    manual:
      'Relay has no automatic installer for this system. Install Docker on the Relay computer with support for Linux x64 or arm64 containers.',
    existing: (path) => `An application exists at ${path}, but the Docker CLI is missing. Check the existing installation.`,
    launchFailed: 'Docker Desktop did not open. Check the installation log and signature verification on the Relay computer.',
    openDesktop: 'Open Docker Desktop on the Relay computer to finish first-run setup.',
    linuxAccess:
      'The Relay account cannot access the Docker socket. Set up rootless Docker for this account or ask its administrator to grant access. After a group change, sign out, sign back in, and restart Relay.',
    noWinget: 'Install Microsoft App Installer on the Relay computer to use WinGet, or install Docker Desktop manually.',
    startEngine:
      'The local Docker engine is unreachable. Start Docker Desktop on the Relay computer and finish setup, or start the Docker Engine service.',
    permission: 'The Relay user cannot access the local Docker socket. Configure a local engine this account can use.',
    local:
      'App preview requires a local Docker socket. Select a context on the Relay computer using a Unix socket or a local Windows named pipe.',
    arch: 'Preview requires Docker with Linux x64 or arm64 containers.',
    invalidDocker: 'Docker returned an invalid container ID.',
    invalidOwner: 'Invalid preview owner.',
    containerCount: 'Too many preview containers to enumerate.',
    distSize: 'Built preview exceeds the output size limit.',
    invalidFile: 'Invalid preview file path.',
    dist: 'The build must produce dist/index.html.',
    invalidOutput: 'Invalid built preview output.',
    headers: 'Preview request headers are too large.',
    body: 'Preview request body exceeds 1 MiB.',
    invalidResponse: 'Invalid preview response.',
    responseSize: 'Preview HTTP response is too large.',
    exited: 'The preview server exited.',
    context: 'Docker context',
    remove: 'Removing preview container',
    find: 'Finding preview containers',
    engine: 'Local Docker engine',
    pull: 'Downloading the pinned preview image',
    create: 'Creating preview container',
    start: 'Starting preview container',
    limits: 'Checking Docker resource limits',
    copy: 'Copying preview files',
    ci: 'Installing locked preview dependencies',
    build: 'Building preview',
    collect: 'Collecting dist output',
    server: 'Starting preview server',
    ready: 'Waiting for preview server',
    http: 'Preview HTTP request',
    failed: (step: string) => `${step} failed.`,
    timeout: (step: string) => `${step} timed out.`,
    fetch: (url: string, status: number) => `Cannot fetch locked package ${url} (HTTP ${status}).`,
    composeMissing:
      "Previewing a Dockerfile or compose project needs Docker Compose v2, which this computer's Docker lacks. Install Docker Desktop, or docker-compose-plugin on Linux.",
    imageBuild: (service: string) => `Building the image of ${service}`,
    mountCopy: (service: string) => `Copying the project files ${service} mounts`,
    composeUp: 'Starting the preview services',
    composeDown: 'Removing the preview services',
    inspect: 'Reading the preview container state',
    attach: "Connecting to the app's terminal",
    notRunning: 'The app is not running.',
    buildxMissing:
      "Building a Dockerfile needs Docker buildx, which this computer's Docker lacks. Install Docker Desktop, or docker-buildx-plugin on Linux.",
    builder: 'Preparing the preview builder',
    builderEndpoint: (name: string) =>
      `The builder ${name} is on another Docker engine. Remove it with docker buildx rm ${name}, then retry the preview.`,
    imagePull: (image: string) => `Downloading ${image}`,
    runBusy: 'The app is starting. Run it again in a moment.',
    runFailed: 'This preview failed or stopped. Rebuild the preview.',
  },
  previewCompose: {
    yaml: (detail: string) => `Cannot read the compose file: ${detail}`,
    tooLarge: 'The compose file is larger than 256 KB.',
    noServices: 'The compose file has no service to run.',
    tooMany: (max: number) => `A preview runs at most ${max} services.`,
    invalid: (where: string) => `${where} in the compose file is not valid.`,
    refused: (key: string) => `Previews do not support ${key} in a compose file: it reaches the host or other containers.`,
    remote: (where: string) => `Previews do not build from a URL or Git repository (${where}).`,
    outside: (where: string, path: string) =>
      `${path} (${where}) is outside the project folder. Previews use the project's own files only.`,
    missingFile: (path: string) => `${path} is not in the project.`,
    undeclaredVolume: (service: string, volume: string) =>
      `${service} uses the volume ${volume}, which the top-level volumes do not declare.`,
    serviceName: (name: string) => `The service name ${name} is not valid or is reserved for Relay.`,
    noImage: (service: string) => `${service} needs an image or a build.`,
    unknownDependency: (service: string, dependency: string) =>
      `${service} depends on ${dependency}, which does not exist or does not run.`,
    interpolation: (text: string) => `The variable ${text} in the compose file is not valid.`,
    required: (variable: string, message: string) =>
      `The compose file requires the variable ${variable}${message ? ` (${message})` : ''}, but previews take no variables from the host or a .env file.`,
    mountSkipped: (service: string, source: string, target: string) =>
      `Relay left out the mount ${source} → ${target} of ${service}: the project snapshot does not have it (dependencies, .env and database files are not copied).`,
    envFileSkipped: (service: string) => `Relay left out the env_file of ${service}: previews take no .env files.`,
    profileSkipped: (service: string) => `Relay left out ${service}: it belongs to a compose profile, which does not start by default.`,
  },
  previewFolderChanged: 'The working directory changed. Reopen Files and confirm the folder to preview.',
  previewTarget: 'The preview entry is missing or outside the selected workspace.',
  previewFolderEntry:
    'Choose a workspace folder containing index.html, package.json, a Dockerfile or compose.yaml, or preview an HTML file directly.',
  previewNoWay: 'It has no Dockerfile, compose file, package.json with a start or build script, or index page.',
  previewNotReady: (shown: string, reason: string) => `The app in ${shown} cannot be previewed yet: ${reason}`,
  previewManifestLimit: 'The package.json is too large to inspect. Select a smaller project or a built HTML page.',
  previewProjectEntry:
    'This folder has no way to preview it. Add a Dockerfile (and compose.yaml if it needs a database), a start or build script to package.json, or select a ready-to-serve HTML page.',
  previewOrigin: 'Open the preview from the Harness Relay interface.',
  previewRemote: 'Remote previews require a dedicated HTTPS domain. Set RELAY_PREVIEW_DOMAIN or open Relay locally.',
  previewBusy: 'A preview is starting or the preview limit has been reached. Try again shortly.',
  previewFailed: 'The preview could not start.',
  previewServiceFailed: 'The preview server stopped responding. Rebuild the preview and check its startup output.',
  previewCookie: 'Open the preview again and allow partitioned cookies for this embedded page.',

  stopped: 'Stopped',
  timedOut: 'Timed out',
  exitedWithoutReply: (cli, code) => `${cli} exited (exit ${code}) without a reply`,
  exitedWithoutTurn: (cli, code) => `${cli} exited (exit ${code}) without finishing the turn`,
  codexMcpListFailed: (detail) =>
    `Codex could not list its MCP servers, so they or their tools could not be left out of this run (${detail}). Update Codex, or clear what is left out on the MCP tools tab of "…this CLI loads by itself" in Codex's settings.`,
  codexLeftOutUnchecked: (detail) =>
    `Could not check that Codex left out the skills, hooks or plugins this run leaves out (${detail}), so it did not run. Try again, or clear them in "…this CLI loads by itself" in Codex's settings.`,
  copilotHooksUnchecked: "Copilot could not confirm that the team's hooks are loaded. The turn did not start.",
  codexHookShell: 'Codex team hooks require a POSIX shell. This turn did not start with PowerShell as the account shell.',
  codexHooksUnprotected: "The Codex edit sandbox cannot protect the team's hook program. The turn did not start.",
  codexHooksUnchecked:
    "Codex could not confirm that the team's hooks are loaded and trusted. The turn did not start. Enable hooks in Codex and use Codex 0.167.0 or newer.",
  codexNoProfile: (active) =>
    `Codex did not run this thread in the permission profile Harness Relay gave it (it answered ${active ? `"${active}"` : 'no profile'}; an older Codex that does not know the field, say), so its sandbox would not keep it out of your browsers' folders and Harness Relay's database, and it did not run. Update Codex (0.167 works) and try again.`,
  codexStillLoaded: (parts) =>
    `Codex still loaded ${parts.join(' and ')} that are left out of this run (an older Codex that does not know the setting, say). Update Codex, or clear what is left out on the ${parts.map((p) => (p === 'skills' ? 'Skills' : p === 'hooks' ? 'Hooks' : 'Plugins')).join(' and ')} ${parts.length > 1 ? 'tabs' : 'tab'} of "…this CLI loads by itself" in Codex's settings.`,
  claudePluginsFailed: (detail) =>
    `Claude Code could not list its plugins, so they could not be left out of this run (${detail}). Update Claude Code, or clear "Leave all out" on the Plugins tab of "…this CLI loads by itself" in Claude Code's settings.`,
  claudeAgentsFailed: (detail) =>
    `Claude Code's own subagents could not be left out of this run (${detail}). Update Claude Code, or clear "Leave all out" on the Subagents tab of "…this CLI loads by itself" in Claude Code's settings.`,
  claudeError: 'Claude Code reported an error',
  claudeBudgetReached: (usd) =>
    `This turn reached the member's limit of US$${usd} (by Claude Code's own estimate), so Claude Code stopped. To let it do more, raise or remove the member's limit in Team settings.`,
  claudeSandbox: (why) =>
    `Claude Code could not start its sandbox (needed below full access): ${why}. On Linux and WSL2, install bubblewrap and socat (for example sudo apt-get install bubblewrap socat), on Ubuntu 23.10 or later also an AppArmor profile for /usr/bin/bwrap (see "On Linux" in docs/sandboxing.md), and try again; or switch the permission to "Full access" to run without one.`,
  sandboxHost: 'A command in the sandbox wants to connect to this host.',
  commandNotFound: (bin) => `Command "${bin}" not found. Make sure it is installed, or set its path on the Settings page.`,
  windowsShimBroken: (bin, script, target) => `"${bin}" is ${script}, and ${target}, which it runs, is not there: install ${bin} again.`,
  windowsNoNode: (bin, script) =>
    `"${bin}" is ${script}, which runs on Node.js, and no Node.js is on the PATH: install Node.js, or add it to the PATH.`,
  windowsScript: (bin, script) =>
    `"${bin}" is the script ${script}, which Harness Relay cannot start: it starts programs only, never through a shell, and cannot tell which program this script runs. Set the path to the program it runs (an .exe) on the Settings page.`,
  permission: { 'read-only': 'Read-only', edit: 'Edit', full: 'Full access' },
  grokRefusedReadOnly: 'Not allowed in read-only mode; Grok was told to use read-only tools',
  grokRefusedPublish: 'Pushing or publishing is not allowed with edit permission',
  grokCancelledNoReason: 'Grok ended the turn by itself (stopReason: cancelled) without giving a reason.',
  grokCancelled: (tool, reason) => `Grok ended the turn while running "${tool}"${reason ? ` (${reason})` : ''}.`,
  grokCancelHint: (permission) =>
    ` The permission is "${permission}"; if this action is needed, switch the permission to "Full access" and try again.`,
  grokSandbox: (why) =>
    `Grok could not start its sandbox (needed below full access): ${why}. On Linux, the paths it may not read need bubblewrap (for example sudo apt-get install bubblewrap), and on Ubuntu 23.10 or later an AppArmor profile for /usr/bin/bwrap (see "On Linux" in docs/sandboxing.md).`,
  grokNoSession: 'grok returned no session id',
  grokModelsFailed: (path, why) => `Could not write your own endpoints' models into Grok's settings (${path}): ${why}`,
  relaySandboxWindows:
    "Harness Relay's own sandbox does not work on native Windows (the sandbox-runtime it uses is alpha there), so this agent does not run here in read-only or edit mode. Run Harness Relay in WSL2, or set the permission to full access (no sandbox).",
  relaySandboxPathTooLong: (dataDir, max) =>
    `The path of Harness Relay's data folder (${dataDir}) is too long for the sockets its sandbox makes there, so this did not run: set RELAY_DATA_DIR to a folder whose path is at most ${max} bytes (UTF-8: a character outside ASCII takes 2 to 4) and restart Harness Relay; or switch to full access.`,
  relaySandboxNoNode:
    "Harness Relay's sandbox needs Node.js 22.12 or later to run its sandbox helper, and the desktop app's own runtime cannot be used as Node: install one from Settings → Sandboxes (into Harness Relay's folder), or install Node.js yourself so that it is on your login shell's PATH, then reopen the app; or switch to full access.",
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
  relaySandboxBadHost: (entry) =>
    `${entry} is not a host the sandbox can connect to (a host name or an IP address, with :port or without), so the agent did not run.`,
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
  relaySandboxHost:
    'A program in the sandbox wants to connect to this host. Allowing it lets this run reach it (and later runs too, if you allow it always).',
  grokRejectedModel: (value, err) => `Grok does not accept the model "${value}": ${err}`,
  grokRejectedEffort: (value, err) => `Grok does not accept the reasoning effort "${value}": ${err}`,
  cursorRefused: "Refused: not covered by this conversation's permission",
  cursorReadOnlyWrite: 'Not written: Cursor may not write in read-only mode',
  cursorProtectedWrite:
    "Cursor asks before changing files like this one: a change here could make code run later, outside any sandbox (a git hook, an editor task), or change an agent's settings.",
  cursorOutsideWrite: 'This file is outside the working directory: Cursor asks before writing outside it.',
  cursorOtherCwdWrite:
    "This file is in another of the chat's working directories: Cursor works in the first one, and asks before writing in the others.",
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
  guardRefused: "Refused before writing: one of the team checks' protected paths",
  antigravityRefused: "Refused: not covered by this conversation's permission",
  antigravityProtected:
    "Refused: a protected path (browser data, Harness Relay's database…), which agents below full access may not read or write",
  antigravityEndsTurn: ' (Antigravity ends its turn after a refusal)',
  antigravityProjectSetup:
    'This project has setup Antigravity starts or runs by itself (MCP servers, hooks or plugins in a folder such as .agents): agy runs them outside any sandbox as soon as its session opens, without asking, in read-only mode too. Another agent, or whoever made the repository, may have put them there. The turn starts once you allow it; it asks again when the files change.',
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
  copilotProtected:
    "Refused: a protected path (browser data, Harness Relay's database…), which agents below full access may not read or write",
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
  copilotKeptWritable: (dir) =>
    `The turn did not start: Copilot's sandbox keeps ${dir} writable by itself (it is a temporary folder), so a read-only chat cannot keep it from being changed. Give this chat another working directory, or another permission.`,
  museRefused: "Refused: not covered by this conversation's permission",
  museProtected:
    "Refused: a protected path (browser data, Harness Relay's database…), which agents below full access may not read or write",
  museProtectedPattern: (path) =>
    `The turn did not start: the protected path ${path} has *, ? or [ in its name, which Muse Code reads as a pattern, so it cannot be denied as it is. Rename or move it, or use full access.`,
  museCommandAsked:
    "In a read-only chat every command asks first. Allowed, it runs in Muse Code's sandbox, which lets it write in the working directories.",
  museNetwork:
    "This command wants the network: Muse Code's sandbox asks about every host it reaches. Allowed, only this command may reach it, still in the sandbox.",
  museSessionGrant:
    'This Muse Code session was made with another permission (Muse keeps the one it was made with), so this turn starts a new session.',
  musePublish:
    "This command pushes or publishes beyond this computer (git push, npm publish…), or runs what it reads on standard input, which edit mode does not cover, so it asks first. Allowed, it still runs in Muse Code's sandbox.",
  museOutsideWrite: "This file is not in the chat's working directories: edit mode covers writes in them only.",
  museConfigWrite:
    "This is an agent's configuration (such as .muse/, .agents/, .git/hooks or .vscode/): a change here could make code run later outside any sandbox, or change how an agent works, so it asks first.",
  museExitCode: (code) => `exit code ${code}`,
  museCancelled: 'Muse Code ended the turn by itself (stopReason: cancelled) without giving a reason.',
  museNoSession: 'muse returned no session id',
  museRejectedMode: (err) => `Muse Code could not switch its permission mode: ${err}`,
  museSignIn: (err) => `Muse Code is not signed in (${err}). Sign in under Muse Code in Settings, or set a Meta API key.`,
  museConfigFailed: (err) => `Could not prepare Muse Code's settings for this turn: ${err}`,
  museAccountLogin:
    "On macOS Muse Code keeps its Meta sign-in in the login keychain under names its folders do not change, so another account's sign-in could replace the default one's: an extra Muse Code account runs on a Meta API key only. Only the default account signs in with a Meta account.",

  // Long-term memory
  memoryNoteNotFound: 'Memory note not found',
  memoryNoteEmpty: 'A memory note cannot be empty',
  memoryFull: (max: number) => `Long-term memory holds at most ${max} notes: delete some before adding more.`,
  memoryTidying: 'The lead agent is tidying the memory: wait until it is done.',
  memoryTidyUnparsable: "The lead agent's reply held no changes as JSON.",
  memoryReplyRemoved: 'The reply that saved it was retried or edited away',
  memoryOff: 'Long-term memory is off.',
  memoryNothingToTidy: 'There are no notes to tidy yet.',

  defaultTitle: 'New chat',
  conversationNotFound: 'Conversation not found',
  signedOut:
    'This browser is not signed in to Harness Relay. Open the sign-in link it printed in its terminal when it started, or run npm run login.',
  signedOutDesktop:
    "This browser is not signed in to Harness Relay. Choose Open in browser in the desktop app's menu (for the app's own window, Open Harness Relay): it opens with a new sign-in link.",
  signInWrongCode: 'That code is wrong or has expired.',
  signInTooMany: 'Too many wrong codes. Wait a minute and try again.',
  signInNoSession: 'No such signed-in browser.',
  alert: {
    done: (agent?: string) => (agent ? `${agent} finished replying` : 'The reply is done'),
    error: (agent?: string) => (agent ? `${agent} ran into an error` : 'The reply ran into an error'),
    approval: (agent?: string) => (agent ? `${agent} is waiting for your approval` : 'An agent is waiting for your approval'),
    confirm: (_agent?: string) => "The lead agent's team is ready for you to confirm",
    answer: (agent?: string) => (agent ? `${agent} asked you something` : 'An agent asked you something'),
    blocked: (agent?: string) =>
      agent ? `${agent} says the goal is held up and needs you` : "An automation's goal is held up and needs you",
    testTitle: 'Harness Relay',
    testBody: "Notifications are on: you'll be told here when an agent finishes or needs you.",
  },
  pushEndpointRefused: (host: string) =>
    `Harness Relay does not send notifications to "${host}": only to a browser's push service (Google's, Apple's, Mozilla's or Microsoft's), over HTTPS.`,
  pushBadKeys: "This push subscription's keys are not valid.",
  pushNotSubscribed: 'This browser has not subscribed to push notifications.',
  pushUnavailable: (detail: string) =>
    `This server cannot send push notifications now${detail ? ` (${detail})` : ''}: while Harness Relay is open, the page still tells you.`,
  pushTestFailed:
    "The test notification was not sent: the browser's push service did not take it. Turn notifications off and on again, then try once more.",
  pushTaken: 'This push subscription belongs to another signed-in browser.',
  pushGone: "The browser's push service says this subscription is gone: subscribe again.",
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
    `${cli} is to use the model "${id}", but no ${backend} API key is set up. Add one under Settings → Model connections, or pick another model.`,
  openEndpointMissing: (cli, endpoint, id) =>
    `${cli} is to use the model "${id}", but there is no custom endpoint with the id "${endpoint}". Add it under Settings → Model connections, or pick another model.`,
  endpointDeleted: (cli, endpoint, id) =>
    `${cli} is to use the model "${id}", but its custom endpoint "${endpoint}" was deleted under Settings → Model connections. The turn did not run, and was not sent to ${cli}'s own service instead. Pick another model, or add the endpoint again; if "${id}" is a model of ${cli}'s own, forget "${endpoint}" under Settings → Model connections → Deleted endpoints.`,
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
  openNoLogin: (cli) => `${cli} needs no sign-in: it uses the API keys and endpoints under Settings → Model connections.`,
  openBackendsReady: (names) => `Model connections: ${names}`,
  openNoBackend: 'No model connection set up yet (Settings → Model connections)',

  // Goose (src/server/agents/goose.ts)
  gooseSessionNotChecked: (detail) =>
    `Harness Relay could not check the extension list Goose keeps for this session (${detail}), so it did not resume it: an earlier run's command could have added a program there that starts without asking. The turn starts a fresh session instead.`,
  gooseAuthFailed: (backend) => `Goose could not sign in with the ${backend} API key. Check that key under Settings → Model connections.`,
  gooseModelNotFound: (backend, model) => `${backend} has no model "${model}" (404). Pick another model in the member's settings.`,
  gooseUnreachable: (backend, host) =>
    `Goose could not reach ${backend} (${host}). Check the network, or the endpoint's address under Settings → Model connections.`,
  // Pi (src/server/agents/pi.ts)
  piSessionMissing: (id) => `The file of session ${id} is gone (it may have been deleted)`,
  piSessionMoved: (then, now) => `the session's working directory is ${then}, this turn's is ${now}`,
  piSessionMismatch: (want, got) => `Pi opened session ${got}, not ${want}`,
  piGateMissing:
    "Harness Relay's gate extension did not load in Pi (it asks about every tool call before it runs), so this turn did not start. Check that src/server/agents/piGate.js is in Harness Relay's folder.",
  piGateWritable: (path) =>
    `Harness Relay's gate extension (${path}) is inside a folder this turn may write, so Pi did not run. Pick another working directory.`,
  piModelMismatch: (want, got) => `Pi picked the model "${got}", not "${want}"`,
  piEffortLevels: (levels) => `this model takes: ${levels}`,
  piPromptRejected: (e) => `Pi did not take this turn's message: ${e}`,
  piKeyRejected: (backend, e) => `${backend} rejected the API key (${e}). Check it under Settings → Model connections.`,
  piModelRejected: (model, backend, e) => `${backend} has no model "${model}" it can use (${e}). Pick another model.`,
  piUnreachable: (backend, e) => `Could not reach ${backend}: ${e}`,
  piEndpointUnreachable: (name, url, e) =>
    `Could not reach the endpoint "${name}" (${url}): ${e}. Check that the server is running and the address is right.`,
  piModelError: (e) => `The model reported an error: ${e}`,

  // Cline (src/server/agents/cline.ts)
  clineBadKey: (where, e) => `The model backend "${where}" refused Cline's API key: ${e}. Check the key in Settings → Model connections.`,
  clineBadModel: (model, where, e) =>
    `The model backend "${where}" has no model "${model}" for Cline: ${e}. Pick a model this backend offers.`,
  clineUnreachable: (where, e) =>
    `Cline cannot reach the model backend "${where}": ${e}. Check that the endpoint is running and its URL is right (Settings → Model connections).`,
  clineFailed: (e) => `Cline did not finish this turn: ${e}`,
  // OpenHands (agents/openhands.ts)
  openhandsSubagentRefused: "Not allowed below full access: OpenHands' subagents run commands and edit files without asking",
  openhandsNoSuchSession: 'its session folder holds no such session',
  openhandsBadKey: (backend) => `${backend} refused the API key OpenHands used (401). Check the key under Settings → Model connections.`,
  openhandsBadModel: (backend, model) =>
    `${backend} has no model "${model}", or this key cannot use it. Pick another model for this member.`,
  openhandsUnreachable: (backend, e) => `OpenHands could not reach the model backend ${backend}: ${e}`,
  openhandsRateLimited: (backend, e) => `${backend} turned OpenHands' requests away for now (quota or rate limit): ${e}`,
  openhandsTerminal: (e) => `OpenHands could not start its terminal (tmux): ${e}`,
  openhandsFailed: (e) => `OpenHands did not finish this turn: ${e}`,
  openhandsNoCatalog: "LiteLLM's model list was not found in the OpenHands install",
  openhandsUnknownAction: 'Not allowed by itself: Harness Relay could not tell which OpenHands action this is',
  openhandsLeftover: (n) =>
    `its session still holds ${n} action(s) left unfinished by an earlier turn (stopped or cut off), which must not run without asking`,
  openhandsAction: 'OpenHands action',
  openhandsBatchTitle: (title, more) => `${title} (+${more} more)`,
  openhandsBatch: (n, calls) => `One answer covers all ${n} actions:\n${calls.map((c) => `• ${c}`).join('\n')}`,
  openhandsNoTerminal:
    'Below full access OpenHands runs only with a terminal in the sandbox: turn on "Let OpenHands use a terminal in the sandbox: its commands can then read and write your other terminal windows" under Settings → OpenHands (its commands can then print text into your other terminal windows, read what you type there and change their settings, but still cannot type into them), or give this conversation full access.',
  openhandsStuck:
    'OpenHands stopped this turn by itself: its stuck detector found it repeating the same action (or getting the same error) without getting anywhere. Ask again, put it differently, or pick another model for this member.',
  openhandsBatchRefused: 'Refused along with the rest of its batch: OpenHands asks once for all of them, and another one is not allowed',
  openhandsOddLog:
    "its session's history is not laid out as OpenHands writes it (something else may have changed it), so Harness Relay cannot tell which of its actions OpenHands would run without asking",
  openhandsNoEffort: (backend, model) =>
    `${backend}'s model "${model}" takes no reasoning effort. Set this member's effort to none (or the default).`,
  openhandsSandboxRefusedReadOnly: "Harness Relay's sandbox refused it: this conversation is read-only.",
  openhandsSandboxProtected:
    "Harness Relay's sandbox refused it: this is a protected path, which Harness Relay keeps agents from reading (its own database and temporary files, browsers' data).",
  openhandsSandboxRefused: "Harness Relay's sandbox refused it: that is outside the folders this conversation may write.",
  openSandboxRefusedReadOnly: "Harness Relay's sandbox refused it: this conversation is read-only.",
  openSandboxRefused: "Harness Relay's sandbox refused it: that is outside the folders this conversation may write.",

  tooManyEndpoints: (n) => `At most ${n} custom endpoints can be set up.`,
  endpointNotFound: (id) => `No endpoint "${id}"`,
  deletedEndpointNotFound: (id) => `No deleted endpoint "${id}" is remembered`,
  endpointIdInvalid: (id) =>
    `The endpoint id "${id}" may only hold lowercase letters, digits and - (not first or last; at most 32 characters).`,
  endpointIdReserved: (id) => `"${id}" is the name of a built-in model backend; give the endpoint another id.`,
  endpointNameMissing: 'Enter a name for the endpoint',
  endpointUrlInvalid:
    'This is not an endpoint address that can be used. Enter an http:// or https:// address without a username, password, query or fragment.',
  endpointUrlRelay: "This is Harness Relay's own address. Choose a model endpoint.",
  endpointCatalogKeyUnreadable:
    'The saved API key could not be read. Enter it again, or unlock the credential store and restart Harness Relay.',
  endpointNoMetadata:
    'The server returned no catalog or individual model records. Relay reached the server but could not verify the model IDs or credentials for chat.',
  endpointVerifyNeedsModel:
    'This endpoint does not support listing models. Enter at least one model ID so Harness Relay can verify it before saving.',
  endpointVerifyMismatch: (id) => `The endpoint did not return a matching record for model "${id}". Check the model ID.`,
  endpointVerifyModelHttp: (id, status) => `Could not verify model "${id}" (HTTP ${status}). Check the model ID and API key permissions.`,
  endpointVerifyModelError: (id, reason) => `Could not verify model "${id}". ${reason}`,
  endpointVerifyChanged: 'The endpoint settings changed during verification. Reopen the settings and review them before saving.',
  endpointVerifyTimeout: 'The model check timed out. Check the endpoint connection and try again.',
  endpointCatalogConnection: 'Could not read the endpoint response. Check the address and connection, then try again.',
  endpointResponseTooLarge: (single, total) =>
    `Model metadata exceeded the size limit of ${single} MiB per response and ${total} MiB per verification.`,
  endpointCatalogDenied: (status) =>
    `The endpoint denied access to its model list (HTTP ${status}). Check the API key and its permissions.`,
  endpointCatalogHttp: (status) => `The endpoint returned HTTP ${status} for /models. Check the OpenAI-compatible API base URL.`,
  endpointCatalogInvalid: (mib) => `Expected /models to return a JSON object with a data array of model IDs, within ${mib} MiB.`,
  endpointModelsInvalid: (n, chars) => `At most ${n} model names, each at most ${chars} characters, without spaces.`,
  endpointLimitsInvalid: (minContext, maxContext, minOutput, maxOutput) =>
    `A context window is a whole number of tokens from ${minContext} to ${maxContext}, and an output limit one from ${minOutput} to ${maxOutput}, less than its model's context window; only for the models the endpoint lists.`,
  endpointOutputTooLarge: (model, output, context) =>
    `The output limit of "${model}" (${output} tokens) must be less than its context window (${context} tokens, as the server reports it). Lower the output limit, or enter a context window.`,
  backendUnknown: (id) => `Unknown model backend: ${id}`,
  claudeReopens: (file, entry) =>
    `sandbox.filesystem in your Claude Code settings (${file}) lets its sandbox reach ${entry}, which opens paths Harness Relay protects (the browsers' folders or its database). Remove it and try again, or use full access.`,
  cwdHoldsVoice: (dir, voice, fromEnv) =>
    `The working directory ${dir} holds voice input's folder ${voice}, or is inside it${fromEnv ? ' (RELAY_VOICE_DIR)' : ''}. Harness Relay runs the voice engine there outside any sandbox, and in edit mode agents change files there without asking. Choose another folder, or read-only.`,
  cwdIsRelay: (dir) =>
    `The working directory ${dir} holds Harness Relay itself (its code or its data). In edit mode agents change files there without asking, so they could change Harness Relay's code or database and get around its sandbox and sign-in. Choose another folder, or read-only; to work on Harness Relay itself, run the copy you use from another folder.`,
  opencodeBackendError: (backend, e) =>
    `The model backend ${backend} answered with an error, so OpenCode could not finish the turn: ${e}. Check the API key, the endpoint's URL and the model name under Settings → Model connections.`,
  opencodeAuthRequired: (backend) =>
    `OpenCode cannot use the model backend ${backend}: its API key is missing or was refused. Check it under Settings → Model connections.`,
  opencodeForeignControl: (detail) =>
    `Security problem, so this run was stopped: OpenCode's own server was driven by something other than Harness Relay (${detail}). A command the agent ran may have read its server's password. The sandbox's file and network rules still held; check what this turn did.`,
  opencodeNoLinuxSandbox:
    "On Linux, OpenCode runs only with full access: Harness Relay's sandbox gives it a network of its own, where Harness Relay cannot watch its server (needed below full access), so it did not run it. Use full access (only in a folder you trust), or another agent.",
  opencodeDatabaseNotChecked: (detail) =>
    `Harness Relay could not take out of OpenCode's database the permission rules an earlier run's command could have put there (${detail}), so it emptied this member's OpenCode state and did not resume the session. The turn starts a fresh session instead.`,
  opencodeWatchFailed: (e) => `Harness Relay cannot watch OpenCode's own server, so it did not run it (needed below full access): ${e}`,
  opencodeWriteRefused: (path) => `The sandbox does not allow writing ${path} (read-only, or outside the folders this run may write)`,

  shareEmpty: 'Nothing to share',
  shareTooLarge: (mb, max) => `This page is ${mb} MB, over the ${max} a shared page can hold. Share up to an earlier reply instead.`,
  shareNoGh: (min) =>
    `GitHub CLI (gh) not found. Install ${min} or later from https://cli.github.com, run gh auth login in a terminal, then try again.`,
  ghTooOld: (min, version) =>
    `GitHub CLI (gh) is too old${version ? ` (this one is ${version})` : ''}: Harness Relay needs ${min} or later. Update gh from https://cli.github.com (installed with Homebrew: brew upgrade gh), then try again.`,
  ghLoginTokenSet: (name) =>
    `gh signs in with ${name} from Harness Relay's environment, which comes before any sign-in gh keeps, and while it is set gh keeps no other. Fix or remove ${name} where Harness Relay is started, then start it again.`,
  shareSignedOut: 'GitHub CLI (gh) is not signed in. Sign in to GitHub here, or run gh auth login in a terminal, then try again.',
  shareFailed: (detail) => `Could not create the gist: ${detail}`,
  shareNoDetail: 'gh gave no reason',
  shareNoUrl:
    'gh did not return a gist address on github.com (a shared page can only show gists on github.com). If a gist was created, find it with gh gist list and delete it',
  unshareFailed: (detail) => `Could not delete the gist: ${detail}`,
  unshareNotOwner:
    'The gist is still on GitHub, but it belongs to another account than the one gh is signed in to, so it could not be deleted. Switch back with gh auth switch, then remove it again.',
  shareNotFound: 'Share not found',
  shareNoFileUrl: 'GitHub returned no address for the uploaded files',
  shareNotGithub: 'the gist is not on github.com, the only place a shared page can show gists from',
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
  shareFilesUndone: (detail) =>
    `Could not make the shared page (${detail}), so the files uploaded for it were deleted again. Try once more.`,
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
  reportShotUnreadable: (n) =>
    `Screenshot ${n} could not be read through, so its metadata could not be left behind: it is not uploaded. Take it again, or save it as a PNG and try again.`,
  reportShotsUndone: (detail) =>
    `Could not upload the screenshots (${detail}), so the gist made for them was deleted again. Try once more.`,
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
  appInstallManual: 'This computer needs manual installation. Follow the instructions and check again.',
  appInstallMissing: 'The installer finished, but Relay still cannot find the tool. Check the installation log and try again.',
  noAgents: 'This conversation has no agents',
  runFailed: (msg) => `Run failed: ${msg}`,
  stoppedNote: 'Stopped.',
  queuedNotFound: 'That message was already delivered or withdrawn',
  queueFull: (n: number) => `Up to ${n} messages can wait to be delivered — wait for the team to reply`,
  gitInitNote: (root) => `The working directory was not a git repository; ran git init: ${root}`,
  dirLocked: (title, root) => `Conversation "${title}" is changing ${root}; try again when it finishes (or use read-only / parallel mode).`,
  applyLocked: (title, root) => `Conversation "${title}" is changing ${root}; apply once it finishes.`,
  teamWorktreeNote: (title, root) =>
    `Conversation "${title}" is changing ${root}, so this conversation's team works in a worktree of its own (a copy of the folder), and both go on at once. The team's changes reach the folder when you apply them ("Apply to working directory"); until then, this conversation's next replies are worked on in that worktree too.`,
  noWorktree: 'This member has no worktree',
  noTeamWorktree: 'This conversation has no worktree of its own',
  teamName: 'the team',
  resultStale: 'The working directory has changed since; this result is out of date. Let the team run again.',
  appliedNote: (name, files) =>
    `Applied @${name}'s changes to the working directory (${files} files, not committed). The next parallel round starts from the new state.`,
  appliedTeamNote: (files) =>
    `Applied the team's changes from this conversation's worktree to the working directory (${files} files, not committed). The team works in the working directory again from now on, unless another conversation is changing it then.`,
  noChanges: 'This message changed no files',
  relayLimit: (hops) => `Reached the relay limit (${hops} hand-offs); back to you. Press Continue to let the team keep going.`,

  checksTooManyFiles: (max) =>
    `More than ${max} files to compare: the protected paths could not be checked. Make the paths more specific (config/*.pem rather than *.pem, say).`,
  checksListChanged:
    'The check list changed after this run started, so its protected paths cannot be compared with the new list; the next run is checked with it.',
  checksNoBaseline: 'Where this run started from is not known any more, so it cannot be compared again.',
  checksCommitsParallel: 'Parallel mode applies its results without their commits, so the commit format is not checked.',
  checksCommitsTeam:
    "The team works in this conversation's own worktree, whose result is applied without its commits, so the commit format is not checked.",
  checksNoCommits: 'No new commit in this run.',
  checksPatternSlow: 'The commit format’s regular expression took too long and was stopped; make it simpler.',
  checksTooManyCommits: (n) => `More than ${n} new commits: only the newest ${n} were checked.`,
  checksBadPath: (p) => `The protected path "${p}" cannot be used: write a path relative to the working directory, without ..`,
  checksTooManyPaths: (n) => `At most ${n} protected paths`,
  checksBadCommitPattern: (why) => `The commit format is not a valid regular expression: ${why}`,
  checksCommitPatternTooLong: (n) => `The commit format can be at most ${n} characters`,
  checksNotFound: 'Check result not found',
  checksNotLatest: 'Only the latest check result can be handled this way',
  checksPassedAlready: 'Nothing in this check result failed',
  checksFixMessage: (name) => `@${name} please fix what failed in the latest team checks (the whole result has to pass).`,
  checksAutoFixMessage: (name, attempt, of) =>
    `@${name} the team checks did not pass: please fix them (sent by Relay automatically, attempt ${attempt} of ${of}).`,
  checksPreviewNoApp: 'No turn of this run made or changed an app.',
  checksScheduleFailed: 'The team checks did not pass',
  checksScheduleError: 'The team checks could not run',
  checksSandboxDenial: (kind, on) =>
    ({
      localPorts: on
        ? 'The sandbox refused a local port.'
        : 'The sandbox refused a local port it opened (macOS). If its tests need a server of their own, turn on "Allow every local port" for this command; it then reaches every service on this computer, Harness Relay\'s API among them.',
      unixSockets: on
        ? 'The sandbox refused a Unix socket.'
        : 'The sandbox refused a Unix socket it opened (Linux). If it needs one, turn on "Allow every Unix socket" for this command; it then reaches every socket, Docker\'s and an ssh agent\'s among them.',
      readOnly:
        'It wrote outside the working directory (/tmp, say): in the sandbox it may write only there and in its own temporary folder.',
      phantom:
        'It read one of the entries the sandbox puts at the top of the working directory to protect it (.zshrc, .vscode…; Linux). Have the command skip those names, or check only the folders it needs.',
      browser: 'A browser cannot start in the sandbox: run end-to-end tests outside it.',
      network: 'There is no network in the sandbox: the host it wanted could not be reached.',
      denied: 'The sandbox refused something it did (Operation not permitted).',
    })[kind] ?? 'The sandbox refused something it did.',
  checksCommandTimedOut: (min) => `It had not finished after ${min} ${min === 1 ? 'minute' : 'minutes'}, and was stopped.`,
  checksCommandNotFound: 'The program it runs was not found (exit 127). Harness Relay never installs what is missing.',
  checksCommandWindows:
    'Commands cannot be checked on native Windows yet (Harness Relay has no sandbox there): only the protected paths and the commit format are.',
  gatewayFromCode: 'Asked by code the agent runs with run_code.',
  labsBadMode: "Labs' mode is off, letting assistants script the tools, or reading long texts in parts.",
  labsNoModel: 'Reading long texts in parts needs a model ("backend/model").',
  labsBadModel: (id) =>
    `"${id}" is not "backend/model", such as anthropic/claude-haiku-5-5 or your endpoint's id and a model name, nor a CLI's, such as cli:claude/haiku.`,
  labsNoConnection: (backend) =>
    `${backend} is not set up in Model connections: add its key or endpoint under Settings → Model connections first.`,
  labsNoCliAccount: (cli, account) => `${cli} has no account "${account}": add it under Settings → ${cli}, or pick another account.`,
  labsCliConnectionModel: (cli, model) =>
    `"${model}" is a model of your own endpoints or API keys, which ${cli} would send to its own service: ask it through a model connection instead, or name one of ${cli}'s own models.`,
  labsWindows: 'Not on native Windows yet: Harness Relay has no sandbox there to run the code in.',
  labsNoNode: 'There is no Node.js on this computer to run the code with.',
  checksCommandNoFolder: (cwd) =>
    cwd
      ? `The folder "${cwd}" to run it in is not there, or not in the chat's working directories.`
      : "The chat's working directory is not there.",
  checksCommandsAtEnd: 'Commands are run once the team has finished.',
  checksCommandsParallel:
    "Parallel mode's results are not in the working directory until they are applied: commands are checked when one is.",
  checksCommandsTeam:
    "The team's changes are in this conversation's own worktree, not in the working directory, until they are applied: commands are checked then.",
  checksConfigChanged: (files) =>
    `The team changed settings the checks read (${files}), not confirmed yet, so they were not run: once you have looked, Confirm and run the commands runs them.`,
  checksNetworkRefused: (hosts) => `There is no network in the sandbox: the hosts it wanted were refused (${hosts}).`,
  checksAlsoRefused: (hosts) =>
    `The sandbox also refused hosts it wanted (${hosts}), though its output does not show that it failed for it.`,
  checksCommandsReadOnly: 'Commands are not run with read-only permission.',
  checksTryReadOnly: 'Commands cannot be tried with read-only permission: the checks run none.',
  checksInterrupted: 'The server stopped while it ran: it did not finish.',
  checksConfigChangedUnattended: (files) => `The team changed settings the checks read (${files}), and nobody confirmed them: a failure.`,
  checksTooManyCommands: (n) => `At most ${n} commands`,
  checksCommandEmpty: 'A command cannot be empty',
  checksCommandTooLong: (n) => `A command can be at most ${n} characters`,
  checksBadFolder: (f) =>
    `The folder "${f}" cannot be used: write a path relative to the first working directory (without ..), or a full path inside a working directory`,
  checksBadTimeout: (max) => `The time limit is 1 to ${max} minutes`,
  hooksTooMany: (n) => `At most ${n} hooks`,
  hookTimedOut: (sec) => `Stopped at its time limit of ${sec} seconds.`,
  hooksBadTimeout: (max) => `A hook's time limit is 1 to ${max} seconds`,
  hookRefused: (hook, call, why) => `The team's hook \`${hook}\` refused ${call}: ${why}`,
  hookFailed: (hook, call, why) => `After ${call}, the team's hook \`${hook}\` did not pass, and the agent was told: ${why}`,
  hookNoOutput: '(no output)',
  hooksTooLate: 'they did not finish in time, and were stopped',
  hookCallTooLong: (call) => `The team's hooks refused ${call}: the call is too long for them to read`,
  hookRefusedLabel: "Refused by the team's hook",
  hooksNoProgram: (cli) =>
    `This turn did not start: the team's hooks could not be given to ${cli} (no Node.js to start their program with, or Harness Relay's gateway is not running). Install Node.js 22.12 or later (Settings → Sandboxes can), or take the hooks out of the team checks.`,
  hookMoreNotices: 'Later hook refusals or failures in this turn are not listed.',
  hooksUnsupported: (cli) =>
    `${cli} cannot run the team's hooks yet: this member's tool calls in this turn go without them; the checks once the team has answered run as usual.`,

  backgroundCutOff: 'The turn ended before this work finished.',
  cliCompacted: (cli) => `${cli} compacted the conversation's context to make room.`,
  cliCompactFailed: (cli, why) => `${cli} could not compact the conversation's context${why ? `: ${why}` : '.'}`,
  cliRetrying: (cli, attempt, max, why) =>
    `${cli}'s request to its model failed; retrying${attempt ? ` (attempt ${attempt}${max ? ` of ${max}` : ''})` : ''}${why ? `: ${why}` : '.'}`,
  cliRetryFailed: (cli, why) => `${cli} retried and still failed${why ? `: ${why}` : '.'}`,
  cliModelSwitched: (cli, from, to) => (from ? `${cli} switched models from ${from} to ${to}.` : `${cli} switched to the model ${to}.`),

  approvalNotFound: 'This request was already answered or has expired',
  approvalDeclined: 'The user declined this action.',
  retryAgentGone: (name) => `@${name} is no longer on the team, so this reply cannot be retried`,

  planNotFound: 'Team design not found',
  planNotSavable: 'Only a team the lead agent designed or adapted can be saved as a template',
  planUnparsable: 'no JSON team design found in the reply',
  reviewUnparsable: 'no JSON review found in the reply',
  planUnknownTemplate: (id) => `there is no template with id "${id}"`,
  planTemplateTooBig: (name, max) => `the template "${name}" has more members than a team may have (${max})`,
  planTemplateFits: (name) => `The lead agent found the template "${name}" a good fit for this question and uses it as it is.`,
  planKeepFits: 'The lead agent found the current team a good fit for this question too and keeps it as it is.',
  planCheckAccounts: 'Checking accounts and usage',
  planCheckModel: 'Testing model response',
  planModelDefault: 'Default model',
  planModelNoReply: 'The model check did not receive the expected reply.',
  planModelChecksFailed: (models) =>
    models
      ? `Could not verify these models: ${models}. Check the accounts and model backends, then retry the design.`
      : 'The model checks timed out. Try designing the team again.',
  planNoAvailableModel: (schedule) =>
    `No models are available for this team. Check your accounts and usage in Settings, or ${schedule ? 'try designing the team again from the automation panel' : 'choose Continue to try again later'}.`,
  planEndpointUnavailable: (model) => `The private endpoint model "${model}" is unavailable. Check the CLI account and model backend.`,
  planAssignmentsAdjusted: 'Some member assignments were adjusted to use available accounts or models.',
  planCurrentUnavailable: 'a member of the current team uses an unavailable account or model',
  planLeadUnavailable: 'the lead agent’s account or model is currently unavailable',
  planNoCurrentTeam: 'this conversation has no team to keep yet',
  planAwaitingConfirm: 'Confirm the team the lead agent designed first; then the team answers',
  reviseEmpty: 'Say how the team should change first',
  reviseTooLong: (max) => `The request can be at most ${max} characters`,
  reviseStopped: 'Stopped changing the team',
  reviseFailed: (why) => `The lead agent could not change the team (${why}). The team is as it was; try saying it another way.`,

  scheduleNotFound: 'This conversation has no automation',
  scheduleTextRequired: 'Type the message the automation sends the team',
  scheduleTextTooLong: (max) => `An automation's message can be at most ${max} characters`,
  scheduleBadRepeat: 'The automation does not say when it runs',
  scheduleBadTime: 'Times are HH:MM (24-hour clock)',
  scheduleNeedDays: 'Pick at least one day for weekly times',
  scheduleBadHours: (max) => `The interval is a whole number of hours from 1 to ${max}`,
  scheduleBadMoment: 'Pick a date and time',
  scheduleInPast: 'That time has passed; pick a later one',
  scheduleBadTimeZone: (tz) => `Unknown time zone "${tz}"`,
  scheduleNeedsTeam: 'Confirm the team before you set up an automation',
  scheduleNoTeam: 'the team is not confirmed yet',
  scheduleDesigning: 'the lead agent is designing a team for a question; sent a little later',
  scheduleWaitsForAnswer: 'the team is waiting for your answer',
  scheduleStillQueued: "the automation's previous message is still waiting to be delivered",
  scheduleBusy: 'The conversation is being updated; try again in a moment',
  scheduleQueueFull: 'the queue of waiting messages is full',
  scheduleRefused: 'Refused automatically: nobody may be watching an automation run',
  approvalReviewPublish: 'Pushing and publishing are always yours to decide: the lead agent never approves them for you',
  approvalReviewGrant: 'More access for the rest of the turn is always yours to decide: the lead agent never approves it for you',
  approvalReviewNoDecision: "The lead agent's answer held no decision Harness Relay could read",
  approvalReviewFailedRefused: (why) =>
    `Refused automatically: the lead agent could not review it, and nobody may be watching an automation run${why ? ` (${why})` : ''}`,
  approvalReviewTimeout: 'The lead agent took too long to review it',
  approvalReviewFailed: (why) => `The lead agent could not review it: ${why}`,
  approvalReviewRefused: (why) =>
    `Refused automatically: the lead agent judged it potentially unsafe, and nobody may be watching an automation run${why ? ` (${why})` : ''}`,
  scheduleConvBusy: 'the conversation is busy with a settings change or an apply',
  scheduleFolderWritten: 'the team writes in the folder, or just did; sent at the check after it is done',
  scheduleMissedNote: (when) => `The automation's message of ${when} was not sent: Harness Relay was not running then.`,
  scheduleSkippedNote: (when, why) => `The automation's message of ${when} was not sent: ${why}.`,
  scheduleSkippedNotes: (first, last, count, why) =>
    `The automation's messages from ${first} to ${last} (${count} times) were not sent: ${why}.`,
  scheduleFailedNote: (when, why) => `The automation's message of ${when} could not be sent: ${why}`,
  scheduleChatNote: (title) => `The automation of "${title}" opened this conversation to send its message here.`,
  scheduleNoLead: 'The lead agent does not design the team in this conversation',
  scheduleHasTeam: 'This automation has a team already',
  scheduleCreatedNote:
    'Automation created. The lead agent designs a team for its message; once the team is confirmed, the automation sends it the message each time it runs. Nothing runs now.',
  scheduleGoalTooLong: (max) => `A goal can be at most ${max} characters`,
  trackingDoneNote: (agent, note) => `@${agent} says the goal is reached; the automation is off now${note ? `: ${note}` : '.'}`,
  trackingBlockedNote: (agent, note) => `@${agent} says the goal is held up and needs you${note ? `: ${note}` : '.'}`,
  trackingRetryNotNeeded: 'progress was reported since, so it is not tried again',
  trackingRetryNote: (when, attempt, minutes) =>
    `The automation run of ${when} failed; trying again in ${minutes} minutes (retry ${attempt}).`,
  trackingGaveUpNote: (when, tries) =>
    `The automation run of ${when} failed, also after ${tries} more tries; the automation waits for its next time.`,
  trackingRestartNote: (when) => `The automation run of ${when} was cut off when Harness Relay stopped; trying again now.`,
  trackingRunFailed: 'every reply of the run failed',
  hookNotFound: 'No such webhook',
  oauthClientDisabled: (provider) => `${provider} sign-in is disabled. Enable it in Common apps → Account sign-in settings.`,
  oauthNoClient: (provider) => `Set up your ${provider} OAuth client in Common apps → Account sign-in settings.`,
  oauthTokenNotSaved: (why) => `The sign-in's token could not be saved in the credential store: ${why}`,
  oauthHostRefused: (host) => `The sign-in's token is not sent to "${host}": it goes only to the account's own service`,
  oauthAccountGone: 'The account that signed in is not there any more: it may have been removed',
  oauthSignInAgain: (email, why, use) =>
    `The sign-in of ${email} no longer works: sign in again in ${signInSettings('en', use)}${why ? ` (${why})` : ''}`,
  oauthNoToken: (email, use) => `The sign-in token of ${email} cannot be read: sign in again in ${signInSettings('en', use)}`,
  oauthRefreshFailed: (email, why) => `The sign-in of ${email} could not be renewed: ${why}`,
  oauthBadAddress: 'That is not an address: paste the whole address the sign-in page took you to last',
  oauthWrongAddress: 'That address is not from this sign-in: paste the one this sign-in took you to last',
  oauthExpired: 'The sign-in waited too long and has expired: sign in again',
  oauthTooMany: 'Too many sign-ins are waiting: finish or cancel some of them first',
  oauthNoDevice: (provider) => `${provider} cannot sign in on another device for these permissions`,
  oauthStartFailed: (provider, why) => `The ${provider} sign-in could not start: ${why}`,
  oauthSignInNotFound: 'No such sign-in: it may have finished, been cancelled, or expired',
  oauthRefused: (provider, why) => `${provider} did not finish the sign-in: ${why}`,
  oauthNoCode: 'the sign-in page sent back no authorization code',
  oauthNoRefresh: (provider) =>
    `${provider} gave no refresh token, so the sign-in would stop working within the hour: sign in again, and allow offline access`,
  oauthCalendarFixed: 'This calendar is reached through an account that signed in, not a password: remove it and add it again',
  oauthCallbackTooOften: 'Too many sign-in callbacks failed: try again in a while',
  oauthAppChanged: 'the app it signed in with was changed in Settings',
  oauthNoCalendarAccess: (provider) =>
    `${provider} did not give access to the calendar: sign in again, and allow access to your calendar on the sign-in page`,
  oauthNoTeamsAccess: 'Sign in with a Microsoft work or school account and allow access to your Teams channels.',
  oauthNoDocumentsAccess: 'To create or edit Google documents, sign in again and allow document editing.',
  oauthNoDriveAccess: 'Sign in with Google again and allow read access to Drive.',
  macAppFinderDenied:
    'Allow Relay or its terminal to control Finder in System Settings → Privacy & Security → Automation on this Mac, then retry.',
  macAppPublishFailed: (dest) => `The application could not be installed at ${dest}.`,
  macAppDestinationExists: (dest) => `An application already exists at ${dest}.`,
  macAppMissingBundle: (name) => `The downloaded disk image does not contain ${name}.`,
  githubArchiveDownload: 'Relay could not download or verify GitHub CLI. Check your connection and available disk space, then try again.',
  githubArchiveRun: 'Relay could not unpack or start the downloaded GitHub CLI. Retry or install it using GitHub’s instructions.',
  teamsRuntimeUnsupported:
    'A portable PowerShell 7 build is unavailable for this system or processor. Install PowerShell using Microsoft’s instructions, then retry.',
  teamsRuntimeDownload:
    'Relay could not download or verify the package from Microsoft’s PowerShell release. Check the connection and available disk space, then retry.',
  teamsRuntimeTools:
    'Installing PowerShell 7 requires the system curl and tar tools. Install these tools or install PowerShell 7 manually, then retry.',
  teamsRuntimeRun:
    'Relay could not unpack or start PowerShell 7. Check that your system supports Microsoft’s PowerShell build and has its native dependencies installed.',
  teamsSetupFailed:
    'Could not set up Microsoft Graph. Check that PowerShell 7 is installed and can reach the PowerShell Gallery, then try again.',
  teamsForbidden: 'Teams refused access to this destination (HTTP 403). Check the channel or chat permissions.',
  teamsPostingConnect: 'Allow posting in Settings → Apps and tools → Common apps → Microsoft Teams first.',
  teamsPostingTarget: 'Paste a link to an existing Teams channel, chat or message that this account can open.',
  teamsPostingChanged: 'The Teams sender or destination differs from the preview. Prepare a new message.',
  teamsPostFailed: 'Could not confirm delivery to Teams. Check the destination before trying again.',
  teamsReadFailed: 'Could not read Teams. Check your connection and account access, then try again.',
  appsGithubChanged: 'The GitHub account changed. Check the current account before signing out.',
  appsGithubToken: (name) => `Remove ${name} from the environment that starts Relay, then restart Relay.`,
  appsGithubSignOutFailed: 'GitHub CLI could not sign out this account. Check the current account and try again.',
  appsGithubFailed: 'Could not read GitHub. Check the connection and account access, then try again.',
  appsTooLarge: 'This response is too large. Request less content.',
  appsConnectFirst: 'Connect an account in Settings → Apps and tools → Common apps first.',
  obsidianChoose: 'Use obsidian_list_vaults to find a connected vault, then pass its ID as vault.',
  obsidianMultiple: 'Several vaults are connected. Manage each vault separately.',
  obsidianOverlap: 'A connected vault cannot contain another connected vault.',
  obsidianVaultMissing: 'No such connected Obsidian vault.',
  docsGrant: 'Enable document editing for your Google account in Common apps → Google Drive.',
  docsAccount: 'Specify the email of one connected Google account with document editing enabled.',
  docsChanged: 'The document, revision, account or grant changed. Request a fresh preview.',
  docsInvalid: 'Google Docs returned a document, tab or revision that could not be verified.',
  docsMatch:
    'Choose a unique literal passage in a regular body paragraph. Suggested changes and other document structures cannot be edited.',
  docsTabs: (tabs) => `Specify the tab ID to edit (${tabs}).`,
  docsCreate: (title) => `Create Google Doc “${title}”`,
  docsEdit: (title) => `Edit Google Doc “${title}”`,
  docsSaved: (title, link) => `Saved Google Doc “${title}”.\n${link}`,
  docsFailed: (title, why) => `The change to Google Doc “${title}” could not be confirmed. ${why}`,
  docsDiscarded: (title) => `Discarded the change to Google Doc “${title}”.`,
  docsUnknown: (target) => `The outcome is uncertain. Check “${target}” in Google Docs before requesting another change.`,
  docsCreatedCheck: (title, link) => `Google Doc “${title}” was created. Check its contents before requesting another change.\n${link}`,
  docsHttp: (code) => `Google Docs returned HTTP ${code}. Check the document permission and revision before retrying.`,
  obsidianPath: 'Choose a vault-relative .md note path under an existing folder, with no hidden entries.',
  obsidianWriteFailed: 'The note could not be written. Check the filesystem.',
  obsidianContent: 'Each original and proposed note must be UTF-8 text of at most 48 KiB.',
  obsidianChanged: 'The note, its folder or the selected vault changed. Request a fresh preview before saving.',
  obsidianExists: 'This note path is already in use. Choose another filename or propose an edit to the existing note.',
  obsidianCreate: (path) => `Create note “${path}”`,
  obsidianEdit: (path) => `Edit note “${path}”`,
  obsidianSaved: (path) => `Saved note “${path}”.`,
  obsidianFailed: (path, why) => `Could not save “${path}”. ${why}`,
  obsidianDiscarded: (path) => `Discarded the change to “${path}”.`,
  obsidianInterrupted: 'Harness Relay stopped during the save. Check the note before requesting another change.',
  messageSetup: (app: string) => `Enable sending from Relay in Common apps → ${app} first.`,
  messageChanged: 'The connection or destination changed. Ask for a new preview.',
  messageUnknown: (app: string) => `Delivery is unconfirmed. Check ${app} before proposing another message. Relay will not retry.`,
  slackToken: 'Enter a valid OAuth token from the Slack app installed in your workspace.',
  slackScope: 'Grant the Slack app chat:write and permission to read the destination details, then reinstall it and reconnect.',
  slackDestination: 'Use a conversation link or ID from this workspace that the Slack app can access. Check that the app is a member.',
  slackStorage: 'The credential store on this computer is unavailable.',
  slackCheck: 'Relay could not verify the Slack connection or conversation. Try again.',
  messageNewPost: 'New channel post',
  messageChat: 'Chat',
  messageFrom: 'Send as',
  messageTo: 'Destination',
  messageWorkspace: 'Workspace',
  messageTenant: 'Organization',
  messageTitle: (app: string) => `Send a ${app} message`,
  messageSent: (app: string) => `Delivered to ${app}.`,
  appsVault: 'Choose the folder of an Obsidian vault (it contains .obsidian).',
  appsSlackInAssistant: 'Connect Slack in Claude or Codex from Settings → Apps and tools → Common apps → Slack.',
  oauthNoMailAccess: (provider) =>
    `${provider} did not give access to mail: sign in again, and allow access to your mail on the sign-in page`,
  oauthNoUse: (label) => `A token of ${label} is given only for one of its uses (calendars or mail)`,
  oauthNotFor: (email, use) =>
    use === 'documents'
      ? `Enable Google document editing for ${email}.`
      : use === 'teams'
        ? `Connect Teams for ${email}`
        : use === 'drive'
          ? `Connect Google Drive for ${email}`
          : `${email} was not signed in for ${use === 'mail' ? 'mail' : 'calendars'}: select your service in ${signInSettings('en', use)} and sign in with the same account`,
  oauthMailFixed:
    "This mail account is reached through an account that signed in, at its provider's own servers, not with a password or other servers: remove it and add it again",
  oauthSignInCancelled: 'The sign-in was cancelled, or the app it signed in with was changed in Settings',
  oauthAccountRemoved: 'The account this sign-in was for was removed meanwhile, so nothing was changed',
  oauthOtherAccount: (signedIn: string, meant: string) =>
    `You signed in as ${signedIn}, not ${meant}: ${meant} was not changed. To add another account, use Sign in with …`,
  oauthSecretNotSaved: (why) => `The app's client secret could not be saved in the credential store: ${why}`,
  oauthNotHere: (name) => `"${name}" is reached through an account that signed in, which cannot be used here`,
  oauthTokenRanOut: 'its sign-in brought no refresh token, and its access token has run out',
  oauthTokenTooLong: (max) => `a token in the answer is longer than ${max} characters: not taken`,
  oauthNotConfirmed: (provider) => `The sign-in page of ${provider} came back before you confirmed it: not taken, sign in again`,
  oauthOtherIssuer: (provider, iss) =>
    `The answer came from another authorization server (${iss}) than the one this sign-in of ${provider} started at: not taken (a mix-up attack, maybe), sign in again`,
  oauthNoIssuer: (provider) =>
    `The authorization server of ${provider} says its answers name it (iss), and this one did not: not taken, sign in again`,
  mcpServerLabel: (name) => `MCP server "${name}"`,
  mcpBadAddress: (url) => `"${url}" is not an address`,
  mcpInsecureAddress: (url) => `"${url}" is not HTTPS (plain HTTP goes only to a server on this computer)`,
  mcpNotJson: 'its answer is not a JSON object',
  mcpUnreachable: (why) => `the server could not be reached: ${why}`,
  mcpUnresolved: (host, why) => `the address of ${host} could not be found${why ? `: ${why}` : ''}`,
  mcpLookupSlow: (seconds) => `the lookup took over ${seconds} seconds`,
  mcpNearbyAddress: (host) =>
    `${host} leads to this computer or the local network: the sign-in of a server that is not on this computer goes only to addresses on the internet`,
  mcpMetadataFailed: (url, why) => `its protected resource metadata (${url}) could not be read: ${why}`,
  mcpNoResourceMetadata: 'it asks for a sign-in but does not say where: it publishes no protected resource metadata (RFC 9728)',
  mcpOtherResource: (resource) => `its metadata is for another resource (${resource}), not this server`,
  mcpNoAuthServer: 'its metadata names no authorization server',
  mcpNoAuthServerMetadata: (issuer) => `the authorization server ${issuer} publishes no metadata (RFC 8414 or OpenID)`,
  mcpOtherIssuer: (issuer) => `the authorization server's metadata names another issuer (${issuer})`,
  mcpNoEndpoints: (issuer) => `the metadata of the authorization server ${issuer} has no authorization or token endpoint`,
  mcpNoPkce: (issuer) => `the authorization server ${issuer} does not support PKCE with S256, which Harness Relay requires`,
  mcpNoRegistration: (issuer) =>
    `the authorization server ${issuer} does not let Harness Relay register itself (it has no dynamic client registration), so Harness Relay cannot sign in to it yet. If the service gives you an access token (a GitHub personal access token, say), click Edit and add the HTTP header Authorization with the value Bearer <your token>`,
  mcpRegistrationFailed: (issuer, why) => `registering a client at ${issuer} was refused: ${why}`,
  mcpSignInNotHttp: (name) => `The MCP server "${name}" is not an HTTP server: only HTTP MCP servers sign in`,
  mcpSignInCannotStart: (name, why) => `The sign-in of the MCP server "${name}" could not start: ${why}`,
  mcpNoSignIn: (name) => `The MCP server "${name}" asks for no sign-in: it works without one`,
  mcpServerChanged: (name) => `The MCP server "${name}" was removed, or its URL changed, while it signed in: sign in again`,
  mcpLeftOutSignIn: (name, why) =>
    `The MCP server "${name}" was left out of this turn: its sign-in no longer works${why ? ` (${why})` : ''}. Sign in to it again in Settings → Apps and tools → Tool library → MCP servers.`,
  mcpLeftOut: (name, why) => `The MCP server "${name}" was left out of this turn: ${why}`,
  watchNoAccount:
    'The mail account this automation checks is gone: add one in Settings → Apps and tools → Common apps → Mail, or pick another',
  watchNoPassword: (name) =>
    `The password of the mail account "${name}" cannot be read: type it again in Settings → Apps and tools → Common apps → Mail`,
  watchNoFolder: (folder, why) => `The folder "${folder}" cannot be opened: ${why}`,
  watchBadTrigger: 'What to wait for is not complete: pick a source, and its account or calendar',
  watchNotEvent: 'This automation does not start when something happens: there is nothing to check',
  watchNoScheduler: 'This server does not check what automations wait for: restart Harness Relay',
  watchFailedNote: (why) => `What the automation waits for happened, but its message could not be sent: ${why}`,
  watchNoCalendar:
    'The calendar this automation checks is gone: add one in Settings → Apps and tools → Common apps → Calendar, or pick another',
  watchNoCalendarPassword: (name) =>
    `The password of the calendar "${name}" cannot be read: type it again in Settings → Apps and tools → Common apps → Calendar`,
  watchBadMinutes: (max) => `The minutes before an event begins are a whole number from 1 to ${max}`,
  watchBadRepo: 'Give the GitHub repository as owner/name, such as octocat/hello-world',
  watchBadPattern: 'Give a pattern for files in the working directory, such as reports/*.csv (not a full path, and without ..)',
  watchNoGh: 'The GitHub CLI (gh) is not installed: install it, then sign in with gh auth login',
  watchGhSignedOut: 'The GitHub CLI (gh) is not signed in: run gh auth login in a terminal',
  watchGhFailed: (repo, why) => `The GitHub repository ${repo} cannot be read: ${why}`,
  watchBadBranch: 'The branch is not a name git allows: no spaces, none of ~^:?*[\\, no .., and not starting with -',
  watchTriggerCount: (max) => `An automation waits for 1 to ${max} things`,
  watchSameTrigger:
    'Two of the things to wait for are the same (the same source, such as the same mail account and folder): change or remove one',
  watchGhTimedOut: (repo) => `The GitHub CLI (gh) did not answer about ${repo} within a minute: the next check tries again`,
  watchGhNoJson: (repo) => `The GitHub CLI (gh) did not answer about ${repo} in JSON: update gh`,
  watchNoCwd: (cwd) => `The working directory "${cwd}" is not there`,
  watchCwdNoAccess: (cwd) => `The working directory "${cwd}" cannot be read: check the folder's permissions`,
  watchCwdUnreadable: (cwd, code) => `The working directory "${cwd}" cannot be read (${code})`,
  watchTooManyEntries: (max) =>
    `More than ${max.toLocaleString('en-US')} files and folders to look through at every check: give the pattern the folder to look in, such as reports/*.csv rather than **/*.csv`,
  watchTooManyFiles: (max) => `More than ${max.toLocaleString('en-US')} files match the pattern: make it narrower, by naming a folder, say`,
  hookTooOften: (seconds) => `This webhook can be called at most once every ${seconds} seconds`,
  hookNeedsSchedule: 'Set up an automation before you add a webhook',
  browserNotFound: (path) => `There is no file at "${path}": give the browser's executable, as a full path`,
  hookGoalReached: 'The goal this automation tracks is reached; turn it on again before calling it',
  hookBodyTooLarge: (kb) => `A webhook's body can be at most ${kb} KB`,
  outboxInterrupted: 'Harness Relay stopped while sending it, so whether it went out is not known; it was not sent again.',
  outboxNotFound: 'No such outbox item',
  outboxDecided: 'This item was already answered',
  outboxNoTool: (tool) => `No tool can send this item (${tool})`,
  outboxSentNote: (title, result) => `Sent "${title}": ${result}`,
  outboxFailedNote: (title, why) => `"${title}" was not sent: ${why}`,
  outboxDiscardedNote: (title) => `Discarded "${title}"; nothing was sent.`,
  outboxTakenBack: 'The reply that asked for it was taken back, so it was not sent.',
  conn: {
    timedOut: (host, port, seconds) => `${host}:${port} did not answer in ${seconds} seconds`,
    connectFailed: (host, port, why) => `Could not connect to ${host}:${port}: ${why}`,
    tlsSlow: (host) => `TLS with ${host} did not start in time`,
    tlsFailed: (host, why) => `TLS with ${host} failed: ${why}`,
    mailTooMuch: 'The mail server sent more than a response may hold',
    mailAnnouncedTooMuch: 'The mail server announced more than a response may hold',
    mailReplyTooMuch: 'The mail server sent more than a reply may hold',
    mailClosed: 'The mail server closed the connection',
    mailRefused: (text) => `The mail server refused the connection: ${text}`,
    mailLogin: (why) => `The mail server did not accept the user name and password: ${why}`,
    mailTokenRefused: (why) => `The mail server did not accept the sign-in's token: ${why}`,
    mailTokenFailed: (why) => `The mail server did not finish the sign-in with the token: ${why}`,
    mailNoXoauth2: (host, said) => `The mail server ${host} does not take a sign-in with a token (XOAUTH2)${said ? `: ${said}` : ''}`,
    mailNoAnswer: (seconds) => `The mail server did not answer in ${seconds} seconds`,
    mailIdleEnded: (line) => `The mail server ended the connection waiting for new mail: ${line}`,
    calTooMuch: 'The calendar answered with more than an answer may hold',
    calListFailed: 'Listing the events failed',
    calAddFailed: 'Adding the event failed',
    calFindFailed: 'Finding the calendars failed',
    calLogin: (what, status) => `${what}: the calendar did not accept the user name and password (${status})`,
    calMoved: (what, where) => `${what}: the calendar is at another address (${where}); use that one`,
    calStatus: (what, status) => `${what}: the calendar answered ${status}`,
    accountGone: 'The account the card showed is gone: nothing was sent',
    noMail: (name) => (name ? `No mail account "${name}"` : 'No mail account is set up'),
    noCalendar: (name) => (name ? `No calendar "${name}"` : 'No calendar is set up'),
  },
  gw: {
    open: (url) => `Open ${url}`,
    openReason: 'Open this page in its own browser',
    openNearbyReason:
      'Open this page in its own browser. It is on this computer or the local network: once allowed, its pages can reach this host and port too.',
    mailSent: (id, host, answer) => `${id} accepted by ${host}${answer ? ` (${answer})` : ''}`,
    inviteSent: (calendar) => `Added to ${calendar}; the calendar sends the invitations`,
    click: (what) => `Click ${what} on the open page`,
    refLink: (label, href) => `link "${label}" (${href})`,
    refButton: (label) => `button "${label}"`,
    refField: (name, label) => `field${name ? ` ${name}` : ''}${label ? ` "${label}"` : ''}`,
    refGone: (n) => `element ${n} (not in the latest snapshot)`,
    type: (field, enter) => `Type the text below into ${field}${enter ? ', then press Enter' : ''}`,
    typed: (text, length) => (text.length < length ? `${text}… (${length} characters in all)` : text),
    draft: (to, subject) => `Save a draft to ${to}: "${subject}"`,
    mail: (to, subject) => `Mail to ${to}: "${subject}"`,
    addEvent: (summary, when, calendar) => `Add "${summary}" (${when}) to the calendar "${calendar}"`,
    invite: (who, summary) => `Invite ${who} to "${summary}"`,
    noSubject: '(no subject)',
    fields: {
      from: 'From',
      to: 'To',
      cc: 'Cc',
      bcc: 'Bcc',
      subject: 'Subject',
      event: 'Event',
      when: 'When',
      where: 'Where',
      invites: 'Invites',
      calendar: 'Calendar',
    },
  },
  mcpNameReserved: (name) => `"${name}" is taken by Harness Relay's own tools (relay, and names that start with relay_); choose another`,
  connectorTooMany: (max) => `At most ${max} accounts`,
  connectorNameTaken: (name) => `There is an account called "${name}" already`,
  connectorPasswordRequired: 'Enter the password (an app password is best)',
  connectorPasswordAgain: 'The server changed: enter the password again (the kept one goes only to the server it was given for)',
  connectorPasswordNotSaved: (e) => `Could not save the account's password to the credential store, so the account was not saved: ${e}`,
  connectorNotFound: (id) => `No such account: ${id}`,
  connectorBadHost: (field) => `${field}: not a valid host name`,
  connectorBadPort: (field) => `${field}: the port is a number from 1 to 65535`,
  connectorPlainRemote: (field) => `${field}: only a server on this computer may go without encryption`,
  connectorRelayPort: (field) => `${field} cannot be one of Harness Relay's own ports`,
  connectorBadAddress: (field) => `${field} is not a valid mail address`,
  connectorBadUrl: "The calendar's address must be https (http only to this computer), without a user name or password in it",
  connectorTestOk: 'Connected: the user name and password work.',
  connectorTestOkSignedIn: 'Connected: the sign-in works.',
  connectorTestFailed: (why) => `Not connected: ${why}`,
  connectorDiscoverFailed: (why) => `No calendars found: ${why}`,

  unknownProvider: (p) => `Unknown provider: ${p}`,
  dirNotFound: (cwd) => `Directory not found: ${cwd}`,
  keyringFailed: (e) => `Could not save the API key to the credential store: ${e}`,
  noLogin: 'No sign-in in progress',
  unknownAccount: (provider, id) => `${provider} has no account ${id}`,
  tooManyAccounts: (provider, max) => `${provider} can have up to ${max} ${max === 1 ? 'account' : 'accounts'} (the default one included)`,
  badAccountLabel: (max) => `An account name has up to ${max} characters, on one line`,
  defaultAccountStays: 'The default account cannot be removed',
  accountBusy:
    'A conversation is running, or the lead agent is sorting one into a group or changing a team. Wait until they finish (or stop the conversation, or close Team settings) before removing an account.',
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
  badLimit: (name, min, max) => `Agent "${name}" has an invalid limit: it must be from ${min} to ${max}`,
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
  desktopLangNotHere: "Only the desktop app's own window, on the computer that runs Harness Relay, sets the language of its menus.",
  agentHomeTooBroad: (dir) => `Use a folder of its own (for example ~/.relay-agents), not ${dir}`,
  agentHomeCreateFailed: (dir, reason) => `Could not create the folder ${dir} (${reason})`,
  agentHomeNotAbsolute: (dir) => `Enter a full path, or one that starts with ~ (for example ~/.relay-agents), not ${dir}`,
  agentHomeInside: (dir, folder) =>
    `${dir} is inside ${folder}: its snapshots would take in the CLIs' sign-ins and session records. Pick a place outside it, such as ~/.relay-agents`,
  agentHomeBusy:
    "A conversation is running, or the lead agent is sorting one into a group or changing a team. Wait until they finish (or stop the conversation, or close Team settings) before changing the CLIs' own folder.",
  agentsViewLinkInvalid: (url) =>
    `Invalid address to open AgentsView: ${url}. Enter one that starts with http:// or https://, such as https://my-computer.tail1234.ts.net:9999`,
  agentsViewUrlInvalid: (url) =>
    `Invalid AgentsView address: ${url}. Only http(s) addresses on this computer are accepted, such as http://127.0.0.1:8080`,

  badMcpName: (name) => `Invalid MCP server name "${name}": use letters, digits, _ and - only, up to 40 characters`,
  badVarName: (name) => `Invalid or repeated name "${name}": use letters, digits, _, . and -, not starting with a digit`,
  mcpNeedsCommand: 'Enter the command to run',
  mcpNeedsUrl: 'Enter a URL starting with http:// or https://',
  mcpNotFound: (name) => `No MCP server named "${name}"`,
  mcpExists: (name) => `There is already an MCP server named "${name}"`,
  tooManyMcp: (n) => `You can set up at most ${n} MCP servers`,
  secretsFailed: (e) => `Could not save the MCP server's values to the credential store: ${e}`,
  secretsUnreadable: (name) =>
    `The values of MCP server "${name}" could not be read from the credential store (it may be locked, or the key they were encrypted with is gone): enter every value again, or unlock it and restart Harness Relay.`,
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
  nativeAsRunFailed: (cli, detail) =>
    `Asking ${cli} again the way Harness Relay starts it failed, so what is left out is not marked: ${detail}`,
  nativeAsRunPartial: (cli) =>
    `Asking ${cli} again the way Harness Relay starts it ran out of time: what it had answered is marked, the rest is not.`,

  previewSnapshotChanged: 'Files changed during the copy. Rebuild the preview after editing finishes.',
  previewSnapshotLimit: 'Choose a smaller preview folder (at most 4,096 entries, 32 levels, 16 MiB per file and 64 MiB total).',
  fileNotFound: 'File or folder not found (only what is inside the working directory can be browsed)',
  zipTooBig: (items, gb) =>
    `This folder is too large for a ZIP file: at most ${items.toLocaleString('en')} files and folders, ${gb} GB in all. Download a folder inside it instead.`,
  fileRootNotFound: 'This folder no longer exists',
  filesEdit: {
    worktreeReadOnly: "An agent's worktree is read-only here: apply its result to change the working directory.",
    relayFolder: 'Files does not change this folder: it holds Harness Relay itself, its data or voice input’s folder.',
    agentFolder: (folder) =>
      `Files does not change this folder: it holds ${folder}, which decides how the agents run (the home folder or a coding agent's own folder).`,
    link: 'Files does not write through a symbolic link: open the file where it really is.',
    protectedPath:
      "Files does not write here: Harness Relay keeps this place from the agents (its data, a browser's profile or a file of tokens).",
    isFolder: (name) => `There is a folder named "${name}" here.`,
    readOnlyFile: (name) => `"${name}" is read-only.`,
    badName: (name, problem) =>
      `"${name}" cannot be a file's name: ${
        {
          empty: 'give it a name.',
          separator: 'a name cannot have / or \\.',
          dots: '. and .. are not names.',
          control: 'a name cannot have control characters or broken characters.',
          reserved:
            'a name cannot have < > : " | ? *, end with a dot or a space, or be a name Windows keeps for devices (CON, NUL, COM1…).',
          git: ".git is git's own folder.",
          tooLong: 'a name is at most 255 bytes.',
        }[problem]
      }`,
    notText: 'Only text can be saved here: no NUL character or broken character.',
    textTooLarge: (kb) => `Too large to save here: at most ${kb} KB of text.`,
    uploadTooLarge: (name, mb) => `"${name}" is too large to upload: at most ${mb} MB.`,
    tooLarge: 'What was sent is too large.',
    exists: (name) => `"${name}" exists already.`,
    changed: (name) => `"${name}" changed since you opened it. Reload it to see the new version.`,
    gone: (name) => `"${name}" is no longer there.`,
    moved: 'The folder changed while saving. Try again.',
    cannotWrite: (name, why) => `Could not write "${name}" (${why}). If another program has it open, close it and try again.`,
    busy: "A run is changing files in this folder (this chat's team, or another chat's). Save once it is done.",
  },

  gitMissing: 'This action needs Git. Install Git and try again.',
  gitInstallUnavailable: 'Automatic Git installation is unavailable on this computer.',
  gitInstallStillMissing: 'The installer exited and Harness Relay still cannot run Git.',
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
  copilotTokenUnconfirmed: (said) =>
    `Copilot takes this GitHub token but reports no plan for it, so whether this account can use Copilot is not known${said ? `: ${said}` : '.'}`,
  logoutFailed: (code) => `logout failed (exit ${code})`,
  codexLoginFailed: (code) => `codex login failed (exit ${code})`,
  codexModelsFailed: 'codex debug models failed',
  grokModelsEmpty: 'grok models returned no models',
  cursorModelsFailed: 'cursor-agent returned no model list',
  antigravityModelsFailed: 'agy models returned no models',
  copilotModelsFailed: 'Copilot returned no models',
  museSkillsFailed: 'muse skills list returned no skills',
  cliInstallRunning: (cli) => `${cli} is being installed. Wait for it to finish, or cancel it first.`,
  cliInstallNone: (cli) => `No install of ${cli} is running`,
  cliAlreadyInstalled: (cli) => `Harness Relay has installed ${cli} already. To install it again, remove it first.`,
  cliNotInstalledHere: (cli) => `${cli} was not installed by Harness Relay: there is nothing here to remove.`,
  cliRemoveBusy: (cli) =>
    `A conversation is running, or the lead agent is sorting one into a group or changing a team. Wait until they finish (or stop the conversation) before removing ${cli}.`,
  cliInstallBlocked: (cli, block) =>
    block === 'system'
      ? `Harness Relay cannot install ${cli} on this system. Install it as its own page says.`
      : block === 'npm'
        ? `Installing ${cli} takes npm, which comes with Node.js, and npm is not on the PATH. Install Node.js (https://nodejs.org) first.`
        : block === 'gitBash'
          ? `Installing ${cli} on Windows takes the bash that comes with Git for Windows (Git Bash), which was not found. Install Git for Windows (https://git-scm.com/download/win; MinGit has no bash).`
          : block === 'powershell'
            ? `Installing ${cli} takes Windows PowerShell, which was not found.`
            : block === 'tar'
              ? `Installing ${cli} takes tar to unpack Node.js's download (on Windows, the one in System32), which was not found.`
              : `Installing ${cli} takes ${block}, which is not on the PATH.`,
  cliInstallFailed: (command, code) => `${command} failed (exit ${code}). Its output is below.`,
  cliInstallTimedOut: (command) => `${command} took too long and was stopped.`,
  cliInstallNoProgram: (path) => `The installer finished, but its program ${path} is not there.`,
  cliInstallDoesNotRun: (detail) => `The program installed does not run (--version): ${detail}`,
  sandboxSetupRunning: 'What the sandboxes need is being installed. Wait for it to finish, or cancel it first.',
  sandboxSetupNone: 'No install of what the sandboxes need is running',
  sandboxSetupCannotStop:
    "The system's package manager is installing as administrator, and stopping it halfway could leave its database to repair, so it cannot be cancelled: wait for it to finish.",
  sandboxSetupNothing: 'Nothing the sandboxes need is missing here that Harness Relay can install.',
  sandboxSetupNoAdmin:
    "There is no way to get administrator rights here (not root, sudo asks for a password, and no desktop session to show pkexec's password prompt), so no package was installed: run the command below in a terminal.",
  sandboxSetupAdminRefused:
    'The administrator password was not given (or not allowed, or no prompt could be shown), so nothing was installed. Try again, or run the command below in a terminal.',
  sandboxSetupStillMissing: (items) => `The install ran, but this is still missing: ${items}. Its output is below.`,
  cliNodeDoesNotRun: (linux) =>
    linux
      ? "The Node.js put into the folder does not run on this computer (its output is below). Node.js's Linux builds need glibc 2.28 or later and libatomic (the libatomic1 package on Debian and Ubuntu, libatomic on Fedora): install libatomic if that is what is missing, or Node.js with npm, then try again."
      : 'The Node.js put into the folder does not run on this computer (its output is below): install Node.js with npm, then try again.',
  cliNodeChecksum: (url, expected, actual) =>
    `The Node.js downloaded (${url}) does not match the checksum Harness Relay has for it, so it was not used: SHA-256 ${expected} expected, ${actual} downloaded.`,
  cliInstallCancelled: 'Install cancelled',
  cliRemoveFailed: (dir, detail) => `Could not delete ${dir}: ${detail}`,
  cliRemoving: (cli) => `${cli} is being removed. Wait until it is removed.`,
  cliUserPathUnread: (detail) =>
    `Could not read your user PATH, which is put back as it was once the installer has run, so the installer was not run: ${detail}`,
  cliUserPathNotBack: (detail) =>
    `Could not put your user PATH back as it was before the installer ran: ${detail}. Harness Relay tries again when it starts next, or before it runs another installer.`,
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
    claudeSubscription: [
      'Claude subscription',
      'Sign in with a Claude Pro / Max account. Open the link, authorise, then paste back the code the page shows.',
    ],
    claudeConsole: ['Anthropic Console', 'Sign in with a Console account (billed by API usage).'],
    codexDevice: ['ChatGPT device code', 'Open the link, sign in to ChatGPT and enter the one-time code below.'],
    codexBrowser: ['ChatGPT browser sign-in', 'Opens a browser on this computer to sign in (needs a localhost callback).'],
    grokDevice: ['xAI device code', 'Open the link and confirm the code below.'],
    grokBrowser: ['xAI browser sign-in', 'Opens a browser on this computer to finish the OAuth sign-in.'],
    cursorBrowser: ['Cursor account', 'Open the link below in a browser on any device, sign in to Cursor and allow the CLI.'],
    antigravityGoogle: [
      'Google account',
      'Open the link below in a browser on any device, sign in to Google, then paste back the code the page shows (or its whole address).',
    ],
    copilotDevice: [
      'GitHub account (device code)',
      'Open the GitHub link below in a browser on any device, enter the code shown, and authorize it.',
    ],
    museMeta: [
      'Meta account',
      'Open the link below in a browser on any device, sign in to your Meta account, and check that the page shows the code below.',
    ],
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
