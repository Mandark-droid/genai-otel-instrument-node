/**
 * An ES-module application with no reference to this SDK at all. It is traced
 * only because it was started with `node --import .../register`.
 */
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: 'sk-smoke-not-a-real-key', baseURL: process.env.SMOKE_LLM_BASE_URL, maxRetries: 0 });
const completion = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] });
console.log(`answer: ${completion.choices[0].message.content}`);
