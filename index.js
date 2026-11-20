'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;

const {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const config = require('./config');

// Silent logger saves resources.
const logger = pino({ level: 'silent' });

// In-memory storage only.
const history = Object.create(null);
const cooldowns = Object.create(null);
const sentBotMessages = Object.create(null);

let socket = null;
let connectedNoticeSent = false;
let autoReply = config.AUTO_REPLY;
let reconnecting = false;


// ==========================================
// GENERAL HELPERS
// ==========================================

function logError(label, error) {
  console.error(
    `[${config.BOT_NAME}] ${label}:`,
    error && (error.stack || error.message || error)
  );
}

function normalizeNumber(value) {
  return String(value || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');
}

function botNumber() {
  return normalizeNumber(
    socket && socket.user && socket.user.id
  );
}

function isOwner(message, sender) {
  return Boolean(message.key && message.key.fromMe) ||
    normalizeNumber(sender) === normalizeNumber(config.OWNER_NUMBER) ||
    (
      botNumber() &&
      normalizeNumber(sender) === botNumber()
    );
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  return [
    days ? `${days}d` : '',
    `${hours}h`,
    `${minutes}m`,
    `${secs}s`
  ].filter(Boolean).join(' ');
}

function getUptime() {
  return formatDuration(process.uptime());
}


// ==========================================
// MESSAGE HELPERS
// ==========================================

function getMessageText(message) {
  const content = message.message || {};

  return content.conversation ||

    (
      content.extendedTextMessage &&
      content.extendedTextMessage.text
    ) ||

    (
      content.imageMessage &&
      content.imageMessage.caption
    ) ||

    (
      content.videoMessage &&
      content.videoMessage.caption
    ) ||

    (
      content.documentMessage &&
      content.documentMessage.caption
    ) ||

    (
      content.buttonsResponseMessage &&
      content.buttonsResponseMessage.selectedButtonId
    ) ||

    (
      content.listResponseMessage &&
      content.listResponseMessage.singleSelectReply &&
      content.listResponseMessage.singleSelectReply.selectedRowId
    ) || '';
}

function isIgnoredChat(jid) {
  return !jid ||
    jid === 'status@broadcast' ||
    jid.endsWith('@newsletter') ||
    jid.endsWith('@broadcast');
}


// Remember messages sent by the bot.
// This helps detect group replies to bot messages.
function rememberBotMessage(chat, result) {
  const id = result && result.key && result.key.id;

  if (!id) return;

  if (!sentBotMessages[chat]) {
    sentBotMessages[chat] = Object.create(null);
  }

  sentBotMessages[chat][id] = Date.now();

  const ids = Object.keys(sentBotMessages[chat]);

  if (ids.length > 50) {
    ids.sort(
      (a, b) =>
        sentBotMessages[chat][a] -
        sentBotMessages[chat][b]
    );

    for (const oldId of ids.slice(0, ids.length - 50)) {
      delete sentBotMessages[chat][oldId];
    }
  }
}


// Send normal text messages.
async function sendText(sock, chat, text, quoted) {
  const result = await sock.sendMessage(
    chat,
    {
      text: String(text).slice(0, config.MAX_REPLY_LENGTH)
    },
    quoted ? { quoted } : {}
  );

  rememberBotMessage(chat, result);

  return result;
}


// ==========================================
// MENU SYSTEM
// ==========================================

async function sendMenu(sock, chat, quoted) {
  const groups = Object.create(null);

  // Build menu automatically from commands.
  for (const [name, command] of Object.entries(commands)) {
    if (!groups[command.cat]) {
      groups[command.cat] = [];
    }

    groups[command.cat].push(
      `│ ✦ ${config.PREFIX}${name}${command.desc ? ` — ${command.desc}` : ''}`
    );
  }

  const parts = [
    config.header(),

    config.section('BOT INFO', [
      `OWNER : ${config.CREATOR_NAME}`,
      `PREFIX : ${config.PREFIX}`,
      `MODE : ${config.MODE}`,
      `AI REPLY : ${autoReply ? 'ON' : 'OFF'}`,
      'STATUS : Online 🟢',
      `UPTIME : ${getUptime()}`
    ])
  ];

  for (const [category, lines] of Object.entries(groups)) {
    parts.push(
      config.section(
        category,
        lines.map(line => line.replace(/^│ ✦ /, ''))
      )
    );
  }

  const caption = parts.join('\n\n');

  try {
    const result = await sock.sendMessage(
      chat,
      {
        image: { url: config.BOT_IMAGE },
        caption: caption.slice(0, 1024)
      },
      quoted ? { quoted } : {}
    );

    rememberBotMessage(chat, result);

  } catch (error) {

    logError('Menu image failed; sending text menu', error);

    await sendText(sock, chat, caption, quoted);
  }
}


// ==========================================
// GROUP REPLY DETECTION
// ==========================================

function extractQuotedContext(message) {
  const content = message.message || {};

  const extended =
    content.extendedTextMessage ||
    content.imageMessage ||
    content.videoMessage ||
    {};

  return extended.contextInfo || {};
}

function isReplyToBot(chat, message) {
  const context = extractQuotedContext(message);

  if (!context.quotedMessage) return false;

  const participant = normalizeNumber(context.participant);

  if (
    participant &&
    botNumber() &&
    participant === botNumber()
  ) {
    return true;
  }

  const stanzaId = context.stanzaId;

  return Boolean(
    stanzaId &&
    sentBotMessages[chat] &&
    sentBotMessages[chat][stanzaId]
  );
}


// ==========================================
// CHAT HISTORY
// ==========================================

function getHistory(chat) {
  if (!history[chat]) {
    history[chat] = [];
  }

  return history[chat];
}

function trimHistory(chat) {
  const messages = getHistory(chat);

  if (messages.length > config.MAX_HISTORY) {
    messages.splice(
      0,
      messages.length - config.MAX_HISTORY
    );
  }
}


// ==========================================
// AI ENGINE
// ==========================================

async function askAI(sock, chat, sender, prompt, quoted) {

  // Per-user cooldown.
  const cooldownKey = normalizeNumber(sender) || chat;

  const now = Date.now();

  const waitMs =
    config.COOLDOWN_SECONDS * 1000 -
    (now - (cooldowns[cooldownKey] || 0));

  if (waitMs > 0) {
    await sendText(
      sock,
      chat,
      `Please wait ${Math.ceil(waitMs / 1000)} seconds before asking again.`,
      quoted
    );

    return;
  }

  cooldowns[cooldownKey] = now;


  // Check API key.
  if (!config.GROQ_API_KEY) {
    console.error(
      `[${config.BOT_NAME}] GROQ_API_KEY is empty. Add your API key in config.js.`
    );

    await sendText(
      sock,
      chat,
      config.BUSY_MESSAGE,
      quoted
    );

    return;
  }


  // Show typing.
  await sock.sendPresenceUpdate(
    'composing',
    chat
  ).catch(() => {});


  // 20-second timeout.
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    config.REQUEST_TIMEOUT_MS
  );

  let responseStatus = 'NO_RESPONSE';
  let responseBody = '';

  try {

    const priorMessages = getHistory(chat)
      .slice(-config.MAX_HISTORY);

    const messages = [

      {
        role: 'system',
        content: config.SYSTEM_PROMPT
      },

      ...priorMessages,

      {
        role: 'user',
        content: prompt
      }

    ];


    // Send request through the configured proxy.
    // Do not contact api.groq.com directly.
    const response = await fetch(config.GROQ_URL, {

      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.GROQ_API_KEY}`
      },

      body: JSON.stringify({

        model: config.GROQ_MODEL,

        reasoning_effort: config.REASONING_EFFORT,

        messages,

        max_tokens: config.MAX_TOKENS

      }),

      signal: controller.signal

    });


    responseStatus = response.status;

    responseBody = await response.text();


    // Handle HTTP errors.
    if (!response.ok) {

      console.error(
        `[${config.BOT_NAME}] AI request failed. Status: ${responseStatus}; Body: ${responseBody}`
      );

      await sendText(
        sock,
        chat,
        config.BUSY_MESSAGE,
        quoted
      );

      return;
    }


    // Parse response.
    let data;

    try {

      data = JSON.parse(responseBody);

    } catch (parseError) {

      console.error(
        `[${config.BOT_NAME}] AI returned invalid JSON. Status: ${responseStatus}; Body: ${responseBody}`
      );

      await sendText(
        sock,
        chat,
        config.BUSY_MESSAGE,
        quoted
      );

      return;
    }


    // Read AI answer.
    const answer =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;


    // Empty answer protection.
    if (
      typeof answer !== 'string' ||
      !answer.trim()
    ) {

      console.error(
        `[${config.BOT_NAME}] AI returned an empty answer. Status: ${responseStatus}; Body: ${responseBody}`
      );

      await sendText(
        sock,
        chat,
        config.BUSY_MESSAGE,
        quoted
      );

      return;
    }


    const cleanAnswer = answer
      .trim()
      .slice(0, config.MAX_REPLY_LENGTH);


    // Save conversation history.
    const chatHistory = getHistory(chat);

    chatHistory.push({
      role: 'user',
      content: prompt
    });

    chatHistory.push({
      role: 'assistant',
      content: cleanAnswer
    });

    trimHistory(chat);


    // Send response.
    await sendText(
      sock,
      chat,
      cleanAnswer,
      quoted
    );


  } catch (error) {

    const timedOut =
      error && error.name === 'AbortError';

    console.error(
      `[${config.BOT_NAME}] AI request error. Status: ${timedOut ? 'TIMEOUT' : responseStatus}; Body: ${responseBody || '(empty)'}; Error: ${error && error.message ? error.message : error}`
    );

    await sendText(
      sock,
      chat,
      config.BUSY_MESSAGE,
      quoted
    ).catch(
      sendError => logError('Could not send AI error reply', sendError)
    );

  } finally {

    clearTimeout(timeout);

    await sock.sendPresenceUpdate(
      'paused',
      chat
    ).catch(() => {});

  }
}


// ==========================================
// TIME HELPER
// ==========================================

function getLocalTime() {
  return new Intl.DateTimeFormat('en-GB', {

    timeZone: config.TIMEZONE,

    dateStyle: 'full',

    timeStyle: 'medium'

  }).format(new Date());
}


// ==========================================
// COMMANDS
// ==========================================

// All commands are managed in this one object.
// To add a command, add one new entry here.

const commands = {

  menu: {
    cat: 'MAIN MENU',
    desc: 'Show all commands',

    run: async ({ sock, chat, msg }) =>
      sendMenu(sock, chat, msg)
  },


  ai: {
    cat: 'AI TOOLS',
    desc: '<question> — ask Proza AI',

    run: async ({ sock, chat, sender, args, msg }) => {

      if (!args.trim()) {

        return sendText(
          sock,
          chat,
          `Usage: ${config.PREFIX}ai what is JavaScript?`,
          msg
        );

      }

      return askAI(
        sock,
        chat,
        sender,
        args.trim(),
        msg
      );
    }
  },


  reset: {
    cat: 'AI TOOLS',
    desc: 'Clear this chat history',

    run: async ({ sock, chat, msg }) => {

      delete history[chat];

      return sendText(
        sock,
        chat,
        config.section(
          'HISTORY RESET',
          ['This chat conversation history has been cleared.']
        ),
        msg
      );
    }
  },


  about: {
    cat: 'BOT DETAILS',
    desc: 'About this bot',

    run: async ({ sock, chat, msg }) =>
      sendText(
        sock,
        chat,
        [
          config.header(),

          config.section('ABOUT', [

            `BOT : ${config.BOT_NAME}`,
            `AI : ${config.AI_NAME}`,
            `CREATOR : ${config.CREATOR_NAME}`,
            `VERSION : ${config.VERSION}`,
            `PURPOSE : ${config.AI_HELPS_WITH}`

          ])

        ].join('\n\n'),
        msg
      )
  },


  ping: {
    cat: 'BOT DETAILS',
    desc: 'Check response',

    run: async ({ sock, chat, msg }) =>
      sendText(
        sock,
        chat,
        config.section(
          'PING',
          [
            'Pong! 🏓',
            'STATUS : Online 🟢'
          ]
        ),
        msg
      )
  },


  alive: {
    cat: 'BOT DETAILS',
    desc: 'Check bot status',

    run: async ({ sock, chat, msg }) =>
      sendText(
        sock,
        chat,
        config.section(
          'BOT STATUS',
          [
            'STATUS : Online 🟢',
            `UPTIME : ${getUptime()}`,
            `VERSION : ${config.VERSION}`
          ]
        ),
        msg
      )
  },


  owner: {
    cat: 'BOT DETAILS',
    desc: 'Show owner contact',

    run: async ({ sock, chat, msg }) =>
      sendText(
        sock,
        chat,
        config.section(
          'OWNER',
          [
            `NAME : ${config.CREATOR_NAME}`,
            `NUMBER : +${config.OWNER_NUMBER}`,
            `WHATSAPP : https://wa.me/${config.OWNER_NUMBER}`
          ]
        ),
        msg
      )
  },


  runtime: {
    cat: 'BOT DETAILS',
    desc: 'Show uptime',

    run: async ({ sock, chat, msg }) =>
      sendText(
        sock,
        chat,
        config.section(
          'RUNTIME',
          [
            `UPTIME : ${getUptime()}`
          ]
        ),
        msg
      )
  },


  time: {
    cat: 'BOT DETAILS',
    desc: 'Show Harare time',

    run: async ({ sock, chat, msg }) =>
      sendText(
        sock,
        chat,
        config.section(
          'TIME',
          [
            getLocalTime(),
            `TIMEZONE : ${config.TIMEZONE}`
          ]
        ),
        msg
      )
  },


  autoreply: {
    cat: 'OWNER TOOLS',
    desc: 'on/off — toggle automatic private replies',

    run: async ({ sock, chat, args, msg, authorized }) => {

      // Only the connected account or configured owner.
      if (!authorized) {

        return sendText(
          sock,
          chat,
          'Only the connected WhatsApp account or the configured owner can use this command.',
          msg
        );

      }

      const choice = args.trim().toLowerCase();

      if (
        choice !== 'on' &&
        choice !== 'off'
      ) {

        return sendText(
          sock,
          chat,
          `Usage: ${config.PREFIX}autoreply on OR ${config.PREFIX}autoreply off`,
          msg
        );

      }

      autoReply = choice === 'on';

      return sendText(
        sock,
        chat,
        config.section(
          'AUTO REPLY',
          [
            `NEW STATE : ${autoReply ? 'ON 🟢' : 'OFF 🔴'}`
          ]
        ),
        msg
      );

    }
  }

};


// ==========================================
// MESSAGE HANDLER
// ==========================================

async function handleMessage(sock, message) {

  const chat =
    message.key &&
    message.key.remoteJid;

  if (
    isIgnoredChat(chat) ||
    !message.message
  ) {
    return;
  }


  const text = getMessageText(message).trim();

  if (!text) return;


  const isGroup = chat.endsWith('@g.us');

  const sender = isGroup
    ? (message.key.participant || '')
    : chat;

  const authorized = isOwner(message, sender);

  const isCommand = text.startsWith(config.PREFIX);


  // Do not respond to the bot's own ordinary messages.
  // Still allow autoreply commands from the connected account.
  if (
    message.key.fromMe &&
    !(
      isCommand &&
      text.slice(config.PREFIX.length)
        .trim()
        .toLowerCase()
        .startsWith('autoreply')
    )
  ) {
    return;
  }


  // PRIVATE mode means owner-only.
  if (
    config.MODE.toUpperCase() === 'PRIVATE' &&
    !authorized
  ) {
    return;
  }


  // ========================================
  // COMMAND PROCESSING
  // ========================================

  if (isCommand) {

    const commandLine = text
      .slice(config.PREFIX.length)
      .trim();

    if (!commandLine) return;


    const firstSpace = commandLine.indexOf(' ');

    const commandName = (
      firstSpace === -1
        ? commandLine
        : commandLine.slice(0, firstSpace)
    ).toLowerCase();

    const args = firstSpace === -1
      ? ''
      : commandLine.slice(firstSpace + 1);


    const command = commands[commandName];

    if (!command) return;


    try {

      await command.run({
        sock,
        chat,
        sender,
        args,
        msg: message,
        authorized
      });

    } catch (error) {

      logError(
        `Command ${commandName} failed`,
        error
      );

      await sendText(
        sock,
        chat,
        'Sorry, that command could not be completed.',
        message
      ).catch(() => {});

    }

    return;
  }


  // ========================================
  // GROUP AUTO-RESPONSE
  // ========================================

  if (isGroup) {

    // Group AI is activated only by .ai <question>
    // or by replying to one of the bot's messages.
    if (!isReplyToBot(chat, message)) {
      return;
    }

    return askAI(
      sock,
      chat,
      sender,
      text,
      message
    );

  }


  // ========================================
  // PRIVATE AUTO-RESPONSE
  // ========================================

  if (autoReply) {

    return askAI(
      sock,
      chat,
      sender,
      text,
      message
    );

  }

}


// ==========================================
// PAIRING NUMBER INPUT
// ==========================================

function waitForPairNumber() {

  return new Promise(resolve => {

    if (
      !process.stdin ||
      !process.stdin.isTTY
    ) {

      console.error(
        `[${config.BOT_NAME}] PAIR_NUMBER is empty and no interactive terminal is available. Will retry in ${config.PAIRING_RETRY_MS / 1000} seconds.`
      );

      return resolve('');
    }


    const rl = readline.createInterface({

      input: process.stdin,

      output: process.stdout

    });

    let finished = false;


    const finish = value => {

      if (finished) return;

      finished = true;

      clearTimeout(timer);

      rl.close();

      resolve(
        String(value || '').replace(/\D/g, '')
      );

    };


    const timer = setTimeout(() => {

      console.error(
        `[${config.BOT_NAME}] No pairing number was entered. Will retry in ${config.PAIRING_RETRY_MS / 1000} seconds.`
      );

      finish('');

    }, config.PAIRING_INPUT_TIMEOUT_MS);


    rl.question(
      'Enter WhatsApp number with country code (numbers only): ',
      finish
    );

  });

}


// ==========================================
// PAIRING CODE SYSTEM
// ==========================================

async function requestPairing(sock, sessionExists) {

  if (
    sessionExists ||
    sock.authState.creds.registered
  ) {
    return;
  }


  let number = String(
    config.PAIR_NUMBER || ''
  ).replace(/\D/g, '');


  // Readline is used only when PAIR_NUMBER is empty.
  if (!number) {

    number = await waitForPairNumber();

  }


  // Retry if no number was supplied.
  if (!number) {

    setTimeout(() => {

      if (socket === sock) {

        requestPairing(sock, false)
          .catch(error =>
            logError('Pairing retry failed', error)
          );

      }

    }, config.PAIRING_RETRY_MS);

    return;
  }


  try {

    const code = await sock.requestPairingCode(number);

    const formatted = String(code)
      .replace(/\s/g, '')
      .match(/.{1,4}/g)
      .join('-');


    console.log(
      `\n[${config.BOT_NAME}] PAIRING CODE: ${formatted}`
    );

    console.log('Pair in WhatsApp:');

    console.log('1. Open WhatsApp on your phone.');

    console.log('2. Go to Settings (or ⋮) → Linked devices.');

    console.log('3. Tap Link a device → Link with phone number instead.');

    console.log('4. Enter the pairing code shown above.\n');


  } catch (error) {

    logError(
      'Pairing code request failed; reconnecting',
      error
    );

    // End socket so the connection handler can restart it.
    try {
      sock.end(new Error('Pairing code request failed'));
    } catch (_) {}

  }

}


// ==========================================
// START WHATSAPP BOT
// ==========================================

async function startBot() {

  if (reconnecting) return;

  reconnecting = true;


  try {

    const sessionPath = path.join(
      __dirname,
      config.SESSION_FOLDER
    );


    // Load existing session.
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(sessionPath);


    const sessionExists = Boolean(
      state.creds.registered
    );


    const sock = makeWASocket({

      auth: state,

      logger,

      browser: Browsers.ubuntu('Chrome'),

      printQRInTerminal: false,

      syncFullHistory: false,

      shouldSyncHistoryMessage: () => false,

      markOnlineOnConnect: false,

      emitOwnEvents: true,

      keepAliveIntervalMs: config.KEEPALIVE_INTERVAL_MS,

      shouldIgnoreJid: jid => isIgnoredChat(jid)

    });


    socket = sock;


    // Save authentication updates.
    sock.ev.on(
      'creds.update',
      saveCreds
    );


    // Handle incoming messages.
    sock.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {

        if (type !== 'notify') return;

        for (const message of messages) {

          try {

            await handleMessage(sock, message);

          } catch (error) {

            logError(
              'Message handler failed',
              error
            );

          }

        }

      }
    );


    let pairingStarted = false;


    // ======================================
    // CONNECTION EVENTS
    // ======================================

    sock.ev.on(
      'connection.update',
      async update => {

        const {
          connection,
          lastDisconnect
        } = update;


        // Successfully connected.
        if (connection === 'open') {

          console.log(
            `[${config.BOT_NAME}] Connected successfully.`
          );


          // Notify owner once.
          if (
            !connectedNoticeSent &&
            config.OWNER_NUMBER
          ) {

            connectedNoticeSent = true;

            const ownerJid =
              `${normalizeNumber(config.OWNER_NUMBER)}@s.whatsapp.net`;

            sendText(
              sock,
              ownerJid,
              `${config.BOT_NAME} connected successfully 🟢`
            ).catch(error =>
              logError('Owner connection notice failed', error)
            );

          }

        }


        // Request pairing code about 3 seconds
        // after the socket is created.
        if (
          !pairingStarted &&
          !sessionExists &&
          !state.creds.registered
        ) {

          pairingStarted = true;

          setTimeout(() => {

            if (socket === sock) {

              requestPairing(sock, sessionExists)
                .catch(error =>
                  logError('Pairing request failed', error)
                );

            }

          }, config.PAIRING_DELAY_MS);

        }


        // ==================================
        // CONNECTION CLOSED
        // ==================================

        if (connection === 'close') {

          const statusCode =
            lastDisconnect &&
            lastDisconnect.error &&
            lastDisconnect.error.output &&
            lastDisconnect.error.output.statusCode;


          console.error(
            `[${config.BOT_NAME}] Connection closed. Status: ${statusCode || 'unknown'}`
          );


          // Delete invalid session after logout.
          if (
            statusCode === DisconnectReason.loggedOut ||
            statusCode === 401
          ) {

            try {

              fs.rmSync(
                sessionPath,
                {
                  recursive: true,
                  force: true
                }
              );

            } catch (error) {

              logError(
                'Could not delete logged-out session',
                error
              );

            }

          }


          // Code 515 reconnects almost immediately.
          const delay =
            statusCode === 515
              ? config.FAST_RECONNECT_DELAY_MS
              : config.RECONNECT_DELAY_MS;


          setTimeout(() => {

            if (socket === sock) {
              socket = null;
            }

            reconnecting = false;

            startBot().catch(error =>
              logError('Reconnect failed', error)
            );

          }, delay);

        }

      }
    );


  } catch (error) {

    logError(
      'Startup failed; retrying',
      error
    );

    setTimeout(() => {

      reconnecting = false;

      startBot().catch(nextError =>
        logError('Startup retry failed', nextError)
      );

    }, config.RECONNECT_DELAY_MS);

  }


  reconnecting = false;

}


// ==========================================
// STARTUP CHECKS
// ==========================================

if (!config.GROQ_API_KEY) {

  console.error(
    `[${config.BOT_NAME}] GROQ_API_KEY is empty. Open config.js and paste your API key before using AI replies.`
  );

}


// Log unexpected errors without exiting.
process.on(
  'uncaughtException',
  error => logError('Uncaught exception', error)
);

process.on(
  'unhandledRejection',
  error => logError('Unhandled rejection', error)
);


// Keep-alive interval.
setInterval(() => {

  if (
    socket &&
    socket.ws &&
    socket.ws.readyState === 1
  ) {

    socket.sendPresenceUpdate('available')
      .catch(() => {});

  }

}, config.KEEPALIVE_INTERVAL_MS);


// Start bot.
startBot().catch(error =>
  logError('Initial startup failed', error)
);
