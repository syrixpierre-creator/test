// Interactive message with a native "copy" button (cta_copy) — one tap copies
// the pairing code. Sent with relayMessage because sendMessage has no
// high-level option for native-flow buttons. Callers should catch errors and
// fall back to plain text: some WhatsApp clients/accounts don't render these.
export async function sendCopyCodeMessage(sock, chatId, quoted, { body, footer = '', title = '', buttonText = '📋 Copy code', code }, baileys) {
  const { generateWAMessageFromContent } = baileys || await import('@whiskeysockets/baileys');
  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: {
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          header: { title, hasMediaAttachment: false },
          nativeFlowMessage: {
            buttons: [{
              name: 'cta_copy',
              buttonParamsJson: JSON.stringify({ display_text: buttonText, id: 'copy_code', copy_code: String(code) })
            }]
          }
        }
      }
    }
  };
  const waMsg = generateWAMessageFromContent(chatId, content, { quoted, userJid: sock.user?.id });
  await sock.relayMessage(chatId, waMsg.message, { messageId: waMsg.key.id });
}
