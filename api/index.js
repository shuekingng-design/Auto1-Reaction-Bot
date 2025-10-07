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

// ----- Shared config -----
const Reactions = splitEmojis(process.env.EMOJI_LIST);
const RestrictedChats = getChatIds(process.env.RESTRICTED_CHATS);
const RandomLevel = parseInt(process.env.RANDOM_LEVEL || '0', 10);

// ----- Helpers -----
const parseTokens = (raw) =>
  (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const botTokenSingle = process.env.BOT_TOKEN;                       // legacy single-bot
const tokens = parseTokens(process.env.BOT_TOKENS);                 // multi-bot (comma-separated)
const usernames = parseTokens(process.env.BOT_USERNAMES || '');     // optional, same order as BOT_TOKENS

// Build a map: botId (digits before colon) -> { token, username, api }
const multiBotMap = new Map();
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  const m = token.match(/^(\d+):/);
  if (!m) {
    console.error('❌ Invalid BOT_TOKENS entry (missing <id>: prefix):', token.slice(0, 16) + '…');
    continue;
  }
  const botId = m[1];
  const username = usernames[i] || process.env.BOT_USERNAME || '';
  multiBotMap.set(botId, {
    token,
    username,
    api: new TelegramBotAPI(token),
  });
}

const multiMode = multiBotMap.size > 0;

// ----- Webhook handlers -----
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

  const { botId } = req.params;
  const entry = multiBotMap.get(botId);
  if (!entry) {
    console.warn('⚠️ Unknown botId in webhook:', botId);
    return res.status(404).send('Unknown bot');
  }

  try {
    await onUpdate(req.body, entry.api, Reactions, RestrictedChats, entry.username, RandomLevel);
    res.status(200).send('Ok');
  } catch (error) {
    console.error(`Error in onUpdate [${botId}]:`, error.message);
    res.status(200).send('Ok');
  }
});

// Health & root
app.get('/', (_req, res) => res.send(htmlContent));
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    mode: multiMode ? 'multi-bot' : 'single-bot',
    bots: multiMode ? Array.from(multiBotMap.keys()) : []
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (multiMode) {
    console.log(`==> Multi-bot active for IDs: ${Array.from(multiBotMap.keys()).join(', ')}`);
  } else if (botTokenSingle) {
    console.log('==> Single-bot mode active');
  } else {
    console.log('⚠️ No bot token(s) configured');
  }
});
