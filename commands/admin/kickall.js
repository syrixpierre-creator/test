import { getGroupMetadata, isSenderAdmin, isBotAdmin, replyText } from '../../lib/groupHelper.js';

export default {
  name: 'kickall',
  description: "⚠️ DANGEROUS: removes every non-admin member from the group in ONE single shot (admin only). Requires typing the confirm word so it can't fire by accident. Usage: .kickall confirm",
  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId.endsWith('@g.us')) return replyText(sock, msg, '❌ This command only works in groups.');
    const sender = msg.key.participant || msg.key.remoteJid;
    if (!(await isSenderAdmin(sock, chatId, sender))) return replyText(sock, msg, '❌ Only group admins can use this command.');
    if (!(await isBotAdmin(sock, chatId))) return replyText(sock, msg, '❌ I need to be an admin to do that.');
    if ((args[0] || '').toLowerCase() !== 'confirm') {
      return replyText(sock, msg, "⚠️ This removes EVERY non-admin member from the group in ONE shot (single request, no pauses). This cannot be undone, and WhatsApp may flag the bot's number for a burst removal this size.\nFor a slower, safer removal instead, use `.kickall2 confirm`.\nType `.kickall confirm` if you're sure.");
    }

    const metadata = await getGroupMetadata(sock, chatId);
    if (!metadata) return replyText(sock, msg, '❌ Could not load group info.');

    const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const targets = metadata.participants
      .filter((p) => p.admin !== 'admin' && p.admin !== 'superadmin')
      .map((p) => p.id)
      .filter((id) => id.split('@')[0] !== botJid.split('@')[0]);

    if (!targets.length) return replyText(sock, msg, 'ℹ️ No non-admin members to remove.');

    await replyText(sock, msg, `🚨 Removing ${targets.length} member(s) in one shot...`);
    try {
      await sock.groupParticipantsUpdate(chatId, targets, 'remove');
      await replyText(sock, msg, `✅ Removed ${targets.length} member(s).`);
    } catch (err) {
      await replyText(sock, msg, `❌ The one-shot removal failed (${err.message || err}). Try \`.kickall2 confirm\` to remove them one by one instead.`);
    }
  }
};
