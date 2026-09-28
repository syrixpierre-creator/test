import test from 'node:test';
import assert from 'node:assert/strict';
import { sendCopyCodeMessage } from '../lib/helpers/copyButton.js';
import linkme from '../commands/user/linkme.js';

const fakeBaileys = { generateWAMessageFromContent: (jid, content, opts) => ({ key: { id: 'ID1' }, message: content, opts }) };

test('copy button message carries the code in a cta_copy button', async () => {
  const relayed = [];
  const sock = { user: { id: 'bot@s.whatsapp.net' }, relayMessage: async (...a) => relayed.push(a) };
  await sendCopyCodeMessage(sock, 'c@s.whatsapp.net', { key: {} }, { body: 'hi', code: 'ABCD-1234' }, fakeBaileys);
  const [jid, message, opts] = relayed[0];
  assert.equal(jid, 'c@s.whatsapp.net');
  assert.equal(opts.messageId, 'ID1');
  const btn = message.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons[0];
  assert.equal(btn.name, 'cta_copy');
  assert.equal(JSON.parse(btn.buttonParamsJson).copy_code, 'ABCD-1234');
});

test('.linkme falls back to plain text when the button cannot be sent', async () => {
  const sent = [];
  const sock = { sendMessage: async (_c, content) => sent.push(content.text), relayMessage: async () => { throw new Error('no buttons'); } };
  const ctx = { IS_MANAGED_SESSION: true, isOwner: () => true, requestOrchestrator: async () => ({ ok: true, phone: '15551234567', pairingCode: 'WXYZ-9876' }) };
  await linkme.execute(sock, { key: { remoteJid: 'c@s.whatsapp.net' } }, ['15551234567'], '.', ctx);
  assert.ok(sent.some((t) => t.includes('WXYZ-9876')), 'code still delivered as text');
});
