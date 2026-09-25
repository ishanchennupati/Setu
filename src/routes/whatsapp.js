function parseGreenApiWebhook(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const messageType = body.messageData?.typeMessage;
  return {
    typeWebhook: body.typeWebhook,
    messageId: body.idMessage,
    chatId: body.senderData?.chatId,
    sender: body.senderData?.sender || body.senderData?.chatId,
    senderName: body.senderData?.senderName || body.senderData?.chatName || null,
    messageText: messageType === 'textMessage' ? body.messageData?.textMessageData?.textMessage : undefined,
    messageType,
    timestamp: body.timestamp,
  };
}

module.exports = { parseGreenApiWebhook };
