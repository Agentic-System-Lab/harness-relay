import type { Page } from '@playwright/test';
import type { VoiceStatus } from '../../src/shared/types';

/** A tone stands in for a microphone so the browser records without a physical device. */
export async function syntheticMicrophone(page: Page, status: VoiceStatus) {
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const tone = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      tone.connect(dest);
      tone.start();
      await ctx.resume();
      return dest.stream;
    };
  });
  await page.route('**/api/voice', (route) => route.fulfill({ json: { ...status, ready: true } }));
  await page.route('**/api/voice/prepare', (route) => route.fulfill({ json: { ok: true } }));
}
