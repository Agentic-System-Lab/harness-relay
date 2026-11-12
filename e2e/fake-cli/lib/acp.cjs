'use strict';
/*
 * What the fakes that speak ACP (the Agent Client Protocol: JSON-RPC 2.0 on stdio) share: the agent's
 * end of the connection, the session updates that show a reply's steps, and asking the client for
 * permission. Each CLI's module plays its turns with these, in its own CLI's words: its tools' names
 * and shapes, what it asks about, and what it makes of an answer.
 */
const { pieceDelay, pieces } = require('./plan.cjs');
const { rpcError, rpcPeer } = require('./rpc.cjs');
const { sleep } = require('./self.cjs');

/**
 * An ACP agent on stdio. `methods` answer the client's requests by name (`initialize`,
 * `session/new`, `session/prompt`, …), each given the request's params and the agent; a request it
 * has no method for is refused as unknown (-32601). A `session/cancel` notification marks that
 * session `cancelled`; `onNotification` gets the other notifications. `sessions`: the sessions it has
 * open, by id, which the methods keep; `peer`: the connection, to notify and ask the client.
 */
function acpAgent(methods, onNotification = () => {}) {
  const agent = { sessions: new Map(), peer: undefined };
  agent.peer = rpcPeer(
    true,
    async (method, p) => {
      if (!Object.prototype.hasOwnProperty.call(methods, method)) throw rpcError(`unknown method ${method}`, -32601);
      return methods[method](p, agent);
    },
    (method, p) => {
      if (method === 'session/cancel' && agent.sessions.has(p.sessionId)) agent.sessions.get(p.sessionId).cancelled = true;
      else onNotification(method, p, agent);
    },
  );
  return agent;
}

/**
 * The updates of one session (`session/update` notifications) that show a reply's steps: thinking
 * and text streamed in pieces, a to-do list, a tool call and its end. `cancelled()`: whether the
 * session was cancelled, which stops a message on its way.
 */
function sessionUpdates(peer, sessionId, cancelled = () => false) {
  const update = (u) => peer.notify('session/update', { sessionId, update: u });
  return {
    update,
    /** Thinking, streamed in pieces. */
    async thought(text) {
      for (const piece of pieces(text)) {
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: piece } });
        await sleep(pieceDelay());
      }
    },
    /** A to-do list (a `todo` step's entries). */
    plan(entries) {
      update({ sessionUpdate: 'plan', entries: entries.map((e) => ({ content: e.text, status: e.status, priority: 'medium' })) });
    },
    /** A tool call's first update: `call` has its `toolCallId`, title, kind, status and what else the CLI shows. */
    toolCall(call) {
      update({ sessionUpdate: 'tool_call', ...call });
    },
    /** A tool call's end, done or failed, with a text as its content. */
    toolDone(toolCallId, ok, text) {
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text } }] });
    },
    /** Text, streamed in pieces (slowly for a slow reply). False when the session was cancelled on its way. */
    async message(text, slow) {
      for (const piece of pieces(text, slow)) {
        if (cancelled()) return false;
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
        await sleep(pieceDelay(slow));
      }
      return true;
    },
  };
}

/**
 * Asks the client for permission to make `toolCall` (`session/request_permission`), offering
 * `options` (`{ optionId, name, kind }`). The client's answer; a request that fails counts as cancelled.
 */
function requestPermission(peer, sessionId, toolCall, options) {
  return peer.request('session/request_permission', { sessionId, toolCall, options }).catch(() => ({ outcome: { outcome: 'cancelled' } }));
}

/** Whether a permission answer picked the option `optionId`. */
const picked = (answer, optionId) => Boolean(answer && answer.outcome && answer.outcome.outcome === 'selected' && answer.outcome.optionId === optionId);

/** The message a permission answer carries (`_meta.followup_message`: Harness Relay's note with a refusal), or ''. */
const followup = (answer) => (answer && answer._meta && answer._meta.followup_message) || '';

module.exports = { acpAgent, sessionUpdates, requestPermission, picked, followup };
