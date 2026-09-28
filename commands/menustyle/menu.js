import { safeErrorMessage } from '../../lib/utils/errors.js';
// Text-only, compact, permission-aware main menu.
//   .menu                → menu for who you are (owner / admin / group / user)
//   .menu <view>         → public | private | group | owner | admin | user (never above your rights)
//   .menu <category>     → drill-down, e.g. .menu ai   .menu download 2
//   .menu list           → category index only
import { config } from '../../config/index.js';
import { isSenderAdmin, getGroupMetadata } from '../../lib/groupHelper.js';
import { planMenu, buildMainMenu, buildIndex, buildCategory, resolveCategory } from '../../lib/menu/index.js';
import { SCOPE_NAMES } from '../../lib/menu/scopes.js';
import { getMenuImage } from '../../lib/menuImage.js';
import { reply } from '../../lib/helpers/reply.js';
import { logger } from '../../lib/utils/logger.js';

export default {
  name: 'menu',
  alias: ['help', 'commands'],
  description: 'Show the command menu. Usage: .menu [view|category|list]',
  async execute(sock, msg, args, prefix, ctx) {
    const chatId = msg.key.remoteJid;
    const senderJid = msg.key.participant || chatId;
    const inGroup = chatId.endsWith('@g.us');
    const isOwner = !!ctx.isOwner?.();
    const isOwnerOrSudo = !!ctx.isOwnerOrSudo?.();
    const isAdmin = inGroup && !isOwnerOrSudo ? await isSenderAdmin(sock, chatId, senderJid).catch(() => false) : false;

    try {
      const word = (args[0] || '').toLowerCase();
      const { scope: entitled } = planMenu(ctx, { requested: null, isOwner: isOwnerOrSudo, isAdmin, inGroup });
      let groupName;
      if (inGroup) groupName = (await getGroupMetadata(sock, chatId))?.subject;
      const mention = { mentions: [senderJid] };
      sock.sendPresenceUpdate('composing', chatId).catch(() => {});

      if (['list', 'short', 'index', 'categories'].includes(word)) {
        return await sock.sendMessage(chatId, { text: buildIndex(ctx, { scope: entitled, senderJid, isOwner }), ...mention }, { quoted: msg });
      }

      const category = resolveCategory(word);
      if (category) {
        const text = buildCategory(ctx, { category, page: args[1], scope: entitled, isOwner });
        return reply(sock, msg, text || `🔎 There are no *${word}* commands available to you here.\nSend ${prefix}menu list to see what you can use.`);
      }

      if (word && !SCOPE_NAMES.includes(word) && word !== 'all') {
        return reply(sock, msg, `❓ Unknown menu "${word.slice(0, 20)}".\nTry ${prefix}menu list, ${prefix}menu <category>, or one of: ${SCOPE_NAMES.join(', ')}.`);
      }

      const { scope } = planMenu(ctx, { requested: word === 'all' ? 'owner' : word, isOwner: isOwnerOrSudo, isAdmin, inGroup });
      const { text, header } = buildMainMenu(ctx, { scope, senderJid, groupName, groupJid: inGroup ? chatId : null, isOwner });

      // Image ON by default (only an explicit `.setmenuimage off` disables
      // it); the whole menu is the caption so it reads as one message.
      if (ctx.getGlobalSettings().menuImage !== false) {
        try {
          const image = await getMenuImage();
          if (image) {
            if (text.length <= 3800) {
              await sock.sendMessage(chatId, { image, caption: text, ...mention }, { quoted: msg });
              return;
            }
            await sock.sendMessage(chatId, { image, caption: header, ...mention }, { quoted: msg });
          }
        } catch (err) { logger.error('menu', `menu image not sent: ${safeErrorMessage(err)}`); }
      }
      await sock.sendMessage(chatId, { text, ...mention }, { quoted: msg });
    } finally {
      sock.sendPresenceUpdate('paused', chatId).catch(() => {});
    }
  }
};
