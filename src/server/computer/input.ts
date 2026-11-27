import { COMPUTER_LIMITS, type ComputerInput } from '../../shared/types';

/*
 * The computer panel's input (`POST /api/conversations/:id/computer/input`), checked before any of it
 * reaches the computer: at most `COMPUTER_LIMITS.eventsMax` events, each of a kind it knows with its values
 * in range.
 */

const fraction = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const BUTTONS = ['left', 'middle', 'right'] as const;
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
/** A key's name as Cua takes it, or names joined by `+` (`ctrl+shift+t`): letters, digits and a few signs. */
const KEYS = /^(?:[a-z0-9_]{1,16}|[-=[\];'`,./\\])(?:\+(?:[a-z0-9_]{1,16}|[-=[\];'`,./\\])){0,4}$/;

/** The input, checked; or why not, in a line. */
export function checkComputerInputs(raw: unknown): ComputerInput[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'events must be a list of the input events';
  if (raw.length > COMPUTER_LIMITS.eventsMax) return `at most ${COMPUTER_LIMITS.eventsMax} events at once`;
  const out: ComputerInput[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') return 'an event must be an object';
    switch (e.type) {
      case 'click':
        if (!fraction(e.x) || !fraction(e.y)) return 'a click is not valid';
        if (e.button !== undefined && !BUTTONS.includes(e.button as never)) return 'a mouse button is not valid';
        out.push({
          type: 'click',
          x: e.x as number,
          y: e.y as number,
          ...(e.button ? { button: e.button as (typeof BUTTONS)[number] } : {}),
          ...(e.double === true ? { double: true } : {}),
        });
        break;
      case 'drag':
        if (![e.x, e.y, e.toX, e.toY].every(fraction)) return 'a drag is not valid';
        out.push({ type: 'drag', x: e.x as number, y: e.y as number, toX: e.toX as number, toY: e.toY as number });
        break;
      case 'scroll': {
        const amount = e.amount;
        if (!fraction(e.x) || !fraction(e.y) || !DIRECTIONS.includes(e.direction as never)) return 'a scroll is not valid';
        if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > COMPUTER_LIMITS.scrollMax)
          return `a scroll is from 1 to ${COMPUTER_LIMITS.scrollMax} lines`;
        out.push({ type: 'scroll', x: e.x as number, y: e.y as number, direction: e.direction as (typeof DIRECTIONS)[number], amount });
        break;
      }
      case 'key':
        if (typeof e.keys !== 'string' || !KEYS.test(e.keys)) return 'a key is not valid';
        out.push({ type: 'key', keys: e.keys });
        break;
      case 'text':
        if (typeof e.text !== 'string' || !e.text.length || e.text.length > COMPUTER_LIMITS.textMax)
          return `text is from 1 to ${COMPUTER_LIMITS.textMax} characters`;
        out.push({ type: 'text', text: e.text });
        break;
      default:
        return 'an event of an unknown kind';
    }
  }
  return out;
}
