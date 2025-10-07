/*!
 * © [2025] Malith-Rukshan. All rights reserved.
 * Repository: https://github.com/Malith-Rukshan/Auto-Reaction-Bot
 */

import express from 'express';
import dotenv from 'dotenv';
import TelegramBotAPI from './TelegramBotAPI.js';
import { htmlContent } from './constants.js';
import { splitEmojis, getChatIds } from './helper.js';
import { onUpdate } from './bot-handler.js';

dotenv.config();

const app = express();
app.use(express.json());

// ---------- Shared config ----------
const Reactions = splitEmojis(process.env.EMOJI_LIST);
const RestrictedChats = getChatIds(process.env.RESTRICTED_CHATS);
const RandomLevel = parseInt(process.env.RANDOM_LEVEL || '0', 10);

// ---------- Helpers ----------
const parseList = (raw = '') =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Remove BOM/quotes/odd characters that sometimes creep in when tokens are copy–pasted
const cleanToken = (t = '') =>
  t
    .replace(/\uFEFF/g, '')                 // remove BOM
    .replace(/[“”‘’]/g, '"')                // normalize smart quotes
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')    // trim quotes/whitespace around
    .trim();

const botTokenSingle = process.env.BOT_TOKEN;                   // legacy single-bot
const tokensRaw     = parseList(process.env.BOT_TOKENS || '');  // multi-bot (comma-separated)
const usernamesRaw  = parseList(process.env.BOT_USERNAMES || '');// optional, same order as BOT_TOKENS

// Build a map: botId (digits before colon) -> { token, username, api }
const multiBotMap = new Map();
tokensRaw.forEach((raw, i) => {
  const token = cleanToken(raw);

  // Be tolerant: find "<digits>:" anywhere (not only at the very beginning)
  const m = token.match(/(\d+):/);
  if (!m) {
    console.error('❌ Skipping invalid BOT_TOKENS entry:', JSON.stringify(raw));
    return;
  }

  const botId = m[1];
  const username = usernamesRaw[i] || process.env.BOT_USERNAME || '';

  // Avoid accidental duplicates
  if (multiBotMap.has(botId)) {
    console.warn(`⚠️ Duplicate botId ${botId} in BOT_TOKENS; keeping the first occurrence.`);
    return;
  }

  multiBotMap.set(botId, {
    token,
    username,
    api: new TelegramBotAPI(token),
  });
});

const multiMode = multiBotMap.size > 0;

// ---------- Webhook self-check (startup + /check) ----------

/**
 * Returns { ok, url, pending, lastError } or { ok:false, error }
 */
async function getWebhookInfo(token, abortSignal) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      method: 'GET',
      signal: abortSignal,
    });
    const data = await r.json();
    if (!data || data.ok !== true) {
      return { ok: false, error: 'Telegram replied not ok', raw: data };
    }
    const info = data.result || {};
    return {
      ok: true,
      url: info.url || '',
      pending: info.pending_update_count || 0,
      lastError: info.last_error_message || '',
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Checks each configured bot’s webhook points to /webhook/<id>.
 * Logs clear hints if a mismatch is found.
 */
async function checkAllWebhooks(reason = 'startup') {
  if (!multiMode) {
    console.log('Webhook check skipped (single-bot mode).');
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  const checks = await Promise.allSettled(
    Array.from(multiBotMap.entries()).map(async ([botId, { token }]) => {
      const info = await getWebhookInfo(token, controller.signal);
      const expectPath = `/webhook/${botId}`;
      const result = {
        botId,
        expectPath,
        ok: false,
        info,
      };

      if (!info.ok) {
        console.warn(`⚠️ [${reason}] bot ${botId}: failed to read webhook info -> ${info.error}`);
        return result;
      }

      const got = info.url || '';
      const endsOk = got.endsWith(expectPath);

      if (!got) {
        console.warn(`⚠️ [${reason}] bot ${botId}: webhook is EMPTY. You must set it:`);
        console.warn(`   https://api.telegram.org/bot${botId}:<TOKEN>/setWebhook?url=${process.env.RENDER_EXTERNAL_URL || 'https://auto1-reaction-bot.onrender.com'}${expectPath}&drop_pending_updates=true`);
      } else if (!endsOk) {
        console.error(`❌ [${reason}] bot ${botId}: webhook URL mismatch`);
        console.error(`   Expected path: ${expectPath}`);
        console.error(`   Got URL      : ${got}`);
        console.error(`   Hint: set it to the exact path above (note the bot id).`);
      } else {
        result.ok = true;
        console.log(`✅ [${reason}] bot ${botId}: webhook looks good (${got})`);
      }

      if (info.lastError) {
        console.warn(`   Last webhook error from Telegram: ${info.lastError}`);
      }
      if (info.pending) {
        console.warn(`   Pending update count: ${info.pending}`);
      }

      return result;
    })
  );

  clearTimeout(timeout);
  return checks.map((c) => (c.status === 'fulfilled' ? c.value : { ok: false, error: c.reason }));
}

// Manual trigger
app.get('/check', async (_req, res) => {
  const out = await checkAllWebhooks('manual');
  res.status(200).json({
    mode: multiMode ? 'multi-bot' : 'single-bot',
    results: out,
  });
});

// ---------- Routes ----------
// Legacy single-bot route (POST /) keeps old deployments working
if (botTokenSingle && !multiMode) {
  const botApi = new TelegramBotAPI(botTokenSingle);
  const botUsername = process.env.BOT_USERNAME || '';

  app.post('/', async (req, res) => {
    try {
      await onUpdate(req.body, botApi, Reactions, RestrictedChats, botUsername, RandomLevel);
      res.status(200).send('Ok');
    } catch (error) {
      console.error('Error in onUpdate (single):', error.message);
      res.status(200).send('Ok');
    }
  });
}

// Multi-bot route: Telegram should POST to /webhook/<botId>
app.post('/webhook/:botId', async (req, res) => {
  if (!multiMode) return res.status(404).send('Multi-bot not configured');

  // Be defensive: only digits
  const raw = String(req.params.botId || '');
  const cleanedId = raw.replace(/\D/g, '');

  const entry = multiBotMap.get(cleanedId);
  if (!entry) {
    console.warn(
      `⚠️ Unknown botId in webhook: ${raw} (cleaned: ${cleanedId}). Known IDs: [${Array.from(
        multiBotMap.keys()
      ).join(', ')}]`
    );
    return res.status(404).send('Unknown bot');
  }

  try {
    await onUpdate(req.body, entry.api, Reactions, RestrictedChats, entry.username, RandomLevel);
    res.status(200).send('Ok');
  } catch (error) {
    console.error(`Error in onUpdate [${cleanedId}]:`, error.message);
    res.status(200).send('Ok');
  }
});

// Sometimes it’s handy to hit this URL manually in a browser
app.get('/webhook/:botId', (_req, res) => res.status(200).send('Ok'));

// Health & debug
app.get('/', (_req, res) => res.send(htmlContent));

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    mode: multiMode ? 'multi-bot' : 'single-bot',
    bots: multiMode ? Array.from(multiBotMap.keys()) : [],
  });
});

// Extra: shows exactly what the server loaded (great for troubleshooting)
app.get('/debug', (_req, res) => {
  res.status(200).json({
    mode: multiMode ? 'multi-bot' : 'single-bot',
    knownIds: Array.from(multiBotMap.keys()),
    hasTokensEnv: !!process.env.BOT_TOKENS,
    tokensEnvLength: (process.env.BOT_TOKENS || '').length,
  });
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  if (multiMode) {
    console.log(`==> Multi-bot active for IDs: ${Array.from(multiBotMap.keys()).join(', ')}`);
    // do a non-blocking webhook check on startup
    checkAllWebhooks('startup').catch((e) =>
      console.warn('Webhook check failed:', String(e))
    );
  } else if (botTokenSingle) {
    console.log('==> Single-bot mode active');
  } else {
    console.log('⚠️ No bot token(s) configured');
  }
});
