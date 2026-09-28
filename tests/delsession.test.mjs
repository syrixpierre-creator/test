import test from 'node:test';
import assert from 'node:assert/strict';
import cmd from '../commands/owner/delsession.js';

let n = 0;
function setup() {
  const id = `55${++n}`; // unique per test: the pending-confirmation map is module state
  const sent = [], calls = [];
  const sock = { sendMessage: async (_c, content) => { sent.push(content.text); } };
  const ctx = { SESSION_LABEL: id, IS_MANAGED_SESSION: true, requestOrchestrator: async (t, p) => { calls.push([t, p]); return { ok: true, removed: p.sessionId }; } };
  const msg = { key: { remoteJid: `${id}@s.whatsapp.net` } };
  return { id, sent, calls, sock, ctx, msg };
}

test('.delsession asks for confirmation first and deletes nothing', async () => {
  const { id, sent, calls, sock, ctx, msg } = setup();
  await cmd.execute(sock, msg, [], '.', ctx);
  assert.equal(calls.length, 0);
  assert.match(sent[0], new RegExp(`Delete session "${id}"`));
  assert.match(sent[0], /\.delsession confirm/);
});

test('.delsession confirm only works after the prompt, then deletes once', async () => {
  const { id, sent, calls, sock, ctx, msg } = setup();
  await cmd.execute(sock, msg, ['confirm'], '.', ctx); // no prompt yet
  assert.equal(calls.length, 0);
  assert.match(sent[0], /Nothing to confirm/);
  await cmd.execute(sock, msg, [], '.', ctx);
  await cmd.execute(sock, msg, ['confirm'], '.', ctx);
  assert.deepEqual(calls, [['delsession', { sessionId: id }]]);
  await cmd.execute(sock, msg, ['confirm'], '.', ctx); // already used
  assert.equal(calls.length, 1);
});

test('.delsession refuses the main session', async () => {
  const { sent, calls, sock, ctx, msg } = setup();
  ctx.SESSION_LABEL = 'default';
  await cmd.execute(sock, msg, [], '.', ctx);
  assert.equal(calls.length, 0);
  assert.match(sent[0], /Usage/);
});
