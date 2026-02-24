const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// =============================
// ENV
// =============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN not found in environment variables");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// =============================
const MASTERS = [
  { tgId: 7862998301, name: "Абдухалим", city: "Душанбе" },
  { tgId: 7692783802, name: "Иброхимчон", city: "Худжанд" },
  { tgId: 6771517500, name: "Акаи Шухрат", city: "Бохтар" },
];

// Опции (выбирает АДМИН)
const OPTIONS = [
  "FMB920",
  "FMB140",
  "FMB140+Temp.",
  "FMB125+DUT",
  "FMB125+Temp.",
  "Video",
  "Другое",
];

// =============================
// In-memory storage (для теста)
// Потом заменим на Google Sheets.
// =============================
let lastOrderId = 0;
const orders = new Map();    // orderId -> order
const userState = new Map(); // chatId -> { step, data }
const dedupe = new Map();    // update_id -> ts

function nowTs() {
  return Date.now();
}

function cleanupDedupe() {
  const ttl = 60 * 1000; // 1 minute
  const t = nowTs();
  for (const [k, v] of dedupe.entries()) {
    if (t - v > ttl) dedupe.delete(k);
  }
}

function setState(chatId, step, data = {}) {
  userState.set(String(chatId), { step, data });
}
function getState(chatId) {
  return userState.get(String(chatId)) || null;
}
function clearState(chatId) {
  userState.delete(String(chatId));
}

// =============================
// Telegram helpers
// =============================
async function tg(method, payload) {
  return axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 20000 });
}

async function sendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
}

async function answerCb(callbackQueryId) {
  return tg("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

// =============================
// UI builders
// =============================

// ✅ Главное меню — Reply Keyboard (кнопки прямо в строке ввода, без /start)
function mainMenuReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "📝 Новая заявка (монтаж)" }, { text: "🧰 Ремонт / другое" }],
      [{ text: "🆔 Мой ID" }, { text: "❌ Отмена" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    selective: false,
  };
}

// Inline keyboards (для выбора)
function mastersKeyboard() {
  const rows = MASTERS.map((m) => [
    { text: `📍 ${m.city} | 👷 ${m.name}`, callback_data: `ADMIN_PICK_MASTER:${m.tgId}` },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function orderTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛠 Монтаж", callback_data: "ADMIN_TYPE:INSTALL" }],
      [{ text: "🧰 Ремонт / другое", callback_data: "ADMIN_TYPE:REPAIR" }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

function logisticsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🚗 Выезд к клиенту", callback_data: "ADMIN_LOG:VISIT" }],
      [{ text: "🏢 Клиент сам приедет", callback_data: "ADMIN_LOG:COME" }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

// ✅ FIX: передаём индекс опции, а не текст (чтобы работали FMB140+Temp. и т.п.)
function optionsKeyboard(orderId) {
  const rows = [];
  for (let i = 0; i < OPTIONS.length; i += 2) {
    const row = [
      { text: OPTIONS[i], callback_data: `ADMIN_OPT:${orderId}:${i}` },
    ];
    if (OPTIONS[i + 1]) {
      row.push({ text: OPTIONS[i + 1], callback_data: `ADMIN_OPT:${orderId}:${i + 1}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

// =============================
// Routes
// =============================
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

app.post("/telegram/webhook", async (req, res) => {
  // IMPORTANT: respond fast
  res.sendStatus(200);

  try {
    const update = req.body || {};
    cleanupDedupe();

    // DEDUPE update_id
    if (typeof update.update_id === "number") {
      if (dedupe.has(update.update_id)) return;
      dedupe.set(update.update_id, nowTs());
    }

    if (update.message) await onMessage(update.message);
    if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error("Webhook error:", e?.message || e);
  }
});

// =============================
// Handlers
// =============================
async function onMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  // Команды оставим, но меню выдаём без /start
  if (text === "/start") {
    await sendMessage(chatId, "✅ Меню активировано.", { reply_markup: mainMenuReplyKeyboard() });
    return;
  }
  if (text === "/getmyid") {
    await sendMessage(chatId, `Ваш Telegram ID: ${message.from?.id}\nChat ID: ${chatId}`, {
      reply_markup: mainMenuReplyKeyboard(),
    });
    return;
  }

  // Кнопки (Reply Keyboard) — работают как обычный текст
  if (text === "🆔 Мой ID") {
    await sendMessage(chatId, `Ваш Telegram ID: ${message.from?.id}\nChat ID: ${chatId}`, {
      reply_markup: mainMenuReplyKeyboard(),
    });
    return;
  }

  if (text === "❌ Отмена") {
    clearState(chatId);
    await sendMessage(chatId, "❌ Отменено.", { reply_markup: mainMenuReplyKeyboard() });
    return;
  }

  if (text === "📝 Новая заявка (монтаж)") {
    setState(chatId, "ADMIN_WAIT_PHONE", { presetType: "INSTALL" });
    await sendMessage(chatId, "📞 Введите номер телефона клиента:", { reply_markup: mainMenuReplyKeyboard() });
    return;
  }

  if (text === "🧰 Ремонт / другое") {
    setState(chatId, "ADMIN_WAIT_PHONE", { presetType: "REPAIR" });
    await sendMessage(chatId, "📞 Введите номер телефона клиента:", { reply_markup: mainMenuReplyKeyboard() });
    return;
  }

  // FSM
  const st = getState(chatId);
  if (!st) {
    // Если человек написал что-то без процесса — просто покажем меню
    await sendMessage(chatId, "Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
    return;
  }

  // ADMIN: ждём телефон
  if (st.step === "ADMIN_WAIT_PHONE") {
    st.data.phone = text;
    setState(chatId, "ADMIN_WAIT_MASTER", st.data);
    await sendMessage(chatId, "Выберите мастера (город подтянется автоматически):", {
      reply_markup: { remove_keyboard: true }, // чтобы не мешало во время выбора inline
    });
    await sendMessage(chatId, "Список мастеров:", { reply_markup: mastersKeyboard() });
    return;
  }

  // ADMIN: ждём адрес (только при выезде)
  if (st.step === "ADMIN_WAIT_ADDRESS") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    order.address = text;

    // дальше: REPAIR -> comment, INSTALL -> options
    if (order.type === "REPAIR") {
      setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
      await sendMessage(
        chatId,
        `🧰 Ремонт / другое\n🚗 Выезд к клиенту\n📍 Адрес: ${order.address}\n\n✍️ Напишите комментарий (что сломано / что нужно сделать):`,
        { reply_markup: mainMenuReplyKeyboard() }
      );
      return;
    }

    setState(chatId, "ADMIN_WAIT_OPTION", { orderId });
    await sendMessage(
      chatId,
      `🛠 Монтаж\n🚗 Выезд к клиенту\n📍 Адрес: ${order.address}\n\nВыберите опцию:`,
      { reply_markup: optionsKeyboard(orderId) }
    );
    return;
  }

  // ADMIN: ждём комментарий (для монтажа/ремонта/другого)
  if (st.step === "ADMIN_WAIT_COMMENT") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    order.adminComment = text;
    order.status = "SENT_TO_MASTER";

    clearState(chatId);

    // отправка мастеру
    await sendOrderToMaster(order);

    // подтверждение админу
    await sendMessage(chatId, formatAdminConfirm(order), { reply_markup: mainMenuReplyKeyboard() });
    return;
  }

  // если шаг неизвестен — сброс
  clearState(chatId);
  await sendMessage(chatId, "⚠️ Сессия сброшена. Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
}

async function onCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data || "";

  await answerCb(cb.id);

  // Cancel
  if (data === "CANCEL") {
    clearState(chatId);
    await editMessage(chatId, messageId, "❌ Отменено.");
    await sendMessage(chatId, "Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
    return;
  }

  // ADMIN: picked master
  if (data.startsWith("ADMIN_PICK_MASTER:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_MASTER") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    const masterTgId = Number(data.split(":")[1]);
    const master = MASTERS.find((m) => Number(m.tgId) === masterTgId);
    if (!master) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Мастер не найден.", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    const orderId = String(++lastOrderId);
    const order = {
      id: orderId,
      createdAt: new Date().toISOString(),
      phone: st.data.phone,

      masterTgId: master.tgId,
      masterName: master.name,
      city: master.city,

      type: st.data.presetType || null, // INSTALL | REPAIR
      logistics: null,                  // VISIT | COME
      address: "",                      // адрес при VISIT

      option: null,                     // для INSTALL
      adminComment: "",

      status: "NEW",
    };
    orders.set(orderId, order);

    // Если тип уже задан кнопкой меню — сразу логистика
    if (order.type) {
      setState(chatId, "ADMIN_WAIT_LOGISTICS", { orderId });
      await editMessage(
        chatId,
        messageId,
        `✅ Мастер выбран.\n📍 Город: ${order.city}\n👷 Мастер: ${order.masterName}\n\nВыберите логистику (выезд/сам приедет):`,
        { reply_markup: logisticsKeyboard() }
      );
      return;
    }

    // Иначе — сначала спросим тип
    setState(chatId, "ADMIN_WAIT_TYPE", { orderId });
    await editMessage(
      chatId,
      messageId,
      `✅ Мастер выбран.\n📍 Город: ${order.city}\n👷 Мастер: ${order.masterName}\n\nВыберите тип заявки:`,
      { reply_markup: orderTypeKeyboard() }
    );
    return;
  }

  // ADMIN: picked type
  if (data.startsWith("ADMIN_TYPE:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_TYPE") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    order.type = data.split(":")[1]; // INSTALL | REPAIR

    // ✅ после типа — всегда логистика
    setState(chatId, "ADMIN_WAIT_LOGISTICS", { orderId });
    await editMessage(
      chatId,
      messageId,
      `✅ Тип выбран: ${order.type === "REPAIR" ? "Ремонт / другое" : "Монтаж"}\n\nВыберите логистику:`,
      { reply_markup: logisticsKeyboard() }
    );
    return;
  }

  // ADMIN: picked logistics
  if (data.startsWith("ADMIN_LOG:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_LOGISTICS") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    order.logistics = data.split(":")[1]; // VISIT | COME

    // ✅ Если выезд — сначала адрес
    if (order.logistics === "VISIT") {
      setState(chatId, "ADMIN_WAIT_ADDRESS", { orderId });
      await editMessage(chatId, messageId, "🚗 Выезд к клиенту\n\n📍 Укажите адрес клиента:", {
        reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] },
      });
      return;
    }

    // ✅ Если клиент сам приедет — адрес не нужен
    if (order.type === "REPAIR") {
      setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
      await editMessage(
        chatId,
        messageId,
        `🧰 Ремонт / другое\n🏢 Клиент сам приедет\n\n✍️ Напишите комментарий (что сломано / что нужно сделать):`,
        { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] } }
      );
      return;
    }

    // INSTALL -> options
    setState(chatId, "ADMIN_WAIT_OPTION", { orderId });
    await editMessage(chatId, messageId, "🛠 Монтаж\n🏢 Клиент сам приедет\n\nВыберите опцию:", {
      reply_markup: optionsKeyboard(orderId),
    });
    return;
  }

  // ✅ FIX: ADMIN: picked option (берём индекс, а не текст)
  if (data.startsWith("ADMIN_OPT:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_OPTION") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    const parts = data.split(":");
    const orderId = parts[1];
    const optIndex = Number(parts[2]);

    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    const option = OPTIONS[optIndex];
    if (!option) {
      await sendMessage(chatId, "⚠️ Опция не найдена. Проверь массив OPTIONS.", { reply_markup: mainMenuReplyKeyboard() });
      return;
    }

    order.option = option;

    // после выбора опции — ВСЕГДА комментарий админа
    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });

    const hint =
      "✍️ Напишите комментарий.\n" +
      "Например: «2 устройства: FMB920 + FMB125, поставить реле, SIM клиента, серийники позже»\n" +
      "или «Другая модель: …»";

    await editMessage(chatId, messageId, `✅ Опция выбрана: ${order.option}\n\n${hint}`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] },
    });
    return;
  }
}

// =============================
// Formatting / sending
// =============================
function typeLabel(order) {
  return order.type === "REPAIR" ? "🧰 Ремонт / другое" : "🛠 Монтаж";
}

function logisticsLabel(order) {
  if (order.logistics === "VISIT") return "🚗 Выезд к клиенту";
  if (order.logistics === "COME") return "🏢 Клиент сам приедет";
  return "-";
}

function formatOrderForMaster(order) {
  const optLine = order.type === "INSTALL" ? `📦 Опция: ${order.option || "-"}` : "";
  const addrLine = order.logistics === "VISIT" ? `📍 Адрес: ${order.address || "-"}` : "";
  const commentLine = `💬 Комментарий:\n${order.adminComment || "-"}`;

  return (
    `${typeLabel(order)} #${order.id}\n` +
    `📞 Телефон: ${order.phone}\n` +
    `📍 Город: ${order.city}\n` +
    `👷 Мастер: ${order.masterName}\n` +
    `🚗/🏢: ${logisticsLabel(order)}\n` +
    (addrLine ? `${addrLine}\n` : "") +
    (optLine ? `${optLine}\n` : "") +
    `\n${commentLine}`
  );
}

function formatAdminConfirm(order) {
  const optLine = order.type === "INSTALL" ? `📦 Опция: ${order.option || "-"}` : "";
  const addrLine = order.logistics === "VISIT" ? `📍 Адрес: ${order.address || "-"}` : "";

  return (
    `✅ Заявка #${order.id} отправлена мастеру.\n` +
    `📞 Телефон: ${order.phone}\n` +
    `📍 Город: ${order.city}\n` +
    `👷 Мастер: ${order.masterName}\n` +
    `🧾 Тип: ${order.type === "REPAIR" ? "Ремонт / другое" : "Монтаж"}\n` +
    `🚗/🏢: ${logisticsLabel(order)}\n` +
    (addrLine ? `${addrLine}\n` : "") +
    (optLine ? `${optLine}\n` : "") +
    `💬 Комментарий: ${order.adminComment || "-"}`
  );
}

async function sendOrderToMaster(order) {
  const text = formatOrderForMaster(order);
  await sendMessage(order.masterTgId, text, { reply_markup: mainMenuReplyKeyboard() });
}

// =============================
// Start server
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server started on port ${PORT}`));
