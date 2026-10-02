/**
 * A CommonJS application with no reference to this SDK at all. It is traced
 * only because it was started with `node --require .../register`.
 */
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: 'sk-smoke-not-a-real-key', baseURL: process.env.SMOKE_LLM_BASE_URL, maxRetries: 0 });
client.chat.completions
  .create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] })
  .then((completion) => console.log(`answer: ${completion.choices[0].message.content}`));
