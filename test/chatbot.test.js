const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../src/index');
const { createMessageStore } = require('../src/storage');

function webhook(idMessage, chatId, text, typeMessage = 'textMessage') {
  return {
    typeWebhook: 'incomingMessageReceived',
    instanceData: { idInstance: 1101111111, wid: '79999999999@c.us', typeInstance: 'whatsapp' },
    timestamp: 1588091580,
    idMessage,
    senderData: { chatId, sender: chatId, chatName: 'Citizen', senderName: 'Citizen' },
    messageData: typeMessage === 'textMessage'
      ? { typeMessage, textMessageData: { textMessage: text } }
      : { typeMessage, fileMessageData: { mimeType: 'image/jpeg' } },
  };
}

function request(server, method, route, body, raw = false) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: route, method,
      headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body ? (raw ? body : JSON.stringify(body)) : undefined);
  });
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('background reply did not finish');
}

test('health, persistence, deduplication, conversation memory, and non-text handling', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'messages.json');
  const store = createMessageStore(filePath);
  const groqRequests = [];
  const greenRequests = [];
  const fetchImpl = async (url, options) => {
    if (url.includes('api.groq.com')) {
      const body = JSON.parse(options.body);
      groqRequests.push(body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Which village?' } }] }) };
    }
    greenRequests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ idMessage: `sent-${greenRequests.length}` }) };
  };
  const server = createServer({ store, fetchImpl, logger: { log() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const health = await request(server, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.equal((await request(server, 'POST', '/webhook/green-api', '{', true)).status, 400);
  assert.equal((await request(server, 'GET', '/health')).status, 200);

  const first = webhook('in-1', '919111111111@c.us', 'There is no water supply.');
  assert.equal((await request(server, 'POST', '/webhook/green-api', first)).status, 200);
  await waitFor(() => greenRequests.length === 1 && store.getRecentMessages(first.senderData.chatId, 20).length === 2);
  assert.equal(greenRequests[0].chatId, first.senderData.chatId);
  assert.equal(store.getRecentMessages(first.senderData.chatId, 20)[0].messageId, 'in-1');
  assert.equal(store.getRecentMessages(first.senderData.chatId, 20)[1].direction, 'outgoing');

  assert.equal((await request(server, 'POST', '/webhook/green-api', first)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(groqRequests.length, 1);
  assert.equal(greenRequests.length, 1);
  assert.equal(createMessageStore(filePath).saveMessage({ messageId: 'in-1', chatId: first.senderData.chatId,
    messageText: 'duplicate', direction: 'incoming' }), false);

  assert.equal((await request(server, 'POST', '/webhook/green-api', webhook('in-2', first.senderData.chatId, 'Three days.'))).status, 200);
  await waitFor(() => groqRequests.length === 2);
  assert.deepEqual(groqRequests[1].messages.slice(1).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'There is no water supply.' },
    { role: 'assistant', content: 'Which village?' },
    { role: 'user', content: 'Three days.' },
  ]);

  assert.equal((await request(server, 'POST', '/webhook/green-api', webhook('in-3', '919222222222@c.us', 'Hello'))).status, 200);
  await waitFor(() => groqRequests.length === 3);
  assert.deepEqual(groqRequests[2].messages.slice(1).map(({ content }) => content), ['Hello']);

  assert.equal((await request(server, 'POST', '/webhook/green-api', webhook('image-1', first.senderData.chatId, '', 'imageMessage'))).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(groqRequests.length, 3);
  assert.equal((await request(server, 'POST', '/webhook/green-api', { typeWebhook: 'incomingMessageReceived' })).status, 200);
  assert.equal((await request(server, 'POST', '/webhook/green-api', { ...first, idMessage: '' })).status, 200);
});

test('Groq failure sends one fallback and preserves incoming message', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMessageStore(path.join(dir, 'messages.json'));
  const sent = [];
  const server = createServer({ store, logger: { log() {}, error() {} }, fetchImpl: async (url, options) => {
    if (url.includes('api.groq.com')) return { ok: false, status: 401 };
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ idMessage: 'fallback-id' }) };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await request(server, 'POST', '/webhook/green-api', webhook('fail-1', '919111111111@c.us', 'Hello'))).status, 200);
  await waitFor(() => sent.length === 1 && store.getRecentMessages('919111111111@c.us', 20).length === 2);
  assert.match(sent[0].message, /trouble processing/i);
  assert.equal(store.getRecentMessages('919111111111@c.us', 20)[0].direction, 'incoming');
});

test('rapid messages in one chat include the prior bot reply', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMessageStore(path.join(dir, 'messages.json'));
  const groqRequests = [];
  let releaseFirstSend;
  const firstSend = new Promise((resolve) => { releaseFirstSend = resolve; });
  const server = createServer({ store, logger: { log() {}, error() {} }, fetchImpl: async (url, options) => {
    if (url.includes('api.groq.com')) {
      groqRequests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Which village?' } }] }) };
    }
    if (groqRequests.length === 1) await firstSend;
    return { ok: true, json: async () => ({ idMessage: 'sent-' + groqRequests.length }) };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await request(server, 'POST', '/webhook/green-api', webhook('quick-1', '919111111111@c.us', 'No water.'));
  await request(server, 'POST', '/webhook/green-api', webhook('quick-2', '919111111111@c.us', 'For three days.'));
  releaseFirstSend();
  await waitFor(() => groqRequests.length === 2);
  assert.deepEqual(groqRequests[1].messages.slice(1).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'No water.' },
    { role: 'assistant', content: 'Which village?' },
    { role: 'user', content: 'For three days.' },
  ]);
});

test('GREEN-API send failure leaves the incoming message stored without a false outgoing record', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMessageStore(path.join(dir, 'messages.json'));
  let sendAttempts = 0;
  const errors = [];
  const server = createServer({ store, logger: { log() {}, error: (message) => errors.push(message) },
    fetchImpl: async (url) => {
      if (url.includes('api.groq.com')) return { ok: true,
        json: async () => ({ choices: [{ message: { content: 'Which village?' } }] }) };
      sendAttempts += 1;
      return { ok: false, status: 401 };
    } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await request(server, 'POST', '/webhook/green-api', webhook('send-fail', '919111111111@c.us', 'No water.'))).status, 200);
  await waitFor(() => errors.length === 1);
  assert.equal(sendAttempts, 1);
  assert.deepEqual(store.getRecentMessages('919111111111@c.us').map((item) => item.direction), ['incoming']);
  assert.match(errors[0], /401/);
});
