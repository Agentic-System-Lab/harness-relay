import { COMPUTER_LIMITS } from '../../shared/types';
import type { GatewayTool } from '../gateway';
import { t } from '../i18n';
import type { ComputerService } from './session';

/*
 * The computer group's tools on the gateway (`gateway.ts`): the chat's Cua computer (`session.ts`), the same
 * for every CLI. Looking is `read`; clicking, typing, keys, scrolling, starting an app and a command in it,
 * and copying files in or out are `act` (asked about below full access, and "always allow" for the rest of
 * the chat as for any tool). What the screen and a command show comes back as data. While the user has
 * taken control, every call but the hand-over is refused.
 */

const at = (description: string) => ({ type: 'integer', minimum: 0, maximum: 10_000, description });

/** A whole number from 0, or why not. */
function coordinate(args: Record<string, unknown>, key: string): number {
  const n = Number(args[key]);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error(`${key} must be a whole number of pixels in the latest screenshot`);
  return n;
}

const KEYS = /^(?:[a-z0-9_]{1,16}|[-=[\];'`,./\\])(?:\+(?:[a-z0-9_]{1,16}|[-=[\];'`,./\\])){0,4}$/;

/** A key, or keys joined by `+`, as Cua names them; or why not. */
export function keysOf(args: Record<string, unknown>): string {
  const keys = String(args.keys ?? '')
    .trim()
    .toLowerCase();
  if (!KEYS.test(keys)) throw new Error('keys must be a key name, or keys joined by + (ctrl+c, enter, alt+tab)');
  return keys;
}

const TYPED_SHOWN = 2000;

export function computerTools(computer: ComputerService, tmpDir: () => string): GatewayTool[] {
  const unavailable = () => computer.unavailable();
  return [
    {
      name: 'computer_screenshot',
      group: 'computer',
      tier: 'read',
      description:
        "Take a screenshot of this conversation's computer: a Linux desktop (Ubuntu with Xfce and Firefox) of its own, which the agents and the user share. The first call starts it (the first time, its image is downloaded: minutes). Coordinates of the other computer tools are pixels of the latest screenshot. Take one before acting, and again after acting to see what changed. Returns the image and the file's path: put ![What it shows](<that path>) in your reply to show it to the user. While the user has taken control of the computer, every computer tool is refused: wait for them to hand it back.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      describe: () => ({ title: t().computer.gw.screenshot }),
      unavailable,
      run: (_a, ctx) => computer.call(ctx, 'computer_screenshot', {}, 'screenshot', 60 * 60_000),
    },
    {
      name: 'computer_click',
      group: 'computer',
      tier: 'act',
      description:
        "Click at a point of the computer's screen, in the latest screenshot's pixels (left button by default; double for a double click). Asked about first below full access. Take a screenshot afterwards to see what it did.",
      inputSchema: {
        type: 'object',
        properties: {
          x: at('Pixels from the left of the latest screenshot.'),
          y: at('Pixels from the top of the latest screenshot.'),
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          double: { type: 'boolean', description: 'A double click.' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      describe: (a) => ({ title: t().computer.gw.click(Number(a.x), Number(a.y), a.double === true, String(a.button ?? 'left')) }),
      unavailable,
      run: async (a, ctx) => {
        const x = coordinate(a, 'x');
        const y = coordinate(a, 'y');
        const button = a.button === 'right' || a.button === 'middle' ? a.button : undefined;
        const what = t().computer.gw.click(x, y, a.double === true, button ?? 'left');
        return computer.call(
          ctx,
          a.double === true ? 'computer_double_click' : 'computer_click',
          { x, y, ...(button ? { button } : {}) },
          what,
        );
      },
    },
    {
      name: 'computer_type',
      group: 'computer',
      tier: 'act',
      description:
        'Type text on the computer, into the window that has the keyboard (click a field first). Asked about first below full access. Never type passwords or other secrets: ask the user to take over (computer_hand_over) instead.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: COMPUTER_LIMITS.textMax } },
        required: ['text'],
        additionalProperties: false,
      },
      describe: (a) => {
        const text = String(a.text ?? '');
        return { title: t().computer.gw.type, detail: t().gw.typed(text.slice(0, TYPED_SHOWN), text.length) };
      },
      unavailable,
      run: (a, ctx) => {
        const text = String(a.text ?? '');
        if (!text || text.length > COMPUTER_LIMITS.textMax)
          return Promise.resolve({ text: `text is from 1 to ${COMPUTER_LIMITS.textMax} characters`, isError: true });
        return computer.call(ctx, 'computer_type', { text }, t().computer.gw.typed(text.length));
      },
    },
    {
      name: 'computer_key',
      group: 'computer',
      tier: 'act',
      description:
        'Press a key or a key combination on the computer: enter, tab, escape, backspace, up, down, left, right, page_up, page_down, home, end, delete, space, f1…f12, or keys joined by + (ctrl+c, ctrl+shift+t, alt+tab, super). Asked about first below full access.',
      inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'], additionalProperties: false },
      describe: (a) => ({ title: t().computer.gw.key(String(a.keys ?? '')) }),
      unavailable,
      run: async (a, ctx) => {
        const keys = keysOf(a);
        return keys.includes('+')
          ? computer.call(ctx, 'computer_hotkey', { keys }, t().computer.gw.key(keys))
          : computer.call(ctx, 'computer_key', { key: keys }, t().computer.gw.key(keys));
      },
    },
    {
      name: 'computer_scroll',
      group: 'computer',
      tier: 'act',
      description:
        'Scroll on the computer, at a point of the latest screenshot (where the mouse is, without one), by lines (3 by default). Asked about first below full access.',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer', minimum: 1, maximum: COMPUTER_LIMITS.scrollMax },
          x: at('Pixels from the left of the latest screenshot.'),
          y: at('Pixels from the top of the latest screenshot.'),
        },
        required: ['direction'],
        additionalProperties: false,
      },
      describe: (a) => ({ title: t().computer.gw.scroll(String(a.direction ?? 'down')) }),
      unavailable,
      run: async (a, ctx) => {
        const direction = ['up', 'down', 'left', 'right'].includes(String(a.direction)) ? String(a.direction) : 'down';
        const amount = Math.min(COMPUTER_LIMITS.scrollMax, Math.max(1, Number.isInteger(a.amount) ? (a.amount as number) : 3));
        if (a.x !== undefined || a.y !== undefined) {
          const moved = await computer.call(
            ctx,
            'computer_move_cursor',
            { x: coordinate(a, 'x'), y: coordinate(a, 'y') },
            t().computer.gw.scroll(direction),
          );
          if (moved.isError) return moved;
        }
        return computer.call(ctx, 'computer_scroll', { direction, amount }, t().computer.gw.scroll(direction));
      },
    },
    {
      name: 'computer_drag',
      group: 'computer',
      tier: 'act',
      description:
        'Drag with the left button held, from one point of the latest screenshot to another. Asked about first below full access.',
      inputSchema: {
        type: 'object',
        properties: {
          from_x: at('Start, from the left.'),
          from_y: at('Start, from the top.'),
          to_x: at('End, from the left.'),
          to_y: at('End, from the top.'),
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
        additionalProperties: false,
      },
      describe: () => ({ title: t().computer.gw.drag }),
      unavailable,
      run: async (a, ctx) =>
        computer.call(
          ctx,
          'computer_drag',
          {
            start_x: coordinate(a, 'from_x'),
            start_y: coordinate(a, 'from_y'),
            end_x: coordinate(a, 'to_x'),
            end_y: coordinate(a, 'to_y'),
          },
          t().computer.gw.drag,
        ),
    },
    {
      name: 'computer_open',
      group: 'computer',
      tier: 'act',
      description:
        'Start an app on the computer and give it the keyboard, by its command (firefox, xfce4-terminal, mousepad, thunar, or one you installed). Asked about first below full access.',
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', maxLength: 200 } },
        required: ['app'],
        additionalProperties: false,
      },
      describe: (a) => ({ title: t().computer.gw.open(String(a.app ?? '')) }),
      unavailable,
      run: (a, ctx) => {
        const app = String(a.app ?? '').trim();
        if (!app || app.length > 200 || /[\0\r\n]/.test(app))
          return Promise.resolve({ text: 'app must be the command that starts it', isError: true });
        return computer.call(ctx, 'computer_launch', { app }, t().computer.gw.open(app));
      },
    },
    {
      name: 'computer_shell',
      group: 'computer',
      tier: 'act',
      description:
        'Run a shell command in the computer (sh -c, as its user `cua`, 120 seconds at most), not on the computer Harness Relay runs on: install a package, start a program, read a file there. Its output comes back as data. Asked about first below full access. To start a graphical app, use computer_open, or end the command with & so it does not wait.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', maxLength: 20_000 } },
        required: ['command'],
        additionalProperties: false,
      },
      describe: (a) => ({ title: t().computer.gw.shell, detail: String(a.command ?? '').slice(0, TYPED_SHOWN) }),
      unavailable,
      run: (a, ctx) => {
        const command = String(a.command ?? '');
        if (!command.trim() || command.length > 20_000 || command.includes('\0'))
          return Promise.resolve({ text: 'command is needed', isError: true });
        return computer.call(ctx, 'computer_shell', { command }, t().computer.gw.ran(command), 150_000);
      },
    },
    {
      name: 'computer_upload',
      group: 'computer',
      tier: 'act',
      description:
        "Copy a file of this conversation's working directory into the computer (one file; to: an absolute path there, ~/Desktop/<its name> by default). Asked about first below full access.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file, relative to the working directory.' },
          to: { type: 'string', description: 'Where in the computer, an absolute path (/home/cua/Desktop/<name> by default).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      describe: (a) => ({ title: t().computer.gw.upload(String(a.path ?? ''), String(a.to ?? defaultTo(a))) }),
      unavailable,
      run: (a, ctx) => computer.upload(ctx, String(a.path ?? ''), String(a.to ?? defaultTo(a))),
    },
    {
      name: 'computer_download',
      group: 'computer',
      tier: 'act',
      description:
        "Copy a file of the computer (from: an absolute path there) into this conversation's working directory (to: a path relative to it; an existing file there is replaced). Not in a read-only conversation. Asked about first below full access.",
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      describe: (a) => ({ title: t().computer.gw.download(String(a.from ?? ''), String(a.to ?? '')) }),
      unavailable,
      run: (a, ctx) => computer.download(ctx, String(a.from ?? ''), String(a.to ?? ''), tmpDir()),
    },
    {
      name: 'computer_hand_over',
      group: 'computer',
      // Runs at once in every permission: its own card is the user's question, and only the user acts.
      tier: 'read',
      direct: true,
      description:
        "Ask the user to take control of the computer when a step needs them: a sign-in, a password, a two-factor code, a CAPTCHA, a payment, a choice only they can make. Never ask the user for a password or code to type yourself; hand the computer over instead. The user is shown a card in the chat and takes control in the computer's panel, while this call and every other computer call wait: until they hand it back, decline, or the time runs out (15 minutes to start, 30 once started). It says only how it ended and the user's note, never what they did. Afterwards take a screenshot. Not available in a run nobody is watching.",
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'What the user should do on the computer, and why, in their language (shown on the card), e.g. "Sign in to your account in Firefox, then hand it back".',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      describe: (a) => ({ title: t().computer.gw.handOver(String(a.reason ?? '')) }),
      unavailable,
      run: (a, ctx, _scope, gone) => {
        const reason = String(a.reason ?? '').trim();
        if (!reason) return Promise.resolve({ text: 'reason is required: say what the user should do on the computer', isError: true });
        return computer.handOver(ctx, reason, gone);
      },
    },
  ];
}

/** Where an upload goes without `to`: the user's Desktop in the computer, under the file's own name. */
function defaultTo(a: Record<string, unknown>): string {
  const name =
    String(a.path ?? '')
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? 'file';
  return '/home/cua/Desktop/' + name;
}
