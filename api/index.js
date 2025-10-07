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
        console.warn(`⚠️ [${reason}] bot ${botId}:
