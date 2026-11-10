/**
 * The desktop app's own words (its menu and dialogs), in the two languages of the web app. The
 * language follows the system's, the way the web app follows the browser's: any Chinese is zh-TW.
 */
import type { ManualReason, UpdateFailure } from './update';

export type DesktopLang = 'zh-TW' | 'en';

export function pickLang(preferred: readonly string[]): DesktopLang {
  for (const tag of preferred) {
    const t = tag.toLowerCase();
    if (t.startsWith('zh')) return 'zh-TW';
    if (t.startsWith('en')) return 'en';
  }
  return 'en';
}

const zhTW = {
  starting: '正在啟動…',
  running: (url: string) => `執行中：${url}`,
  stopping: '正在停止…',
  stopped: '已停止',
  open: '打開 Harness Relay',
  shareWithPhone: '分享到手機（Tailscale）…',
  copyPhoneAddress: (url: string) => `複製手機網址：${url}`,
  openAtLogin: '登入時自動啟動',
  keepAwake: '執行時不讓電腦睡著',
  openDataFolder: '打開資料夾',
  showLog: '查看記錄檔',
  start: '啟動伺服器',
  restart: '重新啟動伺服器…',
  quit: '結束 Harness Relay',

  ok: '好',
  cancel: '取消',
  retry: '再試一次',
  later: '稍後',
  copyAddress: '複製網址',
  restartNow: '立即重新啟動',
  quitApp: '結束 Harness Relay',
  openInBrowser: '在瀏覽器打開',
  openDownloadPage: '打開下載頁',

  portInUse: (port: number) => `連接埠 ${port} 已經有其他程式在使用`,
  portInUseDetail:
    '可能是用 npm start 或 npm run dev 啟動的 Harness Relay 還在執行。先結束它，再按「再試一次」。要改用其他連接埠，請在 Harness Relay 結束時修改資料夾旁的 desktop.json 裡的 "port"。',
  startFailed: 'Harness Relay 的伺服器無法啟動',
  startTimedOut: 'Harness Relay 的伺服器太久沒有啟動完成，已經停止它',
  startTimedOutDetail: '如果 macOS 詢問是否允許使用鑰匙圈，請先回答，再從選單選「啟動伺服器」。',
  startFailedDetail: (log: string) => (log.trim() ? `最後的輸出：\n\n${log.trim()}` : '沒有任何輸出。詳細內容請看記錄檔。'),
  crashed: 'Harness Relay 的伺服器意外停止了',
  crashedDetail: '從選單列（或系統匣）的圖示選「啟動伺服器」重新啟動，詳細內容請看記錄檔。',
  restartConfirm: '要重新啟動伺服器嗎？',
  restartDetail: '正在回覆的對話會被中斷。',
  version: '版本',

  // The menu bar of the chat's window (macOS; on Windows and Linux, Alt shows it).
  mAbout: '關於 Harness Relay',
  mHide: '隱藏 Harness Relay',
  mHideOthers: '隱藏其他',
  mShowAll: '顯示全部',
  mEdit: '編輯',
  mUndo: '復原',
  mRedo: '重做',
  mCut: '剪下',
  mCopy: '拷貝',
  mPaste: '貼上',
  mSelectAll: '全選',
  mView: '顯示方式',
  mReload: '重新載入',
  mActualSize: '實際大小',
  mZoomIn: '放大',
  mZoomOut: '縮小',
  mFullScreen: '全螢幕',
  mWindow: '視窗',
  mMinimize: '縮到最小',
  mClose: '關閉視窗',

  tailscaleMissing: '找不到 Tailscale',
  tailscaleMissingDetail:
    '要從手機使用，請在這台電腦和手機都安裝 Tailscale，並登入同一個 tailnet。在 Mac 上，裝好 Tailscale app 即可。',
  tailscaleNotRunning: 'Tailscale 還沒有連線',
  tailscaleNotRunningDetail: '請打開 Tailscale 並登入，再選一次「分享到手機」。',
  tailscaleApproval: '要先為你的 tailnet 開啟 Serve 和 HTTPS',
  tailscaleApprovalDetail: '已經在瀏覽器打開 Tailscale 的頁面。在那裡允許之後，再選一次「分享到手機」。',
  tailscaleAccessDenied: 'Tailscale 不允許這個使用者變更設定',
  tailscaleAccessDeniedDetail: (output: string) =>
    `在終端機執行一次：\n\nsudo tailscale set --operator=$USER\n\n再選一次「分享到手機」。\n\nTailscale 的訊息：\n${output}`,
  tailscaleFailed: '無法分享到 tailnet',
  tailscaleFailedDetail: (output: string) => `Tailscale 的訊息：\n${output}`,
  tailscaleStatusUnknown:
    '讀不到這台電腦目前在 tailnet 分享了什麼（tailscale serve status 沒有回應），為了不蓋掉其他服務或 Funnel，這次沒有分享。請確認 Tailscale 正常執行，再選一次「分享到手機」。',
  tailscalePortsTaken:
    '這台電腦的 tailnet 網址上，HTTPS 的 443、8443 與 10000 都已經分享了其他服務。請照「用手機連線」的說明手動分享，或先用 tailscale serve --https=<port> off 停止其中一個。',
  shared: '已經分享到你的 tailnet',
  sharedDetail: (url: string) =>
    `在手機打開 Tailscale，然後用瀏覽器打開：\n\n${url}\n\n也可以把它加到主畫面。這個分享會一直保留，電腦重新開機後也一樣。`,
  needsRestart: '伺服器要重新啟動，才會接受從手機來的連線',
  needsRestartDetail: (url: string) => `重新啟動後，在手機打開：\n\n${url}\n\n正在回覆的對話會被中斷。`,
  loginItemApproval: '請在系統設定允許 Harness Relay 登入時啟動',
  loginItemApprovalDetail: '打開「系統設定 → 一般 → 登入項目與延伸功能」，允許 Harness Relay。',

  // Updates (update.ts)
  updateTo: (version: string) => `更新到 ${version}…`,
  updateDownloading: (percent: number) => `正在下載更新…（${percent}%）`,
  updateInstalling: '正在安裝更新…',
  updateConfirm: (version: string) => `要把 Harness Relay 更新到 ${version} 嗎？`,
  updateConfirmDetail: 'Harness Relay 會下載新版並檢查它，然後結束、換成新版再打開。正在回覆的對話會被中斷。',
  updateNow: '立即更新',
  releaseNotes: '查看版本說明',
  updateManual: '這個 Harness Relay 無法自己更新',
  updateManualDetail: (why: ManualReason) =>
    ({
      'not-packaged': '它是從原始碼執行的（npm run desktop）。請到發布頁下載新版。',
      'no-installer': '新版沒有這個系統的安裝檔。請到發布頁看看。',
      'no-checksum': 'GitHub 沒有提供這個安裝檔的檢查碼，無法確認下載的內容。請到發布頁手動下載。',
      'read-only': 'Harness Relay 不在可以替換的位置（例如直接從 .dmg 執行，或所在的資料夾不能寫入）。請到發布頁下載新版；在 Mac 上，請把它拖到「應用程式」資料夾。',
      'not-appimage': '在 Linux 上只有 AppImage 能自己更新。請到發布頁下載新版。',
    })[why],
  updateFailed: '無法更新 Harness Relay',
  updateFailedDetail: (failure: UpdateFailure) =>
    ({
      download: '下載失敗。請確認網路連線，再試一次。',
      checksum: '下載的檔案和 GitHub 公布的檢查碼不符，已經刪除，沒有安裝。',
      unpack: '無法打開下載的安裝檔。',
      verify: '下載的 app 簽章、識別碼或版本不符，沒有安裝。',
      replace: '無法把目前的 app 換成新版，目前的版本維持不變。',
      start: '無法啟動新版。Harness Relay 繼續執行目前的版本。',
    })[failure],
  updateOpenedInstaller: '已經打開新版的安裝檔：把 Harness Relay 拖到「應用程式」資料夾、取代舊版即可（macOS 可能要求允許「App 管理」）。',
};

export type DesktopMessages = typeof zhTW;

const en: DesktopMessages = {
  starting: 'Starting…',
  running: (url) => `Running at ${url}`,
  stopping: 'Stopping…',
  stopped: 'Stopped',
  open: 'Open Harness Relay',
  shareWithPhone: 'Share with your phone (Tailscale)…',
  copyPhoneAddress: (url) => `Copy phone address: ${url}`,
  openAtLogin: 'Open at login',
  keepAwake: 'Keep this computer awake while running',
  openDataFolder: 'Open data folder',
  showLog: 'Show log',
  start: 'Start server',
  restart: 'Restart server…',
  quit: 'Quit Harness Relay',

  ok: 'OK',
  cancel: 'Cancel',
  retry: 'Try again',
  later: 'Later',
  copyAddress: 'Copy address',
  restartNow: 'Restart now',
  quitApp: 'Quit Harness Relay',
  openInBrowser: 'Open in browser',
  openDownloadPage: 'Open download page',

  portInUse: (port) => `Port ${port} is already in use by another program`,
  portInUseDetail:
    'It may be a Harness Relay started with npm start or npm run dev. Stop it, then choose Try again. To use another port, quit Harness Relay and change "port" in desktop.json, next to its data folder.',
  startFailed: "Harness Relay's server could not start",
  startTimedOut: "Harness Relay's server took too long to start and was stopped",
  startTimedOutDetail: 'If macOS asked whether Harness Relay may use the keychain, answer it, then choose Start server in the menu.',
  startFailedDetail: (log) => (log.trim() ? `Its last output:\n\n${log.trim()}` : 'It printed nothing. See the log for details.'),
  crashed: "Harness Relay's server stopped unexpectedly",
  crashedDetail: 'Choose Start server from the icon in the menu bar (or system tray) to start it again. See the log for details.',
  restartConfirm: 'Restart the server?',
  restartDetail: 'Conversations that are replying will be stopped.',
  version: 'Version',

  mAbout: 'About Harness Relay',
  mHide: 'Hide Harness Relay',
  mHideOthers: 'Hide Others',
  mShowAll: 'Show All',
  mEdit: 'Edit',
  mUndo: 'Undo',
  mRedo: 'Redo',
  mCut: 'Cut',
  mCopy: 'Copy',
  mPaste: 'Paste',
  mSelectAll: 'Select All',
  mView: 'View',
  mReload: 'Reload',
  mActualSize: 'Actual Size',
  mZoomIn: 'Zoom In',
  mZoomOut: 'Zoom Out',
  mFullScreen: 'Full Screen',
  mWindow: 'Window',
  mMinimize: 'Minimize',
  mClose: 'Close Window',

  tailscaleMissing: 'Tailscale was not found',
  tailscaleMissingDetail:
    'To use Harness Relay from your phone, install Tailscale on this computer and on the phone, signed in to the same tailnet. On a Mac, the Tailscale app is enough.',
  tailscaleNotRunning: 'Tailscale is not connected',
  tailscaleNotRunningDetail: 'Open Tailscale and sign in, then choose Share with your phone again.',
  tailscaleApproval: 'Serve and HTTPS have to be turned on for your tailnet first',
  tailscaleApprovalDetail: "Tailscale's page is open in your browser. Allow it there, then choose Share with your phone again.",
  tailscaleAccessDenied: "Tailscale does not let this user change its settings",
  tailscaleAccessDeniedDetail: (output) =>
    `Run this once in a terminal:\n\nsudo tailscale set --operator=$USER\n\nThen choose Share with your phone again.\n\nTailscale said:\n${output}`,
  tailscaleFailed: 'Could not share with your tailnet',
  tailscaleFailedDetail: (output) => `Tailscale said:\n${output}`,
  tailscaleStatusUnknown:
    "Could not read what this computer already shares with the tailnet (tailscale serve status did not answer), so nothing was shared: it could take over another service or Funnel. Check that Tailscale runs, then choose Share with your phone again.",
  tailscalePortsTaken:
    "HTTPS ports 443, 8443 and 10000 of this computer's tailnet address already share something else. Share Harness Relay by hand, as in Use it from your phone, or first stop one of them with tailscale serve --https=<port> off.",
  shared: 'Shared with your tailnet',
  sharedDetail: (url) =>
    `Turn Tailscale on in your phone and open this address in its browser:\n\n${url}\n\nYou can add it to the home screen too. The sharing stays on, also after the computer restarts.`,
  needsRestart: 'The server has to restart to accept connections from your phone',
  needsRestartDetail: (url) => `After the restart, open this on your phone:\n\n${url}\n\nConversations that are replying will be stopped.`,
  loginItemApproval: 'Allow Harness Relay to open at login in System Settings',
  loginItemApprovalDetail: 'Open System Settings → General → Login Items & Extensions and allow Harness Relay.',

  updateTo: (version) => `Update to ${version}…`,
  updateDownloading: (percent) => `Downloading the update… (${percent}%)`,
  updateInstalling: 'Installing the update…',
  updateConfirm: (version) => `Update Harness Relay to ${version}?`,
  updateConfirmDetail:
    'Harness Relay downloads the new version and checks it, then quits and opens again as the new version. Conversations that are replying will be stopped.',
  updateNow: 'Update now',
  releaseNotes: 'Release notes',
  updateManual: 'This Harness Relay cannot update itself',
  updateManualDetail: (why) =>
    ({
      'not-packaged': 'It runs from the source code (npm run desktop). Download the new version from the releases page.',
      'no-installer': 'The new version has no installer for this system. See the releases page.',
      'no-checksum': 'GitHub gives no checksum for its installer, so the download could not be checked. Download it from the releases page.',
      'read-only':
        'Harness Relay cannot be replaced where it is (it runs from the .dmg, say, or from a folder it may not write in). Download the new version from the releases page; on a Mac, drag it into Applications.',
      'not-appimage': 'On Linux, only the AppImage updates itself. Download the new version from the releases page.',
    })[why],
  updateFailed: 'Could not update Harness Relay',
  updateFailedDetail: (failure) =>
    ({
      download: 'The download failed. Check the connection and try again.',
      checksum: 'The download does not match the checksum GitHub published for it: it was deleted, not installed.',
      unpack: 'The downloaded installer could not be opened.',
      verify: "The downloaded app's signature, identifier or version is not the expected one: it was not installed.",
      replace: 'The app could not be replaced by the new version: this version stays as it is.',
      start: 'The new version could not be started. Harness Relay runs on as this version.',
    })[failure],
  updateOpenedInstaller: "The new version's installer is open: drag Harness Relay into Applications, replacing this one (macOS may ask you to allow App Management).",
};

export const DESKTOP_MESSAGES: Record<DesktopLang, DesktopMessages> = { 'zh-TW': zhTW, en };

export function messages(lang: DesktopLang): DesktopMessages {
  return DESKTOP_MESSAGES[lang];
}
