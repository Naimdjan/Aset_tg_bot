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
// CONFIG: Masters
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
// In-memory storage 
// (На платном Render данные будут храниться до следующего деплоя)
// =============================
let lastOrderId = 0;
const orders = new Map(); // orderId -> order
const userState = new Map(); // chatId -> { step, data }
const dedupe = new Map(); // update_id -> ts

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
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📝 Новая заявка", callback_data: "ADMIN_NEW" }],
      [{ text: "🆔 Мой ID", callback_data: "GET_MY_ID" }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

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

function optionsKeyboard(orderId) {
  const rows = [];
  for (let i = 0; i < OPTIONS.length; i += 2) {
    const a = OPTIONS[i];
    const b = OPTIONS[i + 1];
    const row = [{ text: a, callback_data: `ADMIN_OPT:${orderId}:${a}` }];
    if (b) row.push({ text: b, callback_data: `ADMIN_OPT:${orderId}:${b}` });
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

  // Commands
  if (text === "/start") {
    await sendMessage(chatId, "👋 Привет! Главное меню активировано.", { reply_markup: mainMenuKeyboard() });
    return;
  }
  if (text === "/getmyid") {
    await sendMessage(chatId, `Ваш Telegram ID: ${message.from?.id}\nChat ID: ${chatId}`);
    return;
  }

  // FSM
  const st = getState(chatId);
  if (!st) return;

  // ADMIN: ждём телефон
  if (st.step === "ADMIN_WAIT_PHONE") {
    st.data.phone = text;
    setState(chatId, "ADMIN_WAIT_ADDRESS", st.data);
    await sendMessage(
      chatId, 
      "📍 Введите точный адрес клиента (улица, дом, ориентир):", 
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] } }
    );
    return;
  }

  // ADMIN: ждём адрес
  if (st.step === "ADMIN_WAIT_ADDRESS") {
    st.data.address = text;
    setState(chatId, "ADMIN_WAIT_MASTER", st.data);
    await sendMessage(chatId, "Выберите мастера (город подтянется автоматически):", { reply_markup: mastersKeyboard() });
    return;
  }

  // ADMIN: ждём комментарий (для монтажа/ремонта/другого)
  if (st.step === "ADMIN_WAIT_COMMENT") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    order.adminComment = text;
    order.status = "SENT_TO_MASTER";

    clearState(chatId);

    // отправка мастеру
    await sendOrderToMaster(order);

    // подтверждение админу
    await sendMessage(
      chatId,
      formatAdminConfirm(order),
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }
}

async function onCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data || "";

  await answerCb(cb.id);

  // Cancel
  if (data === "CANCEL") {
    clearState(chatId);
    await editMessage(chatId, messageId, "❌ Отменено.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data === "GET_MY_ID") {
    await sendMessage(chatId, `Ваш Telegram ID: ${cb.from.id}\nChat ID: ${chatId}`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  // ADMIN: New order
  if (data === "ADMIN_NEW") {
    setState(chatId, "ADMIN_WAIT_PHONE", {});
    await editMessage(
      chatId,
      messageId,
      "📞 Введите номер телефона клиента:",
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] } }
    );
    return;
  }

  // ADMIN: picked master
  if (data.startsWith("ADMIN_PICK_MASTER:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_MASTER") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Нажмите «Новая заявка».", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const masterTgId = Number(data.split(":")[1]);
    const master = MASTERS.find((m) => Number(m.tgId) === masterTgId);
    if (!master) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Мастер не найден.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const orderId = String(++lastOrderId);
    const order = {
      id: orderId,
      createdAt: new Date().toISOString(),
      phone: st.data.phone,
      address: st.data.address,

      masterTgId: master.tgId,
      masterName: master.name,
      city: master.city,

      type: null,          // INSTALL | REPAIR
      option: null,        // для INSTALL
      adminComment: "",

      status: "NEW",
    };
    orders.set(orderId, order);

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
      await sendMessage(chatId, "⚠️ Сессия устарела. Нажмите «Новая заявка».", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const type = data.split(":")[1];
    order.type = type;

    if (type === "REPAIR") {
      // ремонт: сразу просим комментарий
      setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
      await editMessage(
        chatId,
        messageId,
        `🧰 Ремонт / другое\n\nНапишите комментарий (что сломано / что нужно сделать):`,
        { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] } }
      );
      return;
    }

    if (type === "INSTALL") {
      // монтаж: админ выбирает опцию
      setState(chatId, "ADMIN_WAIT_OPTION", { orderId });
      await editMessage(
        chatId,
        messageId,
        "🛠 Монтаж\n\nВыберите опцию:",
        { reply_markup: optionsKeyboard(orderId) }
      );
      return;
    }
  }

  // ADMIN: picked option
  if (data.startsWith("ADMIN_OPT:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_OPTION") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Нажмите «Новая заявка».", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const parts = data.split(":");
    const orderId = parts[1];
    const option = parts.slice(2).join(":");

    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    order.option = option;

    // после выбора опции — ВСЕГДА комментарий админа (несколько устройств/модель/доп. работы)
    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });

    const hint =
      "✍️ Напишите комментарий.\n" +
      "Например: «2 устройства: FMB920 + FMB125, поставить реле, SIM клиента, серийники позже»\n" +
      "или «Другая модель: …»";

    await editMessage(
      chatId,
      messageId,
      `✅ Опция выбрана: ${order.option}\n\n${hint}`,
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] } }
    );
    return;
  }
}

// =============================
// Formatting / sending
// =============================
function formatOrderForMaster(order) {
  const typeLabel = order.type === "REPAIR" ? "🧰 Ремонт / другое" : "🛠 Монтаж";
  const optLine = order.type === "INSTALL" ? `📦 Опция: ${order.option || "-"}` : "";
  const commentLine = `💬 Комментарий:\n${order.adminComment || "-"}`;

  return (
    `${typeLabel} #${order.id}\n` +
    `📞 Телефон: ${order.phone}\n` +
    `📍 Город: ${order.city}\n` +
    `🏠 Адрес: ${order.address}\n` +
    `👷 Мастер: ${order.masterName}\n` +
    (optLine ? `${optLine}\n` : "") +
    `\n${commentLine}`
  );
}

function formatAdminConfirm(order) {
  const typeLabel = order.type === "REPAIR" ? "Ремонт/другое" : "Монтаж";
  const optLine = order.type === "INSTALL" ? `📦 Опция: ${order.option || "-"}` : "";
  return (
    `✅ Заявка #${order.id} отправлена мастеру.\n` +
    `📞 Телефон: ${order.phone}\n` +
    `📍 Город: ${order.city}\n` +
    `🏠 Адрес: ${order.address}\n` +
    `👷 Мастер: ${order.masterName}\n` +
    `🧾 Тип: ${typeLabel}\n` +
    (optLine ? `${optLine}\n` : "") +
    `💬 Комментарий: ${order.adminComment || "-"}`
  );
}

async function sendOrderToMaster(order) {
  const text = formatOrderForMaster(order);
  await sendMessage(order.masterTgId, text, { reply_markup: mainMenuKeyboard() });
}

// =============================
// Start server
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server started on port ${PORT}`));
