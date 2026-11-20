/** Public desktop app registrations supplied by the distributor. Never put a confidential web app secret here. */
declare const __RELAY_APP_CLIENTS__: { microsoftId?: string; googleId?: string; googleDesktopSecret?: string; slackId?: string };
export const appClients =
  typeof __RELAY_APP_CLIENTS__ === 'undefined'
    ? {
        microsoftId: process.env.RELAY_MICROSOFT_CLIENT_ID?.trim(),
        googleId: process.env.RELAY_GOOGLE_CLIENT_ID?.trim(),
        googleDesktopSecret: process.env.RELAY_GOOGLE_DESKTOP_SECRET?.trim(),
        slackId: process.env.RELAY_SLACK_CLIENT_ID?.trim(),
      }
    : __RELAY_APP_CLIENTS__;
