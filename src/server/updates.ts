// The desktop app's updates, as the chat shows them (Settings' Version card, and the dialog that offers
// a new version). The app asks GitHub and updates itself (desktop/src/update.ts); the server only
// keeps what the app last said, and passes the user's asks (check now, update) on to it. Run any other
// way (`npm start`, `npm run dev`), there are no updates: only the version is known.

import type { DesktopUpdate, UpdateStatus } from '../shared/types';
import type { DesktopParent } from './parent';

/** How long a check asked for from the chat is waited for before what is known is given. */
export const CHECK_ANSWER_MS = 30_000;

export class Updates {
  private last: DesktopUpdate = { updates: false };
  /** Checks asked for from the chat, waiting for the app to say it has checked. */
  private waiting: (() => void)[] = [];

  constructor(
    private parent: Pick<DesktopParent, 'send' | 'onUpdate'> | undefined,
    private version: () => Promise<string>,
  ) {
    parent?.onUpdate((update) => {
      this.last = update;
      if (!update.checking) for (const done of this.waiting.splice(0)) done();
    });
  }

  /** This version, and what the app last said of its updates. */
  async status(): Promise<UpdateStatus> {
    return { ...this.last, current: await this.version() };
  }

  /**
   * Asks the app to check GitHub now (it asks at most every five minutes: otherwise it says what it knows),
   * and gives what it says once the check is done, or what is known after `timeoutMs`.
   */
  async check(timeoutMs = CHECK_ANSWER_MS): Promise<UpdateStatus> {
    if (this.parent && this.last.updates) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let answered: () => void = () => {};
      const checked = new Promise<void>((done) => this.waiting.push((answered = done)));
      this.parent.send({ type: 'update-check' });
      await Promise.race([checked, new Promise<void>((done) => (timer = setTimeout(done, timeoutMs)))]);
      clearTimeout(timer);
      // Not answered in time: no longer waited for.
      this.waiting = this.waiting.filter((w) => w !== answered);
    }
    return this.status();
  }

  /**
   * Asks the app to update to the newer version: it asks the user first, in a dialog of its own on the
   * computer it runs on, as from its menu (and asks once, however often it is asked meanwhile). Says
   * why not when there is none to update to, or one is under way.
   */
  install(): 'asked' | 'none' | 'under-way' {
    if (this.last.progress) return 'under-way';
    if (!this.parent || !this.last.available) return 'none';
    this.parent.send({ type: 'update-install' });
    return 'asked';
  }
}
