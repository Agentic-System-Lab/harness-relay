import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import { App } from './App';
import { reloadForMissingPart } from './chunks';
import { LoadFailed, PAGE_LOAD_FAILED } from './components/Deferred';
import { I18nProvider, currentLang, loadMessages } from './i18n';
import { startTheme } from './theme';
import { api } from './api';
import { watchVersion } from './update';

// iOS Safari ignores the viewport's user-scalable=no; this stops its pinch zoom.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// The light or dark theme chosen in Settings, or the system's (index.html set it already, before drawing).
startTheme();

// Updated while this page was open: the page reloads for the new version's code.
watchVersion(api.serverVersion, () => location.reload(), {
  on: (event, listener) => {
    window.addEventListener(event, listener);
    return () => window.removeEventListener(event, listener);
  },
});

// A part of the page loaded when first needed that could not be (Vite's event, for each such import):
// the page reloads for it once (chunks.ts); a part still missing says so (components/Deferred.tsx).
let reloading = false;
window.addEventListener('vite:preloadError', (e) => {
  if (!reloading) {
    let store: Storage | undefined;
    try {
      store = sessionStorage;
    } catch {
      // no storage: no reload, which could not be told from the next
    }
    if (!reloadForMissingPart(store)) return;
    reloading = true;
    location.reload();
  }
  e.preventDefault();
});

// Only the language the page shows is loaded, before it is drawn (i18n.tsx); the other when chosen.
const root = createRoot(document.getElementById('root')!);
loadMessages(currentLang()).then(
  () =>
    root.render(
      <StrictMode>
        <I18nProvider>
          <App />
        </I18nProvider>
      </StrictMode>,
    ),
  (err: unknown) => {
    console.error(err);
    // Its words could not be loaded: the page says so in both languages, unless it is reloading for them.
    if (!reloading) root.render(<LoadFailed {...PAGE_LOAD_FAILED} />);
  },
);
