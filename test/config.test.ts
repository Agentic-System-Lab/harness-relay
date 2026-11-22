import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
      turnTimeoutMinutes: 24 * 60,
      turnTimeoutMs: 24 * 60 * 60_000,
      voiceModelBaseUrl: undefined,
      voiceEngineBaseUrl: undefined,
      voiceDir: undefined,
      runCode: false,
    });
    expect(limitsOf(config)).toEqual(DEFAULT_LIMITS);
    const blank = readConfig({
      RELAY_MAX_ACCOUNTS: ' ',
      RELAY_MAX_TEAM_AGENTS: '',
      RELAY_TURN_TIMEOUT_MIN: '',
      RELAY_VOICE_DIR: '  ',
      RELAY_VOICE_MODEL_BASE_URL: '',
      RELAY_RUN_CODE: ' ',
    });
    expect(blank).toEqual({ config, problems: [] });
  });

  it('turns on RLM mode with its sub-model as <backend>/<model>, which turns run_code on too', () => {
    expect(readConfig({ RELAY_RLM: ' anthropic/claude-haiku-5-5 ' })).toMatchObject({
      config: { runCode: true, rlmModel: 'anthropic/claude-haiku-5-5' },
      problems: [],
    });
    // One of the user's own endpoints, whose model name may hold a `/` itself.
    expect(readConfig({ RELAY_RLM: 'homelab/Qwen/Qwen3-30B-A3B', RELAY_RUN_CODE: 'on' }).config).toMatchObject({
      runCode: true,
      rlmModel: 'homelab/Qwen/Qwen3-30B-A3B',
    });
    for (const off of ['', 'off', 'OFF']) {
      const read = readConfig({ RELAY_RLM: off });
      expect(read.problems).toEqual([]);
      expect(read.config.rlmModel).toBeUndefined();
      expect(read.config.runCode).toBe(false);
    }
    // Through a CLI that can run with no tool, as one of its accounts.
    expect(readConfig({ RELAY_RLM: 'cli:claude/haiku' }).config).toMatchObject({ runCode: true, rlmModel: 'cli:claude/haiku' });
    expect(readConfig({ RELAY_RLM: 'cli:copilot:work' }).problems).toEqual([]);
    // Not a model: `on` names none; nor a CLI whose runs keep a tool.
    for (const raw of ['on', 'claude-haiku-5-5', '/model', 'openai/', 'cli:codex/gpt-6.2-sol']) {
      const read = readConfig({ RELAY_RLM: raw });
      expect(read.config.rlmModel).toBeUndefined();
      expect(read.problems).toEqual([
        `RELAY_RLM=${raw} must be off, or the sub-model as <backend>/<model> (a model connection in Settings), such as anthropic/claude-haiku-5-5, or through claude, copilot, muse as cli:<provider>[:<account>][/<model>], such as cli:claude/haiku.`,
      ]);
    }
    // RLM mode is run_code's: turning run_code off with it is refused rather than one of them ignored.
    expect(readConfig({ RELAY_RLM: 'openai/gpt-5.4-nano', RELAY_RUN_CODE: 'off' }).problems).toEqual([
      'RELAY_RLM needs run_code: leave RELAY_RUN_CODE unset, or set it to on.',
    ]);
  });

  it('gives agents run_code only when RELAY_RUN_CODE is on, and refuses a value that is neither on nor off', () => {
    expect(readConfig({ RELAY_RUN_CODE: 'on' })).toMatchObject({ config: { runCode: true }, problems: [] });
    expect(readConfig({ RELAY_RUN_CODE: ' ON ' }).config.runCode).toBe(true);
    expect(readConfig({ RELAY_RUN_CODE: 'off' })).toMatchObject({ config: { runCode: false }, problems: [] });
    expect(readConfig({ RELAY_RUN_CODE: 'Off' }).config.runCode).toBe(false);
    // Not read as on: the server refuses to start rather than guess.
    for (const raw of ['1', 'true', 'yes', 'enabled']) {
      const read = readConfig({ RELAY_RUN_CODE: raw });
      expect(read.config.runCode).toBe(false);
      expect(read.problems).toEqual([`RELAY_RUN_CODE=${raw} is neither on nor off.`]);
    }
  });

  it("takes another cloud's Microsoft sign-in and Graph over https, or a stand-in's over http on this computer only", () => {
    const national = readConfig({
      RELAY_MICROSOFT_LOGIN_URL: 'https://login.microsoftonline.us/',
      RELAY_MICROSOFT_GRAPH_URL: ' https://graph.microsoft.us ',
    });
    expect(national.problems).toEqual([]);
    expect(national.config).toMatchObject({
      microsoftLoginUrl: 'https://login.microsoftonline.us',
      microsoftGraphUrl: 'https://graph.microsoft.us',
    });
    expect(readConfig({ RELAY_MICROSOFT_LOGIN_URL: 'http://127.0.0.1:9000' }).config.microsoftLoginUrl).toBe('http://127.0.0.1:9000');
    const plain = readConfig({ RELAY_MICROSOFT_LOGIN_URL: 'http://login.example.com', RELAY_MICROSOFT_GRAPH_URL: 'graph' });
    expect(plain.config.microsoftLoginUrl).toBeUndefined();
    expect(plain.config.microsoftGraphUrl).toBeUndefined();
    expect(plain.problems).toEqual([
      'RELAY_MICROSOFT_LOGIN_URL must be an https URL (plain http only to this computer).',
      'RELAY_MICROSOFT_GRAPH_URL is not a URL.',
    ]);
  });

  it("takes publishing's stand-ins on this computer only, and a folder of stand-in repositories", () => {
    const local = readConfig({
      RELAY_RENDER_API_URL: 'http://127.0.0.1:9100/v1',
      RELAY_NEON_API_URL: 'http://localhost:9101/api/v2',
      RELAY_PUBLISH_GIT_DIR: '/tmp/github',
    });
    expect(local.problems).toEqual([]);
    expect(local.config).toMatchObject({
      renderApiUrl: 'http://127.0.0.1:9100/v1',
      neonApiUrl: 'http://localhost:9101/api/v2',
      publishGitDir: resolve('/tmp/github'),
    });
    // A key goes there: never to another host, not even over https.
    const elsewhere = readConfig({ RELAY_RENDER_API_URL: 'https://api.render.example', RELAY_NEON_API_URL: 'http://10.0.0.2' });
    expect(elsewhere.config.renderApiUrl).toBeUndefined();
    expect(elsewhere.config.neonApiUrl).toBeUndefined();
    expect(elsewhere.problems).toEqual([
      "RELAY_RENDER_API_URL must be a stand-in's URL on this computer (127.0.0.1, localhost or [::1]).",
      "RELAY_NEON_API_URL must be a stand-in's URL on this computer (127.0.0.1, localhost or [::1]).",
    ]);
    expect(readConfig({ RELAY_PUBLISH_GIT_DIR: 'relative' }).problems).toHaveLength(1);
  });

  it("takes Microsoft's mail servers as host:port, TLS or STARTTLS as the port says, plain TCP only to this computer", () => {
    const other = readConfig({ RELAY_MICROSOFT_IMAP: 'outlook.office365.us:993', RELAY_MICROSOFT_SMTP: ' smtp.office365.us:587 ' });
    expect(other.problems).toEqual([]);
    expect(other.config).toMatchObject({
      microsoftImap: { host: 'outlook.office365.us', port: 993, security: 'tls' },
      microsoftSmtp: { host: 'smtp.office365.us', port: 587, security: 'starttls' },
    });
    expect(readConfig({ RELAY_MICROSOFT_IMAP: 'imap.example.com:143' }).config.microsoftImap!.security).toBe('starttls');
    expect(readConfig({ RELAY_MICROSOFT_SMTP: 'smtp.example.com:465' }).config.microsoftSmtp!.security).toBe('tls');
    // A stand-in on this computer: plain TCP.
    const stand = readConfig({ RELAY_MICROSOFT_IMAP: '127.0.0.1:1143', RELAY_MICROSOFT_SMTP: '[::1]:1025' });
    expect(stand.config.microsoftImap).toEqual({ host: '127.0.0.1', port: 1143, security: 'none' });
    expect(stand.config.microsoftSmtp).toEqual({ host: '::1', port: 1025, security: 'none' });
    const bad = readConfig({ RELAY_MICROSOFT_IMAP: 'imaps://outlook.office365.com', RELAY_MICROSOFT_SMTP: 'smtp.example.com:70000' });
    expect(bad.config.microsoftImap).toBeUndefined();
    expect(bad.config.microsoftSmtp).toBeUndefined();
    expect(bad.problems).toEqual([
      "RELAY_MICROSOFT_IMAP must be a mail server's host:port.",
      "RELAY_MICROSOFT_SMTP must be a mail server's host:port.",
    ]);
  });

  it('reads the limits and the turn timeout as whole numbers in their ranges', () => {
    const { config, problems } = readConfig({ RELAY_MAX_ACCOUNTS: '20', RELAY_MAX_TEAM_AGENTS: ' 16 ', RELAY_TURN_TIMEOUT_MIN: '90' });
    expect(problems).toEqual([]);
    expect(limitsOf(config)).toEqual({ maxAccounts: 20, maxTeamAgents: 16, turnTimeoutMinutes: 90 });
    expect(config.turnTimeoutMs).toBe(90 * 60_000);
    expect(limitsOf(readConfig({ RELAY_MAX_ACCOUNTS: '1', RELAY_MAX_TEAM_AGENTS: '32', RELAY_TURN_TIMEOUT_MIN: '10080' }).config)).toEqual({
      maxAccounts: 1,
      maxTeamAgents: 32,
      turnTimeoutMinutes: 10080,
    });
    expect(readConfig({ RELAY_TURN_TIMEOUT_MIN: '1' }).config.turnTimeoutMs).toBe(60_000);
  });

  it('reports a value that is not valid, and keeps the default for it', () => {
    for (const [name, value] of [
      ['RELAY_MAX_ACCOUNTS', '0'],
      ['RELAY_MAX_ACCOUNTS', '101'],
      ['RELAY_MAX_TEAM_AGENTS', 'twelve'],
      ['RELAY_MAX_TEAM_AGENTS', '33'],
      ['RELAY_MAX_TEAM_AGENTS', '-1'],
      ['RELAY_TURN_TIMEOUT_MIN', '1.5'],
      ['RELAY_TURN_TIMEOUT_MIN', '10081'],
      ['RELAY_TURN_TIMEOUT_MIN', '1e3'],
    ] as const) {
      const { config, problems } = readConfig({ [name]: value });
      expect(problems, `${name}=${value}`).toEqual([
        expect.stringMatching(new RegExp(`^${name}=${value.replace('.', '\\.')} is not a whole number from 1 to \\d+\\.$`)),
      ]);
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
      ['https://me:secret@files lan/', /is not a URL/],
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

  it("takes voice input's folder as an absolute path, or one from the home folder", () => {
    expect(readConfig({ RELAY_VOICE_DIR: '/srv/relay-voice/' })).toMatchObject({
      config: { voiceDir: resolve('/srv/relay-voice') },
      problems: [],
    });
    expect(readConfig({ RELAY_VOICE_DIR: '~/models/voice' }).config.voiceDir).toBe(join(homedir(), 'models/voice'));
    // The browser the browser tools start, the same way.
    expect(readConfig({ RELAY_BROWSER: '/opt/chromium/chrome' })).toMatchObject({
      config: { browser: resolve('/opt/chromium/chrome') },
      problems: [],
    });
    expect(readConfig({}).config.browser).toBeUndefined();
    expect(readConfig({ RELAY_BROWSER: 'chrome' }).problems).toEqual([
      'RELAY_BROWSER=chrome is not an absolute path (or one starting with ~/).',
    ]);
    expect(readConfig({ RELAY_VOICE_DIR: '~' }).config.voiceDir).toBe(homedir());
    // A relative one would depend on the folder the server starts in (the desktop app's own).
    const relative = readConfig({ RELAY_VOICE_DIR: 'voice-models' });
    expect(relative.config.voiceDir).toBeUndefined();
    expect(relative.problems).toEqual(['RELAY_VOICE_DIR=voice-models is not an absolute path (or one starting with ~/).']);
    expect(readConfig({ RELAY_VOICE_DIR: '~someone/voice' }).problems).toHaveLength(1);
  });

  it("reads this server's environment once, which the tests leave unset", () => {
    expect(CONFIG_PROBLEMS).toEqual([]);
    expect(limitsOf(CONFIG)).toEqual(DEFAULT_LIMITS);
    expect(CONFIG.runCode).toBe(false);
    expect(CONFIG.rlmModel).toBeUndefined();
  });
});
