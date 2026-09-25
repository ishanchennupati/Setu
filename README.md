# Setu WhatsApp civic assistant

This backend receives incoming text messages through a GREEN-API webhook, stores each chat's messages locally, asks Groq for a short civic-issue response, and sends that response to the same WhatsApp `chatId` through GREEN-API. It does not register complaints.

## What you need

- Node.js 20.6 or newer (`node --version`). This project was tested with Node.js 24.14.1.
- An authorized GREEN-API WhatsApp instance and a Groq API key.
- The existing `.env` file in this project's root. It must contain `GREEN_API_URL`, `GREEN_API_INSTANCE_ID`, `GREEN_API_TOKEN`, and `GROQ_API_KEY`. `PORT` is optional and defaults to `3000`. `GROQ_MODEL` is optional and defaults to `openai/gpt-oss-120b`. `GREEN_API_Media_URL` is not used by this text chatbot.
- A public HTTPS tunnel for local testing, such as [ngrok](https://ngrok.com/download/windows). GREEN-API cannot call `localhost` on your computer.

Keep credentials in `.env` and never paste them into the GREEN-API webhook URL. No `npm install` is needed; this app uses Node.js built-ins.

## Run locally on Windows

Run commands from the project root, the folder containing `.env` and `package.json`.

### 1. Start the backend (PowerShell window 1)

Run **`node --env-file=.env src/index.js`**.

Leave this window open. It should print `Setu WhatsApp chatbot listening on port 3000` when `PORT=3000`.

In another PowerShell window, check local health with **`Invoke-RestMethod http://localhost:3000/health`**.

Expected result: `status: ok`. If you changed `PORT`, use that port in every command below.

### 2. Open a public tunnel (PowerShell window 2)

If ngrok is not installed, run **`winget install ngrok -s msstore`** following the [Windows instructions](https://ngrok.com/download/windows).

Open a new PowerShell window after installation. Sign in to ngrok, get your authtoken from its dashboard, and add it locally with **`ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN`**. Do not put that token in this project or share it in chat.

Start the tunnel with **`ngrok http 3000`** and leave this window open.

Copy the **HTTPS Forwarding** address shown by ngrok, such as `https://example.ngrok-free.app`. In a third PowerShell window, check public health with **`Invoke-RestMethod https://example.ngrok-free.app/health`**.

Replace the example domain with your actual ngrok domain. Expect `status: ok`.

### 3. Configure the GREEN-API instance

Open your authorized instance in the [GREEN-API console](https://console.green-api.com/) and edit its webhook settings:

1. Set **Webhook URL** to **`https://YOUR-NGROK-DOMAIN/webhook/green-api`**. Use your actual HTTPS Forwarding domain. The path must be exactly `/webhook/green-api` with no trailing slash.
2. Turn on **Receive webhooks on incoming messages and files** (`incomingWebhook`). This is the first switch in the webhook-options list. The other notification switches are not needed for this chatbot.
3. Leave **Webhook URL Token** empty for this version; the current server does not check that header.
4. Save the settings. Confirm the incoming-message switch remains on and the URL is saved.

See [GREEN-API's Webhook Endpoint instructions](https://green-api.com/en/docs/api/receiving/technology-webhook-endpoint/) for the console fields. When a temporary ngrok address changes, update the GREEN-API Webhook URL to the new address.

### 4. Send real WhatsApp messages (another phone/account)

Send messages **to the WhatsApp number connected to the GREEN-API instance**, from a different WhatsApp account. Watch PowerShell window 1 while testing.

1. Send `Hello`. Expect `[WEBHOOK]`, `[INCOMING]`, `[GROQ]`, and `[OUTGOING]` logs, followed by a reply in WhatsApp. The first accepted text should create `data/messages.json`.
2. Send `There is no water supply in my area.` and then `It has been happening for three days.` from the same account. The second reply should use the water-supply context.
3. Send a message from a second WhatsApp account. Its chat should have its own history.
4. Send an image. Expect an `unsupported message type: imageMessage` log and no AI reply for that image.

Inspect stored messages in PowerShell with **`Get-Content .\data\messages.json -Raw | ConvertFrom-Json | Select-Object chatId,direction,messageText`**.

Each successful text exchange should have an `incoming` and an `outgoing` record with the same `chatId`. The data file contains conversation text, so keep it private. It is ignored by Git.

### 5. Run automated local tests

Run the local tests with **`npm test`**.

These tests cover health, storage, duplicate delivery, separate chats, rapid messages, non-text input, and provider-failure handling. They use controlled provider responses; passing tests do not prove that a real WhatsApp message reached your tunnel.

## If a real message gets no reply

- **No `[WEBHOOK]` log:** check that both Node and ngrok are still running, the public `/health` URL works, the GREEN-API URL ends in `/webhook/green-api`, and the incoming-message switch was saved as on.
- **`[INCOMING]` but no `[OUTGOING]`:** check the `[GROQ]` and `[GREEN-API]` error lines in the Node window. The incoming message should still be in `data/messages.json`.
- **Ngrok address changed:** update the GREEN-API Webhook URL and save again.

## How it works

`POST /webhook/green-api` accepts the documented `incomingMessageReceived` text payload. It reads `idMessage`, `senderData.chatId`, sender information, `messageData.typeMessage`, `messageData.textMessageData.textMessage`, and the Unix timestamp. Non-text and other webhook types are acknowledged without AI processing. Malformed JSON receives HTTP 400.

Valid incoming messages are saved to `data/messages.json` before the webhook returns HTTP 200. A repeated `idMessage` is acknowledged without another Groq call or WhatsApp reply. The file is ignored by Git, along with `.env`. Run one server process against this JSON file; it is a simple local store, not a multi-process database.

After acknowledgement, replies are processed in order per `chatId`. The current chat's 20 most recent prior incoming and outgoing messages become Groq `user` and `assistant` messages, followed by the new text. Groq is called through native `fetch()` with `GROQ_API_KEY`, and GREEN-API `sendMessage` is called through native `fetch()` with the incoming `chatId`. Successful outgoing messages are saved with the GREEN-API `idMessage`. If Groq fails, the bot attempts a short fallback reply. If sending fails, the incoming message remains stored and the failure is logged without credentials.

## Files

- `src/index.js`: built-in HTTP server, webhook handling, per-chat queue.
- `src/routes/whatsapp.js`: GREEN-API payload extraction.
- `src/services/greenapi.js`: GREEN-API send request.
- `src/services/groq.js`: system prompt and Groq chat request.
- `src/storage.js`: persistent JSON message store and conversation history.
- `test/chatbot.test.js`: local integration tests with controlled provider responses.
