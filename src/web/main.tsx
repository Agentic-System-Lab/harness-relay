import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import { App } from './App';
import { I18nProvider } from './i18n';
import { startTheme } from './theme';

// iOS Safari ignores the viewport's user-scalable=no; this stops its pinch zoom.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// The light or dark theme chosen in Settings, or the system's (index.html set it already, before drawing).
startTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
