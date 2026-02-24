const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ======================
// ENV
// ======================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN not found in environment variables");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ======================

const MASTERS = [
  { id: "abdulakhim", name: "Абдулaхим", city: "Худжанд", telegramId: 7862998301 },
  { id: "ibrohimjon", name: "Иброхимчон", city: "Душанбе", telegramId: 7692783802 },
  { id: "akali",      name: "Акаи Шухрат", city: "Бохтар", telegramId: 7862998301 }
];

// ======================
// Simple in-memory state
// ======================
const userState = new Map(); // chatId -> { step, data }

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
    ]
  };
}

function mastersKeyboard() {
  // Кнопки мастеров: Город | Имя
  const rows = MASTERS.map((m) => ([
    { text: `📍 ${m.city} | 👷 ${m.name}`, callback_data: `pick_master:${m.id}` }
  ]));

  // В конце добавим "Отмена"
  rows.push([{ text: "❌ Отмена", callback_data: "cancel" }]);

  return { inline_keyboard: rows };
}

function getMasterById(masterId) {
  return MASTERS.find((m) => m.id === masterId) || null;
}

// ======================
// Routes
// ======================
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

app.post("/telegram/webhook", async (req, res) => {
  // ВАЖНО: сразу 200, чтобы Telegram не ретраил
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
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  if (text === "/getmyid") {
    const userId = message.from?.id;
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Ваш Telegram ID: ${userId}\nChat ID: ${chatId}`
    });
    return;
  }

  // FSM
  const st = userState.get(chatId);

  if (!st) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Меню:",
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  // Шаг 1: телефон
  if (st.step === "WAIT_PHONE") {
    st.data.client_phone = text;
    st.step = "WAIT_OPTIONS";
    userState.set(chatId, st);

    await tg("sendMessage", {
      chat_id: chatId,
      text: "📦 Укажите *опции* (например: FMB920 + реле):",
      parse_mode: "Markdown"
    });
    return;
  }

  // Шаг 2: опции -> выбор мастера (город подтянется по мастеру)
  if (st.step === "WAIT_OPTIONS") {
    st.data.options = text;
    st.step = "WAIT_MASTER";
    userState.set(chatId, st);

    if (!MASTERS.length) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ В коде не заполнен список мастеров (MASTERS)."
      });
      userState.delete(chatId);
      return;
    }

    await tg("sendMessage", {
      chat_id: chatId,
      text: "🗺 Выберите мастера (город подтянется автоматически):",
      reply_markup: mastersKeyboard()
    });
    return;
  }

  // Если мы ждём мастера, а админ пишет текст — просто напомним
  if (st.step === "WAIT_MASTER") {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Нужно выбрать мастера кнопкой ниже 👇",
      reply_markup: mastersKeyboard()
    });
    return;
  }

  // fallback
  userState.delete(chatId);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Состояние сброшено. Меню:",
    reply_markup: mainMenuKeyboard()
  });
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  // убрать "часики"
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (data === "getmyid") {
    const userId = cb.from?.id;
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Ваш Telegram ID: ${userId}\nChat ID: ${chatId}`
    });
    return;
  }

  if (data === "cancel") {
    userState.delete(chatId);
    await tg("sendMessage", {
      chat_id: chatId,
      text: "❌ Отменено.",
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  if (data === "new_request") {
    userState.set(chatId, { step: "WAIT_PHONE", data: {} });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "📝 Новая заявка.\n📞 Введите номер телефона клиента:"
    });
    return;
  }

  // Выбор мастера
  if (data.startsWith("pick_master:")) {
    const st = userState.get(chatId);
    if (!st || st.step !== "WAIT_MASTER") {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Сначала создайте заявку: нажмите 📝 Новая заявка",
        reply_markup: mainMenuKeyboard()
      });
      return;
    }

    const masterId = data.split(":")[1];
    const master = getMasterById(masterId);

    if (!master) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Мастер не найден. Проверь список MASTERS в коде."
      });
      return;
    }

    // город подтягиваем из мастера
    st.data.master_name = master.name;
    st.data.city = master.city;
    st.data.master_telegram_id = master.telegramId;

    // Итог
    const summary =
      `✅ Заявка собрана:\n` +
      `📞 Телефон: ${st.data.client_phone}\n` +
      `📍 Город: ${st.data.city}\n` +
      `👷 Мастер: ${st.data.master_name}\n` +
      `📦 Опции: ${st.data.options}\n\n` +
      `Дальше подключим Google Sheets и отправку мастеру.`;

    userState.delete(chatId);

    await tg("sendMessage", {
      chat_id: chatId,
      text: summary,
      reply_markup: mainMenuKeyboard()
    });

    // (следующий шаг позже): отправить мастеру уведомление
    // await tg("sendMessage", { chat_id: master.telegramId, text: `🛠 Новая заявка...\n...` });

    return;
  }

  // неизвестная кнопка
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Неизвестное действие. Меню:",
    reply_markup: mainMenuKeyboard()
  });
}

// ======================
// Start
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server started on port ${PORT}`));
