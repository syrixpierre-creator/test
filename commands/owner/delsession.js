// .delsession — permanent removal of a linked session, with a confirmation
// step so a stray message can't wipe credentials.
const CONFIRM_WINDOW_MS = 60 * 1000;
const CONFIRM_WORDS = new Set(['confirm', 'yes', 'oui', 'y']);
const pending = new Map(); // "sender|target" -> expiry timestamp

export default {
  name: 'delsession',
  alias: ['deletesession', 'removesession'],
  ownerOnly: true,
  strictOwner: true,
  description: 'Permanently delete a linked session (credentials included), after confirmation. Usage: .delsession [id] then .delsession [id] confirm',
  async execute(sock, msg, args, currentPrefix, ctx) {
    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || chatId;
    const list = args.map((a) => String(a).trim()).filter(Boolean);
    const confirming = list.length > 0 && CONFIRM_WORDS.has(list[list.length - 1].toLowerCase());
    const idArg = confirming ? list.slice(0, -1)[0] : list[0];
    // No id = delete the session this chat is talking to (your own bot).
    const sessionId = (idArg || '').trim() || ctx.SESSION_LABEL;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

    if (!sessionId || sessionId === 'default') {
      return say(`❌ Usage: ${currentPrefix}delsession [id]\nSee ${currentPrefix}sessions for the list of ids.`);
    }
    if (!ctx.IS_MANAGED_SESSION) {
      return say('❌ This bot is not running under the multi-session orchestrator (`node sessions.js`).');
    }

    const key = `${sender}|${sessionId}`;
    const now = Date.now();
    for (const [k, exp] of pending) if (exp <= now) pending.delete(k);

    if (!confirming) {
      pending.set(key, now + CONFIRM_WINDOW_MS);
      const cmd = `${currentPrefix}delsession${idArg ? ` ${sessionId}` : ''} confirm`;
      return say(
        `⚠️ *Delete session "${sessionId}"?*\n\n` +
        `This stops the bot and permanently erases its credentials and settings. ` +
        `You will need a new pairing code to link it again.\n\n` +
        `To confirm within 60 seconds, send:\n*${cmd}*\n\nIgnore this message to cancel.`
      );
    }

    if (!pending.has(key)) {
      return say(`❌ Nothing to confirm (or it expired). Send *${currentPrefix}delsession${idArg ? ` ${sessionId}` : ''}* first.`);
    }
    pending.delete(key);

    const result = await ctx.requestOrchestrator('delsession', { sessionId });
    if (!result.ok) return say(`❌ ${result.error || 'Could not remove that session.'}`);
    await say(`✅ Session "${result.removed}" stopped and removed (credentials deleted). Send ${currentPrefix}pair <number> from another linked number, or use https://akumagen2.vercel.app, to link again.`);
  }
};
