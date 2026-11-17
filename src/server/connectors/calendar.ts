import type { CalendarAccountView } from '../../shared/types';
import type { AuthorizedFetch } from '../oauth/providers';
import { composeEvent, listEvents, putEvent, type CalDavAuth, type CalendarEvent, type NewEvent } from './caldav';
import { graphAddEvent, graphEvents } from './graph';

/*
 * A calendar of the calendar tools, however it is reached: CalDAV with its password, CalDAV with an
 * OAuth account's token (Google), or Microsoft Graph with one (Microsoft 365, Outlook.com). The tools
 * list events and add one the same way whichever it is, and agents see no difference.
 */

export interface CalendarBackend {
  /**
   * The events between two moments. `expand`: each time of a recurring event on its own (Graph always
   * does; a CalDAV server when it can), for an automation that starts before each.
   */
  events(from: number, to: number, expand?: boolean): Promise<CalendarEvent[]>;
  /** Adds the event; with attendees, the calendar's server invites them. */
  add(e: NewEvent): Promise<void>;
}

/** How the calendars of accounts that sign in with OAuth are reached (`OAuthService`). */
export interface CalendarOAuth {
  /** Its provider's API for calendars, and a fetch with the account's token (only to its hosts). */
  via(oauthAccount: string): { api: 'graph' | 'caldav'; fetch: AuthorizedFetch };
  /** Why the account cannot be used now (it needs signing in again, or is gone); undefined when it can. */
  problem(oauthAccount: string): string | undefined;
}

function caldav(url: string, auth: CalDavAuth): CalendarBackend {
  return {
    events: (from, to, expand) => listEvents(url, auth, from, to, undefined, expand),
    add: async (e) => {
      const { uid, ics } = composeEvent(e);
      await putEvent(url, auth, ics, uid);
    },
  };
}

/** The calendar as the tools use it: with its password, or through the account that signs in with OAuth it belongs to. */
export function calendarBackend(account: Omit<CalendarAccountView, 'password'>, password: string, oauth?: CalendarOAuth): CalendarBackend {
  if (!account.oauth) return caldav(account.url, { username: account.username, password });
  if (!oauth) throw new Error(`The calendar "${account.name}" signs in with OAuth, which is not set up here`);
  const problem = oauth.problem(account.oauth);
  if (problem) throw new Error(problem);
  const { api, fetch } = oauth.via(account.oauth);
  if (api === 'caldav') return caldav(account.url, { fetch });
  return { events: (from, to) => graphEvents(fetch, account.url, from, to), add: (e) => graphAddEvent(fetch, account.url, e) };
}
