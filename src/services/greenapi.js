async function sendMessage(chatId, message, { fetchImpl = fetch } = {}) {
  const { GREEN_API_URL, GREEN_API_INSTANCE_ID, GREEN_API_TOKEN } = process.env;
  if (!GREEN_API_URL || !GREEN_API_INSTANCE_ID || !GREEN_API_TOKEN) {
    throw new Error('Missing GREEN-API configuration');
  }
  const url = `${GREEN_API_URL.replace(/\/$/, '')}/waInstance${GREEN_API_INSTANCE_ID}/sendMessage/${GREEN_API_TOKEN}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, message }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error('GREEN-API request failed');
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (!result || typeof result.idMessage !== 'string') throw new Error('Invalid GREEN-API response');
  return result;
}

module.exports = { sendMessage };
