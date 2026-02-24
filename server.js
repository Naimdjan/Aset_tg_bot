const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ======================
// ENV
// ======================
const BOT_TOKEN = process.env.BOT_TOKEN; // Render -> Environment -> Add: BOT_TOKEN
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not found in environment variables");
}
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ======================
// Simple in-memory state (на Render переживёт до перезапуска/усыпления)
// ======================
const userState = new Map(); // key: chatId, value: { step, data }

// ======================
// Helpers
// ======================
async function tg(method, payload) {
  try {
    return await axios.post(`${TELEGRAM_API}/${method}`, payload);
  } catch (e) {
    const msg = e?.response?.data?.description || e.message;
    console.log("TG error:", msg);
  }
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📝 Новая заявка", callback_data: "new_request" }],
      [{ text: "🆔 Мой ID", callback_data: "getmyid" }],
      [{ text: "❌ Отмена", callback_data: "cancel" }]
    ],
  };
}

// ======================
// Routes
// ======================
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Telegram webhook endpoint
app.post("/telegram/webhook", async (req, res) => {
  // ВАЖНО: сразу ответить 200, чтобы Telegram не ретраил
  res.sendStatus(200);

  const update = req.body;

  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.log("Webhook handler error:", err?.message || err);
  }
});

// ======================
// Handlers
// ======================
async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  // Команды
  if (text === "/start") {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "✅ Render + Node работает.\n\nВыберите действие:",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text === "/getmyid") {
    const userId = message.from?.id;
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Ваш Telegram ID: ${userId}\nChat ID: ${chatId}`,
    });
    return;
  }

  // Пошаговая заявка
  const st = userState.get(chatId);

  if (!st) {
    // Ничего не ждем — показываем меню, чтобы не было “тишины”
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Меню:",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (st.step === "WAIT_PHONE") {
    st.data.client_phone = text;
    st.step = "WAIT_CITY";
    userState.set(chatId, st);

    await tg("sendMessage", {
      chat_id: chatId,
      text: "🏙 Укажите город клиента:",
    });
    return;
  }

  if (st.step === "WAIT_CITY") {
    st.data.city = text;
    st.step = "WAIT_TARIFF";
    userState.set(chatId, st);

    await tg("sendMessage", {
      chat_id: chatId,
      text: "📦 Укажите тариф/опции (например: FMB920 + реле):",
    });
    return;
  }

  if (st.step === "WAIT_TARIFF") {
    st.data.plan_tariff = text;

    // Пока просто финалим (позже — запись в Google Sheets)
    const summary =
      `✅ Заявка собрана:\n` +
      `📞 Телефон: ${st.data.client_phone}\n` +
      `🏙 Город: ${st.data.city}\n` +
      `📦 Тариф/опции: ${st.data.plan_tariff}\n\n` +
      `Дальше подключим Google Sheets и назначение мастера.`;

    userState.delete(chatId);

    await tg("sendMessage", {
      chat_id: chatId,
      text: summary,
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // Если неизвестный step
  userState.delete(chatId);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Состояние сброшено. Откройте меню:",
    reply_markup: mainMenuKeyboard(),
  });
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  // Чтобы Telegram убрал “часики”
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (data === "getmyid") {
    const userId = cb.from?.id;
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Ваш Telegram ID: ${userId}\nChat ID: ${chatId}`,
    });
    return;
  }

  if (data === "cancel") {
    userState.delete(chatId);
    await tg("sendMessage", {
      chat_id: chatId,
      text: "❌ Отменено.",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (data === "new_request") {
    // стартуем FSM
    userState.set(chatId, { step: "WAIT_PHONE", data: {} });

    await tg("sendMessage", {
      chat_id: chatId,
      text: "📝 Новая заявка.\n📞 Введите номер телефона клиента:",
    });
    return;
  }

  // неизвестная кнопка
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Неизвестное действие. Меню:",
    reply_markup: mainMenuKeyboard(),
  });
}

// ======================
// Start server
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server started on port ${PORT}`));
