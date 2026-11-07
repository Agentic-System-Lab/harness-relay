import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import { App } from './App';
import { I18nProvider } from './i18n';

// iOS Safari ignores the viewport's user-scalable=no; this stops its pinch zoom.
document.addEventListener('gesturestart', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
