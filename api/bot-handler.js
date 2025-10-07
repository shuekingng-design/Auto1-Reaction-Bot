/*!
 * © [2025] Malith-Rukshan. All rights reserved.
 * Repository: https://github.com/Malith-Rukshan/Auto-Reaction-Bot
 */

import { startMessage, donateMessage } from './constants.js';
import { getRandomPositiveReaction } from './helper.js';

/**
 * Small sleep helper
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pick a delay based on chat type, env overrides, and RandomLevel jitter.
 * - Env overrides (if set for all chat types):
 *    REACT_DELAY_MIN_MS, REACT_DELAY_MAX_MS
 * - Defaults (per chat type) if env isn’t set:
 *    private: 2–6s, group/supergroup: 8–20s, channel: 10–25s
 *
 * @param {('private'|'group'|'supergroup'|'channel')} chatType
 * @param {number} RandomLevel (0–10)
 * @returns {number} milliseconds
 */
function pickDelayMs(chatType, RandomLevel) {
  const envMin = Number(process.env.REACT_DELAY_MIN_MS);
  const envMax = Number(process.env.REACT_DELAY_MAX_MS);

  let min, max;

  if (!Number.isNaN(envMin) && !Number.isNaN(envMax) && envMax >= envMin) {
    min = envMin;
    max = envMax;
  } else {
    // Sensible defaults per chat type
    if (chatType === 'private') {
      min = 2000;  // 2s
      max = 6000;  // 6s
    } else if (chatType === 'channel') {
      min = 10000; // 10s
      max = 25000; // 25s
    } else {
      // group/supergroup
      min = 8000;  // 8s
      max = 20000; // 20s
    }
  }

  const base = min + Math.floor(Math.random() * (max - min + 1));
  const jitter = Math.floor(Math.random() * (RandomLevel * 300)); // up to 3s extra at level 10
  return base + jitter;
}

/**
 * Schedule a delayed reaction without blocking the webhook response.
 * Errors are caught & logged so they don’t crash the process.
 */
async function scheduleReaction(botApi, chatId, messageId, reaction, delayMs) {
  try {
    await sleep(delayMs);
    await botApi.setMessageReaction(chatId, messageId, reaction);
  } catch (err) {
    console.error('setMessageReaction failed:', err?.message || err);
  }
}

/**
 * Handle incoming Telegram Update
 * https://core.telegram.org/bots/api#update
 *
 * @param {Object} data - Telegram update object
 * @param {Object} botApi - TelegramBotAPI instance
 * @param {Array} Reactions - Array of emoji reactions
 * @param {Array} RestrictedChats - Array of restricted chat IDs
 * @param {string} botUsername - Bot username
 * @param {number} RandomLevel - Random level for group reactions (0-10)
 */
export async function onUpdate(data, botApi, Reactions, RestrictedChats, botUsername, RandomLevel) {
  let chatId, message_id, text;

  if (data.message || data.channel_post) {
    const content = data.message || data.channel_post;
    chatId = content.chat.id;
    message_id = content.message_id;
    text = content.text;

    // /start, /reactions, /donate handling
    if (data.message && (text === '/start' || text === '/start@' + botUsername)) {
      await botApi.sendMessage(
        chatId,
        startMessage.replace(
          'UserName',
          content.chat.type === 'private' ? content.from.first_name : content.chat.title
        ),
        [
          [
            { text: '➕ Add to Channel ➕', url: `https://t.me/${botUsername}?startchannel=botstart` },
            { text: '➕ Add to Group ➕', url: `https://t.me/${botUsername}?startgroup=botstart` },
          ],
          [{ text: 'Github Source 📥', url: 'https://github.com/Malith-Rukshan/Auto-Reaction-Bot' }],
          [{ text: '💝 Support Us - Donate 🤝', url: 'https://t.me/Auto_ReactionBOT?start=donate' }],
        ]
      );
      return;
    } else if (data.message && text === '/reactions') {
      const reactions = Reactions.join(', ');
      await botApi.sendMessage(chatId, '✅ Enabled Reactions : \n\n' + reactions);
      return;
    } else if (data.message && (text === '/donate' || text === '/start donate')) {
      await botApi.sendInvoice(
        chatId,
        'Donate to Auto Reaction Bot ✨',
        donateMessage,
        '{}',
        '',
        'donate',
        'XTR',
        [{ label: 'Pay ⭐️5', amount: 5 }]
      );
      return;
    }

    // --- Reaction logic with delay ---
    if (!RestrictedChats.includes(chatId)) {
      const chatType = content.chat.type; // 'private' | 'group' | 'supergroup' | 'channel'
      const reaction = getRandomPositiveReaction(Reactions);

      // Threshold: higher RandomLevel => lower chance to react (same as your original logic)
      const threshold = 1 - RandomLevel / 10;

      const shouldReact =
        chatType === 'private' // always react in private
          ? true
          : Math.random() <= threshold;

      if (shouldReact) {
        const delayMs = pickDelayMs(chatType, RandomLevel);
        // Fire-and-forget; don't block webhook response
        scheduleReaction(botApi, chatId, message_id, reaction, delayMs);
      }
    }
  } else if (data.pre_checkout_query) {
    await botApi.answerPreCheckoutQuery(data.pre_checkout_query.id, true);
    await botApi.sendMessage(data.pre_checkout_query.from.id, 'Thank you for your donation! 💝');
  }
}
