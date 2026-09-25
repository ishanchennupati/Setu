const fs = require('node:fs');
const path = require('node:path');

function createMessageStore(filePath) {
  function readMessages() {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(value)) throw new Error('Invalid message store');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function saveMessage(message) {
    const messages = readMessages();
    if (message.direction === 'incoming' && messages.some((item) =>
      item.direction === 'incoming' && item.messageId === message.messageId)) return false;
    const next = [...messages, { ...message, createdAt: new Date().toISOString() }];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: 'w' });
      fs.renameSync(temp, filePath);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return true;
  }

  function getRecentMessages(chatId, limit = 20, beforeMessageId) {
    const messages = readMessages();
    const boundary = beforeMessageId
      ? messages.findIndex((item) => item.direction === 'incoming' && item.messageId === beforeMessageId)
      : messages.length;
    return messages.filter((item, index) => item.chatId === chatId &&
      (item.direction === 'outgoing' || index < boundary)).slice(-limit);
  }

  return { saveMessage, getRecentMessages };
}

module.exports = { createMessageStore };
