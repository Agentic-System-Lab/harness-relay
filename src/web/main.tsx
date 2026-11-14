import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import { App } from './App';
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

// Only the language the page shows is loaded, before it is drawn (i18n.tsx); the other when chosen.
// When they cannot be loaded, the page reloads for them once (chunks.ts), waiting meanwhile; after
// that, it says so in both languages.
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
    root.render(<LoadFailed {...PAGE_LOAD_FAILED} />);
  },
);
