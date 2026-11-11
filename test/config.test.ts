import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG, CONFIG_PROBLEMS, limitsOf, readConfig } from '../src/server/config';
import { DEFAULT_LIMITS } from '../src/shared/types';

describe('server configuration from the environment', () => {
  it('keeps the defaults when nothing is set (or only blanks)', () => {
    const { config, problems } = readConfig({});
    expect(problems).toEqual([]);
    expect(config).toEqual({
      maxAccounts: 10,
      maxTeamAgents: 8,
      turnTimeoutMinutes: 45,
      turnTimeoutMs: 45 * 60_000,
      voiceModelBaseUrl: undefined,
      voiceEngineBaseUrl: undefined,
      voiceDir: undefined,
    });
    expect(limitsOf(config)).toEqual(DEFAULT_LIMITS);
    const blank = readConfig({ RELAY_MAX_ACCOUNTS: ' ', RELAY_MAX_TEAM_AGENTS: '', RELAY_TURN_TIMEOUT_MIN: '', RELAY_VOICE_DIR: '  ', RELAY_VOICE_MODEL_BASE_URL: '' });
    expect(blank).toEqual({ config, problems: [] });
  });

  it('reads the limits and the turn timeout as whole numbers in their ranges', () => {
    const { config, problems } = readConfig({ RELAY_MAX_ACCOUNTS: '20', RELAY_MAX_TEAM_AGENTS: ' 16 ', RELAY_TURN_TIMEOUT_MIN: '90' });
    expect(problems).toEqual([]);
    expect(limitsOf(config)).toEqual({ maxAccounts: 20, maxTeamAgents: 16, turnTimeoutMinutes: 90 });
    expect(config.turnTimeoutMs).toBe(90 * 60_000);
    expect(limitsOf(readConfig({ RELAY_MAX_ACCOUNTS: '1', RELAY_MAX_TEAM_AGENTS: '32', RELAY_TURN_TIMEOUT_MIN: '1440' }).config)).toEqual({
      maxAccounts: 1,
      maxTeamAgents: 32,
      turnTimeoutMinutes: 1440,
    });
  });

  it('reports a value that is not valid, and keeps the default for it', () => {
    for (const [name, value] of [
      ['RELAY_MAX_ACCOUNTS', '0'],
      ['RELAY_MAX_ACCOUNTS', '101'],
      ['RELAY_MAX_TEAM_AGENTS', 'twelve'],
      ['RELAY_MAX_TEAM_AGENTS', '33'],
      ['RELAY_MAX_TEAM_AGENTS', '-1'],
      ['RELAY_TURN_TIMEOUT_MIN', '1.5'],
      ['RELAY_TURN_TIMEOUT_MIN', '1441'],
      ['RELAY_TURN_TIMEOUT_MIN', '1e3'],
    ] as const) {
      const { config, problems } = readConfig({ [name]: value });
      expect(problems, `${name}=${value}`).toEqual([expect.stringMatching(new RegExp(`^${name}=${value.replace('.', '\\.')} is not a whole number from 1 to \\d+\\.$`))]);
      expect(limitsOf(config)).toEqual(DEFAULT_LIMITS);
    }
    // Each one is reported.
    expect(readConfig({ RELAY_MAX_ACCOUNTS: 'x', RELAY_TURN_TIMEOUT_MIN: '0' }).problems).toHaveLength(2);
  });

  it('takes http and https folders to download voice input from, without a trailing slash', () => {
    const { config, problems } = readConfig({
      RELAY_VOICE_MODEL_BASE_URL: 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
      RELAY_VOICE_ENGINE_BASE_URL: ' http://files.lan:8080/whisper ',
    });
    expect(problems).toEqual([]);
    expect(config.voiceModelBaseUrl).toBe('https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main');
    expect(config.voiceEngineBaseUrl).toBe('http://files.lan:8080/whisper');
  });

  it('refuses an address that is not an http(s) folder, or that holds a password', () => {
    for (const [value, why] of [
      ['not a url', /is not a URL/],
      ['file:///srv/whisper', /http or https URL, not file:/],
      ['ftp://files.lan/whisper', /http or https URL, not ftp:/],
      ['https://me:secret@files.lan/whisper', /user name or password/],
      ['https://files.lan/whisper?token=1', /without \? or #/],
      ['https://files.lan/whisper#models', /without \? or #/],
    ] as const) {
      const { config, problems } = readConfig({ RELAY_VOICE_MODEL_BASE_URL: value, RELAY_VOICE_ENGINE_BASE_URL: value });
      expect(problems, value).toHaveLength(2);
      for (const p of problems) expect(p).toMatch(why);
      expect(problems[0]).toMatch(/^RELAY_VOICE_MODEL_BASE_URL/);
      expect(problems[1]).toMatch(/^RELAY_VOICE_ENGINE_BASE_URL/);
      // A password is never repeated back.
      for (const p of problems) expect(p).not.toContain('secret');
      expect(config.voiceModelBaseUrl).toBeUndefined();
      expect(config.voiceEngineBaseUrl).toBeUndefined();
    }
  });

  it("takes voice input's folder as an absolute path", () => {
    expect(readConfig({ RELAY_VOICE_DIR: '/srv/relay-voice' }).config.voiceDir).toBe(resolve('/srv/relay-voice'));
    expect(readConfig({ RELAY_VOICE_DIR: 'voice-models' }).config.voiceDir).toBe(resolve('voice-models'));
  });

  it("reads this server's environment once, which the tests leave unset", () => {
    expect(CONFIG_PROBLEMS).toEqual([]);
    expect(limitsOf(CONFIG)).toEqual(DEFAULT_LIMITS);
  });
});
