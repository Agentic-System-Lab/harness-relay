// Google OAuth and Docs for the document-confirmation browser test. Every Google host stays offline.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const originalFetch = globalThis.fetch;
const authFile = () => join(process.env.RELAY_DATA_DIR, 'google-docs-consent.json');
const docFile = () => join(process.env.RELAY_DATA_DIR, 'google-docs-state.json');
const scope = 'https://www.googleapis.com/auth/documents';
const tabId = 't.decision';
const accessToken = 'fixture-docs-access';
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, data) => writeFileSync(file, JSON.stringify(data));
const error = (status, message) => Response.json({ error: { message } }, { status });

async function tokens(request) {
  const form = new URLSearchParams(await request.text());
  const grant = read(authFile());
  if (form.get('client_id') !== 'fixture.apps.googleusercontent.com' || form.get('client_secret') !== 'fake') {
    return Response.json({ error: 'invalid_client' }, { status: 401 });
  }
  if (form.get('grant_type') === 'authorization_code') {
    const challenge = createHash('sha256')
      .update(form.get('code_verifier') || '')
      .digest('base64url');
    if (
      grant.used ||
      grant.challenge !== challenge ||
      form.get('code') !== 'fixture-docs-code' ||
      form.get('redirect_uri') !== grant.redirect
    ) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    save(authFile(), { ...grant, used: true });
  } else if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'fixture-docs-refresh' || !grant.used) {
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  }
  return Response.json({
    access_token: accessToken,
    refresh_token: 'fixture-docs-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'openid email profile ' + scope,
  });
}

function documentView(state) {
  let startIndex = 1;
  const content = state.content.split('\n').map((line) => {
    const text = line + '\n';
    const endIndex = startIndex + text.length;
    const element = { startIndex, endIndex, textRun: { content: text } };
    const paragraph = { startIndex, endIndex, paragraph: { elements: [element] } };
    startIndex = endIndex;
    return paragraph;
  });
  return {
    documentId: state.id,
    title: state.title,
    revisionId: 'rev-' + state.revision,
    tabs: [{ tabProperties: { tabId, title: 'Decision' }, documentTab: { body: { content } } }],
  };
}

function update(state, body) {
  if (body.writeControl?.requiredRevisionId !== 'rev-' + state.revision) return error(400, 'Document revision changed');
  let text = state.content;
  for (const edit of body.requests) {
    if (edit.deleteContentRange) {
      const range = edit.deleteContentRange.range;
      if (range.tabId !== tabId || range.startIndex < 1 || range.endIndex <= range.startIndex || range.endIndex > text.length + 1) {
        return error(400, 'Invalid delete range');
      }
      text = text.slice(0, range.startIndex - 1) + text.slice(range.endIndex - 1);
    } else if (edit.insertText) {
      const { location, text: inserted } = edit.insertText;
      if (location.tabId !== tabId || location.index < 1 || location.index > text.length + 1) return error(400, 'Invalid insertion');
      text = text.slice(0, location.index - 1) + inserted + text.slice(location.index - 1);
    } else {
      return error(400, 'Unknown fixture operation');
    }
  }
  state = { ...state, content: text, revision: state.revision + 1, updates: state.updates + 1 };
  save(docFile(), state);
  return Response.json({
    documentId: state.id,
    replies: body.requests.map(() => ({})),
    writeControl: { requiredRevisionId: 'rev-' + state.revision },
  });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!/(^|\.)(googleapis\.com|googleusercontent\.com|google\.com)$/.test(url.hostname)) return originalFetch(input, init);
  const request = new Request(input, init);
  if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token' && request.method === 'POST') return tokens(request);
  if (request.headers.get('authorization') !== 'Bearer ' + accessToken) return error(401, 'Unknown fixture token');
  if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo')
    return Response.json({ sub: 'docs-test-user', email: 'editor@example.test', name: 'Test Editor' });
  if (url.origin !== 'https://docs.googleapis.com') return error(403, 'Only the Docs API is authorized in this test');
  const state = existsSync(docFile()) ? read(docFile()) : null;
  if (url.pathname === '/v1/documents' && request.method === 'POST') {
    const { title } = await request.json();
    const creates = (state?.creates || 0) + 1;
    const next = { id: 'relay-doc-' + creates, title, content: '', revision: 1, creates, updates: 0 };
    save(docFile(), next);
    return Response.json({ documentId: next.id, title, revisionId: 'rev-1' });
  }
  if (
    state &&
    url.pathname === '/v1/documents/' + state.id &&
    request.method === 'GET' &&
    url.searchParams.get('includeTabsContent') === 'true'
  ) {
    return Response.json(documentView(state));
  }
  if (state && url.pathname === '/v1/documents/' + state.id + ':batchUpdate' && request.method === 'POST')
    return update(state, await request.json());
  return error(404, 'Unknown Google Docs fixture request');
};
