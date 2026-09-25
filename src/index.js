const http = require('node:http');
const path = require('node:path');
const { createMessageStore } = require('./storage');
const { parseGreenApiWebhook } = require('./routes/whatsapp');
const { getAIResponse } = require('./services/groq');
const { sendMessage } = require('./services/greenapi');

const FALLBACK = "Sorry, I'm having trouble processing your message right now. Please try again.";

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function createServer({ store = createMessageStore(path.join(__dirname, '..', 'data', 'messages.json')),
  fetchImpl = fetch, logger = console } = {}) {
  const chatQueues = new Map();

  async function processMessage(message) {
    let responseText;
    try {
      logger.log(`[GROQ] status: processing chatId: ${message.chatId}`);
      responseText = await getAIResponse(message.chatId, message.messageText, store,
        { beforeMessageId: message.messageId, fetchImpl });
      logger.log(`[GROQ] status: success chatId: ${message.chatId}`);
    } catch (error) {
      logger.error(`[GROQ] status: failed type: ${error.name} code: ${error.status || error.code || 'unknown'}`);
      responseText = FALLBACK;
    }

    try {
      const result = await sendMessage(message.chatId, responseText, { fetchImpl });
      store.saveMessage({ messageId: result.idMessage || null, chatId: message.chatId,
        sender: 'bot', senderName: 'Setu', messageText: responseText,
        messageType: 'textMessage', direction: 'outgoing', timestamp: Math.floor(Date.now() / 1000) });
      logger.log(`[OUTGOING] chatId: ${message.chatId} messageId: ${result.idMessage}`);
    } catch (error) {
      logger.error(`[GREEN-API] send failed type: ${error.name} code: ${error.status || error.code || 'unknown'}`);
    }
  }

  function queueMessage(message) {
    const previous = chatQueues.get(message.chatId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => processMessage(message));
    chatQueues.set(message.chatId, current);
    const clearQueue = () => {
      if (chatQueues.get(message.chatId) === current) chatQueues.delete(message.chatId);
    };
    current.then(clearQueue, (error) => {
      logger.error(`[WEBHOOK] processing failed type: ${error.name} code: ${error.code || 'unknown'}`);
      clearQueue();
    });
  }

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/webhook/green-api') return reply(res, 404, { error: 'Not found' });

    let body = '';
    let bodyBytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > 1024 * 1024) tooLarge = true;
      else body += chunk;
    });
    req.on('error', () => { if (!res.writableEnded) reply(res, 400, { error: 'Invalid request' }); });
    req.on('end', () => {
      if (tooLarge) return reply(res, 413, { error: 'Request too large' });
      let event;
      try { event = JSON.parse(body); }
      catch { return reply(res, 400, { error: 'Invalid JSON' }); }
      const parsed = parseGreenApiWebhook(event);
      logger.log(`[WEBHOOK] type: ${parsed.typeWebhook || 'unknown'}`);
      if (parsed.typeWebhook !== 'incomingMessageReceived') return reply(res, 200, { status: 'ignored' });
      if (parsed.messageType !== 'textMessage') {
        logger.log(`[WEBHOOK] unsupported message type: ${parsed.messageType || 'unknown'}`);
        return reply(res, 200, { status: 'ignored' });
      }
      if (typeof parsed.messageId !== 'string' || !parsed.messageId ||
        typeof parsed.chatId !== 'string' || !parsed.chatId ||
        typeof parsed.messageText !== 'string' || !parsed.messageText.trim()) {
        logger.log('[WEBHOOK] missing required message fields');
        return reply(res, 200, { status: 'ignored' });
      }
      try {
        if (!store.saveMessage({ ...parsed, direction: 'incoming' })) {
          logger.log(`[WEBHOOK] duplicate messageId: ${parsed.messageId}`);
          return reply(res, 200, { status: 'duplicate' });
        }
      } catch (error) {
        logger.error(`[STORAGE] save failed code: ${error.code || 'unknown'}`);
        return reply(res, 500, { error: 'Unable to store message' });
      }
      logger.log(`[INCOMING] chatId: ${parsed.chatId} messageId: ${parsed.messageId}`);
      reply(res, 200, { status: 'accepted' });
      setImmediate(() => queueMessage(parsed));
    });
  });
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log(`Setu WhatsApp chatbot listening on port ${port}`));
}

module.exports = { createServer };
