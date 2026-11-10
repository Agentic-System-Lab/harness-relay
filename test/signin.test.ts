import { describe, expect, it } from 'vitest';
import { inDesktopWindow, signInWhere } from '../src/web/signin';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const APP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) harness-relay/2026.1110.0 Chrome/140.0.0.0 Electron/45.2.3 Safari/537.36';

describe('where the sign-in page points', () => {
  it("knows the desktop app's window by Electron in its user agent", () => {
    expect(inDesktopWindow(APP)).toBe(true);
    expect(inDesktopWindow(CHROME)).toBe(false);
    expect(inDesktopWindow('')).toBe(false);
  });

  it('points at the terminal for a server started there, whatever the browser', () => {
    expect(signInWhere({ desktopServer: false, userAgent: CHROME })).toBe('terminal');
    expect(signInWhere({ desktopServer: false, userAgent: APP })).toBe('terminal');
  });

  it("points the app's window at Open Harness Relay, and a browser at Open in browser", () => {
    expect(signInWhere({ desktopServer: true, userAgent: APP })).toBe('desktop-window');
    expect(signInWhere({ desktopServer: true, userAgent: CHROME })).toBe('desktop-browser');
  });
});
