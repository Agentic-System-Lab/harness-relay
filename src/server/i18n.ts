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
  claudeError: 'Claude Code 回報錯誤',
  commandNotFound: (bin: string) => `找不到指令「${bin}」。請確認已安裝，或在「設定」頁指定執行檔路徑。`,
  permission: { 'read-only': '唯讀', edit: '可編輯', full: '完全存取' } as Record<Permission, string>,
  grokRefusedReadOnly: '唯讀模式不允許，已告知 Grok 改用唯讀工具',
  grokRefusedPublish: '可編輯模式不允許推送或發佈',
  grokCancelledNoReason: 'Grok 自行中止了這一輪（stopReason: cancelled），沒有給出原因。',
  grokCancelled: (tool: string, reason: string | undefined) => `Grok 在執行工具「${tool}」時中止了這一輪${reason ? `（${reason}）` : ''}。`,
  grokCancelHint: (permission: string) => `目前的權限是「${permission}」；若這個操作是必要的，可以把權限改成「完全存取」再試。`,
  grokSandbox: (why: string) => `Grok 無法啟動沙箱（可編輯模式需要）：${why}`,
  grokNoSession: 'grok 沒有回傳 session id',
  grokRejectedModel: (value: string, err: string) => `Grok 不接受模型「${value}」：${err}`,
  grokRejectedEffort: (value: string, err: string) => `Grok 不接受推理強度「${value}」：${err}`,

  // Conversations and runs
  defaultTitle: '新對話',
  conversationNotFound: '找不到對話',
  messageNotFound: '找不到這則訊息',
  emptyMessage: '訊息不能是空的',
  typeFirst: '請先輸入訊息',
  badAttachment: '附加檔案的格式不正確',
  tooManyAttachments: (n: number) => `一則訊息最多附加 ${n} 個檔案`,
  attachmentTooLarge: (name: string, max: number) => `「${name}」太大了（上限 ${Math.round(max / 1024 / 1024)} MB）`,
  attachmentNotFound: '找不到這個附加檔案',
  mediaNotFound: '找不到這個圖片或影片（只能顯示工作目錄裡的圖片與影片）',
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
  planTemplateFits: (name: string) => `首席 agent 判斷範本「${name}」適合你的需求，直接套用。`,
  planAwaitingConfirm: '請先確認首席 agent 設計的團隊，再開始提問',

  // HTTP
  unknownProvider: (p: string) => `未知的 provider：${p}`,
  dirNotFound: (cwd: string) => `目錄不存在：${cwd}`,
  keyringFailed: (e: string) => `無法把 API key 存進系統的金鑰儲存區：${e}`,
  noLogin: '沒有進行中的登入',
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
  invalidField: (field: string) => `「${field}」的值無效`,

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
  nativeFailed: (cli: string, detail: string) => `${cli} 回報錯誤：${detail}`,
  nativeNoAnswer: (cli: string, part: 'all' | 'skills' | 'mcp') =>
    part === 'all' ? `${cli} 沒有回應。` : `${cli} 沒有回報它的${part === 'skills' ? ' skill' : ' MCP 伺服器'}。`,

  // Files
  fileNotFound: '找不到這個檔案或資料夾（只能瀏覽工作目錄裡的內容）',
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
  } as Record<string, [string, string]>,
};

export type ServerMessages = typeof zhTW;

const en: ServerMessages = {
  stopped: 'Stopped',
  timedOut: 'Timed out',
  exitedWithoutReply: (cli, code) => `${cli} exited (exit ${code}) without a reply`,
  exitedWithoutTurn: (cli, code) => `${cli} exited (exit ${code}) without finishing the turn`,
  claudeError: 'Claude Code reported an error',
  commandNotFound: (bin) => `Command "${bin}" not found. Make sure it is installed, or set its path on the Settings page.`,
  permission: { 'read-only': 'Read-only', edit: 'Edit', full: 'Full access' },
  grokRefusedReadOnly: 'Not allowed in read-only mode; Grok was told to use read-only tools',
  grokRefusedPublish: 'Pushing or publishing is not allowed with edit permission',
  grokCancelledNoReason: 'Grok ended the turn by itself (stopReason: cancelled) without giving a reason.',
  grokCancelled: (tool, reason) => `Grok ended the turn while running "${tool}"${reason ? ` (${reason})` : ''}.`,
  grokCancelHint: (permission) =>
    ` The permission is "${permission}"; if this action is needed, switch the permission to "Full access" and try again.`,
  grokSandbox: (why) => `Grok could not start its sandbox (needed for edit mode): ${why}`,
  grokNoSession: 'grok returned no session id',
  grokRejectedModel: (value, err) => `Grok does not accept the model "${value}": ${err}`,
  grokRejectedEffort: (value, err) => `Grok does not accept the reasoning effort "${value}": ${err}`,

  defaultTitle: 'New chat',
  conversationNotFound: 'Conversation not found',
  messageNotFound: 'Message not found',
  emptyMessage: 'The message cannot be empty',
  typeFirst: 'Type a message first',
  badAttachment: 'An attached file is malformed',
  tooManyAttachments: (n) => `You can attach up to ${n} files to one message`,
  attachmentTooLarge: (name, max) => `"${name}" is too large (limit ${Math.round(max / 1024 / 1024)} MB)`,
  attachmentNotFound: 'Attachment not found',
  mediaNotFound: 'Image or video not found (only images and videos in the working directory can be shown)',
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
  planTemplateFits: (name) => `The lead agent found the template "${name}" a good fit for what you need and uses it as it is.`,
  planAwaitingConfirm: 'Confirm the team the lead agent designed before asking your first question',

  unknownProvider: (p) => `Unknown provider: ${p}`,
  dirNotFound: (cwd) => `Directory not found: ${cwd}`,
  keyringFailed: (e) => `Could not save the API key to the system credential store: ${e}`,
  noLogin: 'No sign-in in progress',
  presetNameRequired: 'Enter a template name',
  otherGroup: 'Other',
  groupNameRequired: 'Enter a group name',
  groupNameTooLong: (max) => `A group name can be at most ${max} characters`,
  groupNameTaken: (name) => `There is already a group called "${name}"`,
  groupNotFound: 'Group not found',
  tooManyGroups: (max) => `You can have at most ${max} groups`,

  needAgent: 'At least one agent is needed',
  tooManyAgents: (max) => `At most ${max} agents`,
  badName: (i, name) => `Agent ${i}'s name "${name}" is invalid: use letters, digits, _ or -, up to 32 characters`,
  reservedName: (name) => `"${name}" is a reserved name`,
  duplicateName: (name) => `The agent name "${name}" is used twice`,
  badProvider: (name) => `Agent "${name}" has an invalid provider`,
  badEffort: (name, effort) => `Agent "${name}" has an invalid reasoning effort "${effort}"`,
  cwdMissing: (cwd) => `Working directory not found: ${cwd}`,
  cwdNotDirectory: (cwd) => `Not a folder: ${cwd}`,
  cwdCreateFailed: (cwd, reason) => `Could not create the working directory ${cwd} (${reason})`,
  invalidField: (field) => `Invalid value for "${field}"`,

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
  nativeFailed: (cli, detail) => `${cli} reported an error: ${detail}`,
  nativeNoAnswer: (cli, part) => (part === 'all' ? `${cli} did not answer.` : `${cli} did not report its ${part === 'skills' ? 'skills' : 'MCP servers'}.`),

  fileNotFound: 'File or folder not found (only what is inside the working directory can be browsed)',
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
