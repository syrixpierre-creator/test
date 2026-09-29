import { getGroupMetadata, isSenderAdmin, isBotAdmin, replyText } from '../../lib/groupHelper.js';

export default {
  name: 'kickall2',
  description: '⚠️ DANGEROUS: removes every non-admin member from the group ONE AT A TIME, with a short pause between each (safer/slower than .kickall). Usage: .kickall2 confirm',
  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId.endsWith('@g.us')) return replyText(sock, msg, '❌ This command only works in groups.');
    const sender = msg.key.participant || msg.key.remoteJid;
    if (!(await isSenderAdmin(sock, chatId, sender))) return replyText(sock, msg, '❌ Only group admins can use this command.');
    if (!(await isBotAdmin(sock, chatId))) return replyText(sock, msg, '❌ I need to be an admin to do that.');
    if ((args[0] || '').toLowerCase() !== 'confirm') {
      return replyText(sock, msg, "⚠️ This removes EVERY non-admin member from the group ONE BY ONE (slower, but gentler on WhatsApp's rate limits than `.kickall`). This cannot be undone.\nType `.kickall2 confirm` if you're sure.");
    }

    const metadata = await getGroupMetadata(sock, chatId);
    if (!metadata) return replyText(sock, msg, '❌ Could not load group info.');

    const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const targets = metadata.participants
      .filter((p) => p.admin !== 'admin' && p.admin !== 'superadmin')
      .map((p) => p.id)
      .filter((id) => id.split('@')[0] !== botJid.split('@')[0]);

    if (!targets.length) return replyText(sock, msg, 'ℹ️ No non-admin members to remove.');

    await replyText(sock, msg, `🚨 Removing ${targets.length} member(s) one by one... this will take a while.`);
    let removed = 0;
    const DELAY_MS = 1500; // one member per request — the whole point of this command vs .kickall
    for (const jid of targets) {
      try {
        await sock.groupParticipantsUpdate(chatId, [jid], 'remove');
        removed++;
      } catch {}
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    await replyText(sock, msg, `✅ Removed ${removed}/${targets.length} member(s).`);
  }
};
