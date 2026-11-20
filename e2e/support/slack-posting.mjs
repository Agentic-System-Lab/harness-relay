// Test process preload. Only Slack's fixed Web API host is intercepted; it is never contacted.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== 'slack.com') return original(input, init);
  if (init?.headers?.Authorization !== 'Bearer xoxb-fixture-for-relay') return Response.json({ ok: false, error: 'invalid_auth' });
  switch (url.pathname) {
    case '/api/auth.test':
      return Response.json(
        { ok: true, team_id: 'TRELAY', user_id: 'URELAY', team: 'Demo workspace', user: 'Demo bot', url: 'https://relay-demo.slack.com/' },
        { headers: { 'x-oauth-scopes': 'chat:write,channels:read' } },
      );
    case '/api/conversations.info':
      return Response.json({ ok: true, channel: { id: 'CPLANS', name: 'planning' } });
    case '/api/chat.postMessage': {
      const payload = JSON.parse(init.body);
      appendFileSync(join(process.env.RELAY_DATA_DIR, 'slack-posts.jsonl'), JSON.stringify(payload) + '\n');
      return Response.json({ ok: true, channel: payload.channel, ts: '100.1' });
    }
    default:
      throw new Error('Unexpected Slack method in the offline test');
  }
};
