'use strict';

// Edit your personal details and API key here.
const CONFIG = {
  BOT_NAME: 'Proza XMD',
  AI_NAME: 'Proza AI',
  CREATOR_NAME: 'Proza tech',
  CREATOR_INFO: 'I was created by Proza tech.',
  OWNER_NUMBER: '263710707845',
  PAIR_NUMBER: '263710707845',

  BOT_IMAGE: 'https://res.cloudinary.com/dqqyvozdw/image/upload/v1795160800/idtev2lqmjiu4gkispxa.jpg',

  AI_HELPS_WITH: 'Helping beginners learn programming: explain simply, give small examples, help fix errors step by step.',

  // Paste your real API key between the quotes.
  GROQ_API_KEY: '',

  GROQ_URL: 'https://fei-ai.vercel.app/api/groq',
  GROQ_MODEL: 'openai/gpt-oss-20b',
  REASONING_EFFORT: 'low',

  PREFIX: '.',
  MODE: 'PUBLIC',
  VERSION: '1.0.0',
  TIMEZONE: 'Africa/Harare',

  AUTO_REPLY: true,
  MAX_HISTORY: 6,
  COOLDOWN_SECONDS: 5,

  // Session and performance settings
  SESSION_FOLDER: 'session',
  REQUEST_TIMEOUT_MS: 20000,
  MAX_TOKENS: 600,

  PAIRING_DELAY_MS: 3000,
  PAIRING_RETRY_MS: 15000,
  PAIRING_INPUT_TIMEOUT_MS: 30000,

  RECONNECT_DELAY_MS: 2000,
  FAST_RECONNECT_DELAY_MS: 300,
  KEEPALIVE_INTERVAL_MS: 25000,

  MAX_REPLY_LENGTH: 1200,
  BUSY_MESSAGE: 'AI is busy, try again in a moment 🙏'
};

// Small-caps alphabet
const SMALL_CAPS = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ',
  e: 'ᴇ', f: 'ғ', g: 'ɢ', h: 'ʜ',
  i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ',
  m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ',
  q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ',
  u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x',
  y: 'ʏ', z: 'ᴢ'
};

function smallCaps(value) {
  return String(value)
    .toLowerCase()
    .replace(/[a-z]/g, char => SMALL_CAPS[char] || char);
}

// Main menu header
function header() {
  return [
    '╭──────────────────────╮',
    `│ ⚡ ${smallCaps(CONFIG.BOT_NAME)} ⚡proza xmd       │`,
    '╰──────────────────────╯'
  ].join('\n');
}

// Section formatting helper
function section(title, lines = []) {
  const label = smallCaps(title);

  const body = lines.map(line => {
    const splitAt = String(line).indexOf(':');

    const formatted = splitAt > -1
      ? `${smallCaps(String(line).slice(0, splitAt).trim())} : ${String(line).slice(splitAt + 1).trim()}`
      : String(line);

    return `│ ✦ ${formatted}`;
  }).join('\n');

  return [
    `╭───「 ${label} 」───`,
    body,
    '╰──────────────────────'
  ].filter(Boolean).join('\n');
}

CONFIG.header = header;
CONFIG.section = section;
CONFIG.smallCaps = smallCaps;

// AI personality and instructions
CONFIG.SYSTEM_PROMPT = [
  `You are ${CONFIG.AI_NAME}, the AI assistant of ${CONFIG.CREATOR_NAME}.`,

  CONFIG.CREATOR_INFO,

  `Your main job: ${CONFIG.AI_HELPS_WITH}`,

  'Stay friendly, concise, and simple. Use plain text suitable for WhatsApp and keep every reply under about 1200 characters.',

  'Give small practical examples and explain fixes step by step when useful.',

  'Small talk is fine. Politely steer unrelated questions back to your main job.',

  `If asked your name or what you are, say you are ${CONFIG.AI_NAME}, the AI assistant of ${CONFIG.CREATOR_NAME}. If asked who created or owns you, identify ${CONFIG.CREATOR_NAME} as your creator. You may use the creator information above.`,

  'Never claim to be human. Never name or reveal the AI company, provider, model, or technical backend. If sincerely asked about the technology, say you are an AI assistant powered by an AI language model.',

  'Do not claim to have performed actions outside this chat. Avoid markdown tables; use simple WhatsApp-friendly text.'
].join('\n');

module.exports = CONFIG;
