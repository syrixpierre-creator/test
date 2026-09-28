// .pair — asks the multi-session host (project root, sessions.js) for a
// pairing code straight from WhatsApp, no website link needed. With no
// number it uses the sender's own. Same engine as .linkme.
import linkme from '../user/linkme.js';

export default {
  name: 'pair',
  alias: ['pairing', 'getcode'],
  description: 'Get a pairing code for your number, right here in the chat. Usage: .pair [number with country code]',
  async execute(sock, msg, args, currentPrefix, ctx) {
    const chatId = msg.key.remoteJid;
    if (!ctx.IS_MANAGED_SESSION) {
      return sock.sendMessage(chatId, { text: '🔗 *Pair Your WhatsApp*\n\nhttps://akumagen2.vercel.app' }, { quoted: msg });
    }
    if (!args[0]) {
      const jid = msg.key.participant || chatId;
      if (jid.endsWith('@s.whatsapp.net')) args = [jid.split('@')[0].split(':')[0]];
    }
    return linkme.execute(sock, msg, args, currentPrefix, ctx);
  }
};
