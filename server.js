require("dotenv").config();
const express = require("express");
const axios = require("axios");
const XLSX = require("xlsx");
const path = require("path");
const os = require("os");
const fs = require("fs");

const app = express();
app.use(express.json());

// =============================
// ENV
// =============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN not found in environment variables");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Пароль для доступа к боту (если задан — после /start нужно ввести пароль)
const BOT_PASSWORD = (process.env.BOT_PASSWORD || "").trim().replace(/\r$/, "");
const authorizedChatIds = new Set(); // chatId строкой

function isAuthorized(chatId) {
  return authorizedChatIds.has(String(chatId));
}
function setAuthorized(chatId) {
  authorizedChatIds.add(String(chatId));
}

// =============================
// Главный администратор (получает уведомления, отчёты)
const MAIN_ADMIN_ID = 7862998301;

const MASTERS = [
  { tgId: 7692783802, name: "Иброхимчон", city: "Худжанд" },
  { tgId: 6771517500, name: "Акаи Шухрат", city: "Бохтар" },
  { tgId: 1987607156, name: "Азизчон", city: "Худжанд" },
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
// Потом заменим на GitHub (или другое хранилище).
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

async function sendPhoto(chatId, fileId, caption) {
  return tg("sendPhoto", { chat_id: chatId, photo: fileId, caption });
}

async function sendDocument(chatId, filePath, caption) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", fs.createReadStream(filePath));
  if (caption) form.append("caption", caption);
  return axios.post(`${TELEGRAM_API}/sendDocument`, form, {
    headers: form.getHeaders(),
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}

// =============================
// UI builders
// =============================

// ✅ Главное меню — Reply Keyboard (кнопки прямо в строке ввода, без /start)
function adminMenuReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "📝 Новая заявка (монтаж)" }, { text: "🧰 Ремонт / другое" }],
      [{ text: "🆔 Мой ID" }, { text: "❌ Отмена" }],
      [{ text: "📊 Отчёт" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    selective: false,
  };
}

function masterMenuReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "📊 Отчёт" }],
      [{ text: "🆔 Мой ID" }, { text: "❌ Отмена" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    selective: false,
  };
}

function isMasterChat(chatId) {
  return MASTERS.some((m) => String(m.tgId) === String(chatId));
}

function menuKeyboardForChat(chatId) {
  return isMasterChat(chatId) ? masterMenuReplyKeyboard() : adminMenuReplyKeyboard();
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

// Клавиатура выбора периода отчёта
function reportPeriodKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📅 Текущий месяц", callback_data: "REPORT_PERIOD:THIS_MONTH" },
        { text: "📅 Прошлый месяц", callback_data: "REPORT_PERIOD:LAST_MONTH" },
      ],
      [{ text: "📅 Последние 7 дней", callback_data: "REPORT_PERIOD:LAST_7" }],
      [{ text: "📅 Свой период", callback_data: "REPORT_PERIOD:CUSTOM" }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

// Клавиатура для мастера по заявке
function masterOrderKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "✅ Беру заявку", callback_data: `MASTER_ACCEPT:${orderId}` }],
      [{ text: "❌ Не могу", callback_data: `MASTER_DECLINE:${orderId}` }],
    ],
  };
}

// Кнопки для фото по прибытии клиента: фото или «Без номера»/«Без пробега»
function masterArrivalPhotoKeyboard(orderId, order) {
  const rows = [];
  const hasNumber = order.carNumberPhotoId || order.carNumberSkipped;
  const hasOdometer = order.odometerPhotoId || order.odometerSkipped;
  const hasDevice = !!order.devicePhotoId;

  if (!hasNumber) {
    rows.push([
      { text: "📷 Фото номера", callback_data: `MASTER_PHOTO:${orderId}:PLATE` },
      { text: "⏭ Без номера", callback_data: `MASTER_SKIP:${orderId}:PLATE` },
    ]);
  }
  if (!hasOdometer) {
    rows.push([
      { text: "📷 Фото пробега", callback_data: `MASTER_PHOTO:${orderId}:ODOMETER` },
      { text: "⏭ Без пробега", callback_data: `MASTER_SKIP:${orderId}:ODOMETER` },
    ]);
  }
  if (!hasDevice) {
    rows.push([{ text: "📷 Фото устройства", callback_data: `MASTER_PHOTO:${orderId}:DEVICE` }]);
  }
  if (rows.length === 0) return null;
  return { inline_keyboard: rows };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatYyyymm(y, m) {
  return `${y}${pad2(m)}`; // m: 1..12
}

function parseYyyymm(yyyymm) {
  const m = String(yyyymm).match(/^(\d{4})(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!y || mo < 1 || mo > 12) return null;
  return { y, mo };
}

function parseYyyymmdd(yyyymmdd) {
  const m = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

const MONTH_SHORT = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];

function monthLabelShort(y, mo) {
  return `${MONTH_SHORT[mo - 1]} ${y}`;
}

// Компактный календарь: без заголовка дней недели, короткое название месяца
function masterCalendarKeyboard(orderId, yyyymm) {
  const parsed = parseYyyymm(yyyymm);
  const now = new Date();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;

  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const jsDow = first.getDay();
  const dow = (jsDow + 6) % 7;

  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const prevYyyymm = formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1);
  const nextYyyymm = formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1);

  const rows = [];
  rows.push([
    { text: "‹", callback_data: `MN:${orderId}:${prevYyyymm}` },
    { text: monthLabelShort(year, month), callback_data: "NOOP" },
    { text: "›", callback_data: `MN:${orderId}:${nextYyyymm}` },
  ]);

  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if (week === 0 && i < dow) {
        row.push({ text: "·", callback_data: "NOOP" });
        continue;
      }
      if (day > daysInMonth) {
        row.push({ text: "·", callback_data: "NOOP" });
        continue;
      }
      const yyyymmdd = `${year}${pad2(month)}${pad2(day)}`;
      row.push({ text: String(day), callback_data: `MD:${orderId}:${yyyymmdd}` });
      day++;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }

  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function masterHourKeyboard(orderId, yyyymmdd) {
  const hours = [];
  for (let h = 8; h <= 20; h++) hours.push(h);
  const rows = [];
  for (let i = 0; i < hours.length; i += 4) {
    rows.push(
      hours.slice(i, i + 4).map((h) => ({
        text: `${pad2(h)}:00`,
        callback_data: `MH:${orderId}:${yyyymmdd}:${pad2(h)}`,
      }))
    );
  }
  rows.push([{ text: "⬅ Дата", callback_data: `MB:${orderId}:${yyyymmdd.slice(0, 6)}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
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

  // Если включён пароль — проверяем доступ
  if (BOT_PASSWORD) {
    const st = getState(chatId);
    if (!isAuthorized(chatId)) {
      if (text.startsWith("/start")) {
        setState(chatId, "WAIT_PASSWORD", {});
        await sendMessage(chatId, "🔐 Введите пароль для доступа к боту:");
        return;
      }
      if (st && st.step === "WAIT_PASSWORD") {
        const enteredPassword = text.replace(/\r$/, "").trim();
        if (enteredPassword === BOT_PASSWORD) {
          setAuthorized(chatId);
          clearState(chatId);
          await sendMessage(chatId, "✅ Доступ разрешён. Меню активировано.", {
            reply_markup: menuKeyboardForChat(chatId),
          });
          return;
        }
        await sendMessage(chatId, "❌ Неверный пароль. Нажмите /start и введите пароль снова.");
        return;
      }
      await sendMessage(chatId, "🔐 Доступ закрыт. Введите /start и укажите пароль.");
      return;
    }
  }

  // Команды оставим, но меню выдаём без /start
  if (text === "/start") {
    await sendMessage(chatId, "✅ Меню активировано.", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }
  if (text === "/getmyid") {
    await sendMessage(chatId, `Ваш Telegram ID: ${message.from?.id}\nChat ID: ${chatId}`, {
      reply_markup: menuKeyboardForChat(chatId),
    });
    return;
  }

  // Кнопки (Reply Keyboard) — работают как обычный текст
  if (text === "🆔 Мой ID") {
    await sendMessage(chatId, `Ваш Telegram ID: ${message.from?.id}\nChat ID: ${chatId}`, {
      reply_markup: menuKeyboardForChat(chatId),
    });
    return;
  }

  if (text === "❌ Отмена") {
    clearState(chatId);
    await sendMessage(chatId, "❌ Отменено.", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  if (text === "📊 Отчёт") {
    const isMaster = isMasterChat(chatId);
    const scope = isMaster ? "MASTER" : "ADMIN";
    const masterTgId = isMaster ? chatId : null;

    setState(chatId, "REPORT_WAIT_PERIOD", { scope, masterTgId });
    await sendMessage(chatId, "📊 Выберите период отчёта:", {
      reply_markup: reportPeriodKeyboard(),
    });
    return;
  }

  if (text === "📝 Новая заявка (монтаж)") {
    setState(chatId, "ADMIN_WAIT_PHONE", { presetType: "INSTALL" });
    await sendMessage(chatId, "📞 Введите номер телефона клиента:", { reply_markup: adminMenuReplyKeyboard() });
    return;
  }

  if (text === "🧰 Ремонт / другое") {
    setState(chatId, "ADMIN_WAIT_PHONE", { presetType: "REPAIR" });
    await sendMessage(chatId, "📞 Введите номер телефона клиента:", { reply_markup: adminMenuReplyKeyboard() });
    return;
  }

  // FSM
  const st = getState(chatId);
  if (!st) {
    // Если человек написал что-то без процесса — просто покажем меню
    await sendMessage(chatId, "Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  // ADMIN: ждём телефон
  if (st.step === "ADMIN_WAIT_PHONE") {
    st.data.phone = text;
    setState(chatId, "ADMIN_WAIT_MASTER", st.data);
    await sendMessage(chatId, "Выберите мастера (город подтянется автоматически):", {
      reply_markup: adminMenuReplyKeyboard(),
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
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard() });
      return;
    }

    order.address = text;

    // дальше: REPAIR -> comment, INSTALL -> options
    if (order.type === "REPAIR") {
      setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
      await sendMessage(
        chatId,
        `🧰 Ремонт / другое\n🚗 Выезд к клиенту\n📍 Адрес: ${order.address}\n\n✍️ Напишите комментарий (что сломано / что нужно сделать):`,
        { reply_markup: adminMenuReplyKeyboard() }
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
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard() });
      return;
    }

    order.adminComment = text;
    order.status = "SENT_TO_MASTER";

    clearState(chatId);

    // отправка мастеру
    await sendOrderToMaster(order);

    // подтверждение админу
    await sendMessage(chatId, formatAdminConfirm(order), { reply_markup: adminMenuReplyKeyboard() });
    return;
  }

  // MASTER: выбор времени делается через календарь/часы (см. callback-обработчики MN/MD/MH/MM)

  // MASTER: отправка фото по кнопке (номер / пробег / устройство)
  if (st.step === "MASTER_WAIT_PHOTO") {
    const orderId = st.data.orderId;
    const photoType = st.data.photoType;
    const order = orders.get(orderId);
    if (!order || order.masterTgId !== chatId) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена или принадлежит другому мастеру.", {
        reply_markup: masterMenuReplyKeyboard(),
      });
      return;
    }

    const photos = message.photo || [];
    if (!photos.length) {
      await sendMessage(chatId, "⚠️ Пожалуйста, отправьте именно фото.", {
        reply_markup: masterMenuReplyKeyboard(),
      });
      return;
    }

    const fileId = photos[photos.length - 1].file_id;
    if (photoType === "PLATE") order.carNumberPhotoId = fileId;
    else if (photoType === "ODOMETER") order.odometerPhotoId = fileId;
    else if (photoType === "DEVICE") order.devicePhotoId = fileId;

    const kb = masterArrivalPhotoKeyboard(orderId, order);
    if (kb) {
      clearState(chatId);
      await sendMessage(chatId, "✅ Фото сохранено. Выберите следующее или отправьте оставшиеся:", {
        reply_markup: kb,
      });
      return;
    }

    // Все фото/пропуски собраны — показываем кнопку «Выполнено»
    setState(chatId, "MASTER_WAIT_DONE", { orderId });
    await sendMessage(chatId, `✅ Все данные по заявке #${order.id} сохранены. Нажмите «✅ Выполнено» для завершения.`, {
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]],
      },
    });
    return;
  }


  if (st.step === "MASTER_WAIT_DONE") {
    await sendMessage(chatId, "Нажмите кнопку «✅ Выполнено» в сообщении выше.", {
      reply_markup: masterMenuReplyKeyboard(),
    });
    return;
  }

   // ADMIN: ждём ввод произвольного периода отчёта
  if (st.step === "REPORT_WAIT_RANGE") {
    const rangeText = text;
    const parsed = parseDateRange(rangeText);
    if (!parsed) {
      await sendMessage(
        chatId,
        "⚠️ Неверный формат периода.\nВведите в виде: 01.03.2026-31.03.2026",
        { reply_markup: menuKeyboardForChat(chatId) }
      );
      return;
    }

    const { from, to } = parsed;
    const scope = st.data.scope || "ADMIN";
    const masterTgId = st.data.masterTgId || null;

    clearState(chatId);
    await sendTextReport(chatId, from, to, { scope, masterTgId });
    return;
  }

  // если шаг неизвестен — сброс
  clearState(chatId);
  await sendMessage(chatId, "⚠️ Сессия сброшена. Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
}

async function onCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data || "";

  await answerCb(cb.id);

  if (BOT_PASSWORD && !isAuthorized(chatId)) {
    await sendMessage(chatId, "🔐 Доступ закрыт. Введите /start и укажите пароль.");
    return;
  }

  // Cancel — сброс текущего шага без пароля
  if (data === "CANCEL") {
    const st = getState(chatId);
    if (st && st.step === "ADMIN_WAIT_COMMENT") {
      await editMessage(
        chatId,
        messageId,
        "✍️ Напишите комментарий в чат.\nДля отмены заявки нажмите «❌ Отмена» в меню ниже."
      );
      return;
    }
    clearState(chatId);
    await editMessage(chatId, messageId, "❌ Отменено.");
    await sendMessage(chatId, "Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  // ADMIN: выбор периода отчёта
  if (data.startsWith("REPORT_PERIOD:")) {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_WAIT_PERIOD") {
      await sendMessage(chatId, "⚠️ Сессия отчёта устарела. Нажмите «📊 Отчёт» ещё раз.", {
        reply_markup: menuKeyboardForChat(chatId),
      });
      return;
    }

    const code = data.split(":")[1];
    const scope = st.data.scope || "ADMIN";
    const masterTgId = st.data.masterTgId || null;

    // Произвольный период — запросим ввод дат
    if (code === "CUSTOM") {
      setState(chatId, "REPORT_WAIT_RANGE", { scope, masterTgId });
      await editMessage(
        chatId,
        messageId,
        "📅 Введите период в формате:\n01.03.2026-31.03.2026",
        { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] } }
      );
      return;
    }

    const { from, to } = calcPresetPeriod(code);
    clearState(chatId);
    await editMessage(
      chatId,
      messageId,
      `📊 Отчёт за период ${formatDate(from)}–${formatDate(to)} формируется...`
    );
    await sendTextReport(chatId, from, to, { scope, masterTgId });
    return;
  }

  // Отправить отчёт в Excel (после просмотра текстового отчёта)
  if (data === "REPORT_EXCEL") {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_SENT" || st.data.fromTs == null || st.data.toTs == null) {
      await sendMessage(chatId, "⚠️ Сначала выберите период и сформируйте отчёт (📊 Отчёт).", {
        reply_markup: menuKeyboardForChat(chatId),
      });
      return;
    }
    const from = new Date(st.data.fromTs);
    const to = new Date(st.data.toTs);
    const scope = st.data.scope || "ADMIN";
    const masterTgId = st.data.masterTgId || null;
    let filePath;
    try {
      filePath = buildExcelReport(from, to, { scope, masterTgId });
      const caption = `📊 Отчёт ${formatDate(from)}–${formatDate(to)}`;
      await sendDocument(chatId, filePath, caption);
      fs.unlink(filePath, () => {});
    } catch (err) {
      console.error("Excel report error:", err);
      await sendMessage(chatId, "⚠️ Не удалось сформировать Excel. Попробуйте позже.", {
        reply_markup: menuKeyboardForChat(chatId),
      });
    }
    clearState(chatId);
    await sendMessage(chatId, "Готово. Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  // MASTER: берёт заявку
  if (data.startsWith("MASTER_ACCEPT:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", {
        reply_markup: masterMenuReplyKeyboard(),
      });
      return;
    }

    if (order.masterTgId !== cb.from.id) {
      await answerCb(cb.id);
      return;
    }

    order.status = "ACCEPTED_BY_MASTER";
    await editMessage(
      chatId,
      messageId,
      formatOrderForMaster(order) + "\n\n✅ Вы взяли эту заявку.",
    );

    const now = new Date();
    const yyyymm = formatYyyymm(now.getFullYear(), now.getMonth() + 1);
    setState(chatId, "MASTER_PICK_DATE", { orderId, yyyymm });
    await sendMessage(chatId, "📅 Выберите дату визита:", {
      reply_markup: masterCalendarKeyboard(orderId, yyyymm),
    });

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `✅ Мастер ${order.masterName} взял заявку #${order.id}.`,
        { reply_markup: adminMenuReplyKeyboard() }
      );
    }

    return;
  }

  // Пустые (служебные) кнопки календаря
  if (data === "NOOP") return;

  // MASTER: навигация по календарю
  if (data.startsWith("MN:")) {
    const [, orderId, yyyymm] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;
    setState(chatId, "MASTER_PICK_DATE", { orderId, yyyymm });
    await editMessage(chatId, messageId, "📅 Выберите дату визита:", {
      reply_markup: masterCalendarKeyboard(orderId, yyyymm),
    });
    return;
  }

  // MASTER: выбор даты
  if (data.startsWith("MD:")) {
    const [, orderId, yyyymmdd] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;
    setState(chatId, "MASTER_PICK_HOUR", { orderId, yyyymmdd });
    await editMessage(chatId, messageId, "🕒 Выберите час:", {
      reply_markup: masterHourKeyboard(orderId, yyyymmdd),
    });
    return;
  }

  // MASTER: выбор часа -> сразу финал (минуты не выбираем, всегда :00)
  if (data.startsWith("MH:")) {
    const [, orderId, yyyymmdd, hh] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    const d = parseYyyymmdd(yyyymmdd);
    if (!d) return;
    const timeText = `${pad2(d.d)}.${pad2(d.mo)}.${d.y} ${hh}:00`;

    order.masterSuggestedTimeText = timeText;
    order.status = "WAIT_ADMIN_CONFIRM_TIME";
    clearState(chatId);

    await editMessage(chatId, messageId, `✅ Предложено время: ${timeText}\n\nОтправлено администратору.`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] },
    });

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `🕒 Мастер ${order.masterName} предложил время для заявки #${order.id}:\n` +
          `⏰ ${order.masterSuggestedTimeText}\n\nПодтвердить?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Подтвердить время", callback_data: `ADMIN_CONFIRM_TIME:${order.id}` }],
              [{ text: "❌ Отмена", callback_data: "CANCEL" }],
            ],
          },
        }
      );
    }

    await sendMessage(chatId, "✅ Время отправлено администратору на подтверждение.", {
      reply_markup: masterMenuReplyKeyboard(),
    });
    return;
  }

  // MASTER: назад к дате (из выбора часа)
  if (data.startsWith("MB:")) {
    const [, orderId, yyyymm] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;
    setState(chatId, "MASTER_PICK_DATE", { orderId, yyyymm });
    await editMessage(chatId, messageId, "📅 Выберите дату визита:", {
      reply_markup: masterCalendarKeyboard(orderId, yyyymm),
    });
    return;
  }

  // MASTER: не может взять заявку
  if (data.startsWith("MASTER_DECLINE:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", {
        reply_markup: masterMenuReplyKeyboard(),
      });
      return;
    }

    if (order.masterTgId !== cb.from.id) {
      await answerCb(cb.id);
      return;
    }

    order.status = "DECLINED_BY_MASTER";
    await editMessage(
      chatId,
      messageId,
      formatOrderForMaster(order) + "\n\n❌ Вы отказались от этой заявки.",
    );

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `❌ Мастер ${order.masterName} отказался от заявки #${order.id}.`,
        { reply_markup: adminMenuReplyKeyboard() }
      );
    }

    return;
  }

  // ADMIN: подтверждает время
  if (data.startsWith("ADMIN_CONFIRM_TIME:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", {
        reply_markup: adminMenuReplyKeyboard(),
      });
      return;
    }

    order.confirmedTimeText = order.masterSuggestedTimeText || "";
    order.status = "TIME_CONFIRMED";

    await editMessage(
      chatId,
      messageId,
      `✅ Время для заявки #${order.id} подтверждено:\n⏰ ${order.confirmedTimeText}`,
    );

    // Уведомление мастеру
    await sendMessage(
      order.masterTgId,
      `✅ Администратор подтвердил время для заявки #${order.id}:\n⏰ ${order.confirmedTimeText}\n\n` +
        "Когда клиент приедет, нажмите кнопку ниже:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚗 Клиент приехал", callback_data: `MASTER_CLIENT_ARRIVED:${order.id}` }],
          ],
        },
      }
    );

    return;
  }

  // MASTER: отмечает приезд клиента — показываем три кнопки для фото
  if (data.startsWith("MASTER_CLIENT_ARRIVED:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", {
        reply_markup: masterMenuReplyKeyboard(),
      });
      return;
    }

    if (order.masterTgId !== cb.from.id) {
      await answerCb(cb.id);
      return;
    }

    order.actualArrivalAt = new Date().toISOString();
    order.status = "CLIENT_ARRIVED";

    await editMessage(
      chatId,
      messageId,
      `🚗 Клиент по заявке #${order.id} прибыл в сервис.\n\nНажмите нужную кнопку ниже, затем 📎 (скрепка) → «Фото» или «Камера»:`,
      { reply_markup: masterArrivalPhotoKeyboard(orderId, order) }
    );

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `🚗 Клиент по заявке #${order.id} прибыл в сервис.`,
        { reply_markup: adminMenuReplyKeyboard() }
      );
    }

    return;
  }

  // MASTER: нажал кнопку «Фото номера / пробега / устройства» — ждём отправку фото
  if (data.startsWith("MASTER_PHOTO:")) {
    const [, orderId, photoType] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    const labels = { PLATE: "номера автомобиля", ODOMETER: "пробега спидометра", DEVICE: "устройства / серийного номера" };
    const label = labels[photoType] || "фото";
    setState(chatId, "MASTER_WAIT_PHOTO", { orderId, photoType });
    await editMessage(
      chatId,
      messageId,
      `📸 Фото ${label}\n\nНажмите 📎 (скрепка) рядом с полем ввода → выберите «Фото» или «Камера» и отправьте снимок.`,
      { reply_markup: masterArrivalPhotoKeyboard(orderId, order) }
    );
    return;
  }

  // MASTER: нажал «Без номера» или «Без пробега»
  if (data.startsWith("MASTER_SKIP:")) {
    const [, orderId, skipType] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    if (skipType === "PLATE") order.carNumberSkipped = true;
    else if (skipType === "ODOMETER") order.odometerSkipped = true;

    const kb = masterArrivalPhotoKeyboard(orderId, order);
    if (kb) {
      const skipLabel = skipType === "PLATE" ? "номера" : "пробега";
      await editMessage(
        chatId,
        messageId,
        `⏭ Учтено: без ${skipLabel}. Выберите следующее:`,
        { reply_markup: kb }
      );
      return;
    }

    setState(chatId, "MASTER_WAIT_DONE", { orderId });
    await editMessage(chatId, messageId, `✅ Все данные по заявке #${order.id} сохранены. Нажмите «✅ Выполнено» для завершения.`);
    await sendMessage(chatId, "Нажмите кнопку ниже:", {
      reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] },
    });
    return;
  }

  // MASTER: нажал «Выполнено» — завершение заявки и уведомление админу
  if (data.startsWith("MASTER_DONE:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    order.status = "DONE";
    order.completedAt = new Date().toISOString();
    clearState(chatId);
    await editMessage(chatId, messageId, "✅ Выполнено.", { reply_markup: { inline_keyboard: [] } });
    await sendMessage(chatId, "✅ Готово.", { reply_markup: masterMenuReplyKeyboard() });

    const adminChatId = order.adminChatId || MAIN_ADMIN_ID;
    await sendMessage(
      adminChatId,
      `✅ Заявка #${order.id} выполнена.\n` +
        `👷 Мастер: ${order.masterName}\n` +
        `🚗/🏢: ${logisticsLabel(order)}`
    );
    if (order.carNumberPhotoId) {
      await sendPhoto(adminChatId, order.carNumberPhotoId, "📷 Номер автомобиля");
    } else if (order.carNumberSkipped) {
      await sendMessage(adminChatId, "🚗 Номер автомобиля: не приложен (мастер выбрал «Без номера»)");
    }
    if (order.odometerPhotoId) {
      await sendPhoto(adminChatId, order.odometerPhotoId, "📷 Пробег спидометра");
    } else if (order.odometerSkipped) {
      await sendMessage(adminChatId, "📏 Пробег: не приложен (мастер выбрал «Без пробега»)");
    }
    if (order.devicePhotoId) {
      await sendPhoto(adminChatId, order.devicePhotoId, "📷 Устройство / серийный номер");
    }
    return;
  }

  // ADMIN: picked master
  if (data.startsWith("ADMIN_PICK_MASTER:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_MASTER") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard() });
      return;
    }

    const masterTgId = Number(data.split(":")[1]);
    const master = MASTERS.find((m) => Number(m.tgId) === masterTgId);
    if (!master) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Мастер не найден.", { reply_markup: adminMenuReplyKeyboard() });
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

      adminChatId: chatId,

      type: st.data.presetType || null, // INSTALL | REPAIR
      logistics: null,                  // VISIT | COME
      address: "",                      // адрес при VISIT

      option: null,                     // для INSTALL
      adminComment: "",

      masterSuggestedTimeText: "",
      confirmedTimeText: "",
      actualArrivalAt: null,

      carNumberPhotoId: null,
      odometerPhotoId: null,
      devicePhotoId: null,
      carNumberSkipped: false,
      odometerSkipped: false,

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
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard() });
      return;
    }

    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard() });
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
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard() });
      return;
    }

    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard() });
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
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard() });
      return;
    }

    const parts = data.split(":");
    const orderId = parts[1];
    const optIndex = Number(parts[2]);

    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard() });
      return;
    }

    const option = OPTIONS[optIndex];
    if (!option) {
      await sendMessage(chatId, "⚠️ Опция не найдена. Проверь массив OPTIONS.", { reply_markup: adminMenuReplyKeyboard() });
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

// Утилиты для дат
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

const REPORT_TIMEZONE = "Asia/Dushanbe";

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function formatTime(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// Дата и время в часовом поясе отчёта (Excel)
function formatDateInTz(d, tz = REPORT_TIMEZONE) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d).replace(/\//g, ".");
}

function formatTimeInTz(d, tz = REPORT_TIMEZONE) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

// Предустановленные периоды
function calcPresetPeriod(code) {
  const now = new Date();

  if (code === "LAST_7") {
    const to = endOfDay(now);
    const from = startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
    return { from, to };
  }

  const year = now.getFullYear();
  const month = now.getMonth();

  if (code === "THIS_MONTH") {
    const from = startOfDay(new Date(year, month, 1));
    const to = endOfDay(new Date(year, month + 1, 0));
    return { from, to };
  }

  if (code === "LAST_MONTH") {
    const lastMonthDate = new Date(year, month - 1, 1);
    const y = lastMonthDate.getFullYear();
    const m = lastMonthDate.getMonth();
    const from = startOfDay(new Date(y, m, 1));
    const to = endOfDay(new Date(y, m + 1, 0));
    return { from, to };
  }

  // по умолчанию — последние 7 дней
  const to = endOfDay(now);
  const from = startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
  return { from, to };
}

// Парсинг произвольного периода "dd.mm.yyyy-dd.mm.yyyy"
function parseDateRange(input) {
  const m = input.match(
    /^(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})$/
  );
  if (!m) return null;

  const [, d1, mo1, y1, d2, mo2, y2] = m;
  const from = startOfDay(new Date(Number(y1), Number(mo1) - 1, Number(d1)));
  const to = endOfDay(new Date(Number(y2), Number(mo2) - 1, Number(d2)));
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) return null;
  return { from, to };
}

// Общая фильтрация заявок за период для отчёта
function getReportItems(from, to, opts = {}) {
  const scope = opts.scope || "ADMIN";
  const masterTgId = opts.masterTgId || null;
  const all = Array.from(orders.values());
  return all.filter((o) => {
    if (!o.createdAt) return false;
    const t = new Date(o.createdAt).getTime();
    if (t < from.getTime() || t > to.getTime()) return false;
    if (scope === "MASTER" && masterTgId != null) {
      return String(o.masterTgId) === String(masterTgId);
    }
    return true;
  });
}

// Текстовый отчёт по заявкам за период
async function sendTextReport(chatId, from, to, opts = {}) {
  const scope = opts.scope || "ADMIN";
  const masterTgId = opts.masterTgId || null;
  const items = getReportItems(from, to, opts);

  if (!items.length) {
    await sendMessage(
      chatId,
      scope === "MASTER"
        ? `📊 За период ${formatDate(from)}–${formatDate(to)} у вас нет заявок.`
        : `📊 За период ${formatDate(from)}–${formatDate(to)} заявок нет.`,
      { reply_markup: menuKeyboardForChat(chatId) }
    );
    return;
  }

  const total = items.length;
  const installs = items.filter((o) => o.type === "INSTALL");
  const repairs = items.filter((o) => o.type === "REPAIR");

  const byCity = {};
  for (const o of items) {
    const c = o.city || "—";
    byCity[c] = (byCity[c] || 0) + 1;
  }
  const cityLines = Object.entries(byCity)
    .map(([city, cnt]) => `• ${city}: ${cnt}`)
    .join("\n");

  // По видам монтажа (опциям) — только для заявок типа INSTALL
  const byOption = {};
  for (const o of installs) {
    const opt = o.option || "—";
    byOption[opt] = (byOption[opt] || 0) + 1;
  }
  const optionLines = Object.entries(byOption)
    .map(([opt, cnt]) => `• ${opt}: ${cnt}`)
    .join("\n");

  let header = `📊 Отчёт за период ${formatDate(from)}–${formatDate(to)}`;
  if (scope === "MASTER" && masterTgId != null) {
    const m = MASTERS.find((mm) => String(mm.tgId) === String(masterTgId));
    if (m) header += `\n👷 Мастер: ${m.name}`;
  }

  let text =
    `${header}\n\n` +
    `Всего заявок: ${total}\n` +
    `🛠 Монтаж: ${installs.length}\n` +
    `🧰 Ремонт / другое: ${repairs.length}\n\n` +
    `По городам:\n${cityLines}`;
  if (optionLines) {
    text += `\n\n📦 Монтаж по видам:\n${optionLines}`;
  }

  setState(chatId, "REPORT_SENT", {
    fromTs: from.getTime(),
    toTs: to.getTime(),
    scope,
    masterTgId,
  });

  const reportKeyboard = {
    inline_keyboard: [[{ text: "📥 Отправить в Excel", callback_data: "REPORT_EXCEL" }]],
  };
  await sendMessage(chatId, text, { reply_markup: reportKeyboard });
}

// Сборка Excel-файла отчёта, возвращает путь к временному файлу
function buildExcelReport(from, to, opts = {}) {
  const items = getReportItems(from, to, opts);

  const rows = [
    [
      "№",
      "Время начала",
      "Время завершения",
      "Тип",
      "Вид монтажа",
      "Город",
      "Мастер",
      "Логистика",
      "Адрес",
      "Телефон",
      "Комментарий",
      "Статус",
    ],
  ];

  function datetimeInTz(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return `${formatDateInTz(d)} ${formatTimeInTz(d)}`;
  }

  items.forEach((o, i) => {
    const dStart = o.createdAt ? new Date(o.createdAt) : null;
    const dEnd = o.completedAt ? new Date(o.completedAt) : null;
    rows.push([
      i + 1,
      dStart ? datetimeInTz(o.createdAt) : "",
      dEnd ? datetimeInTz(o.completedAt) : "",
      o.type === "INSTALL" ? "Монтаж" : "Ремонт/другое",
      o.type === "INSTALL" ? (o.option || "—") : "—",
      o.city || "—",
      o.masterName || "—",
      o.logistics === "VISIT" ? "Выезд" : o.logistics === "COME" ? "Клиент приедет" : "—",
      o.address || "—",
      o.phone || "—",
      (o.adminComment || "").replace(/\n/g, " "),
      o.status || "—",
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Заявки");

  // Сводка по видам монтажа (только заявки INSTALL)
  const installs = items.filter((o) => o.type === "INSTALL");
  const byOption = {};
  for (const o of installs) {
    const opt = o.option || "—";
    byOption[opt] = (byOption[opt] || 0) + 1;
  }
  const optionRows = [["Вид монтажа", "Количество"]];
  Object.entries(byOption).forEach(([opt, cnt]) => {
    optionRows.push([opt, cnt]);
  });
  const wsOptions = XLSX.utils.aoa_to_sheet(optionRows);
  XLSX.utils.book_append_sheet(wb, wsOptions, "Сводка по видам");

  // Сводка по монтажникам (мастерам)
  const byMaster = {};
  for (const o of items) {
    const name = o.masterName || "—";
    if (!byMaster[name]) {
      byMaster[name] = { total: 0, installs: 0, repairs: 0 };
    }
    byMaster[name].total += 1;
    if (o.type === "INSTALL") byMaster[name].installs += 1;
    else if (o.type === "REPAIR") byMaster[name].repairs += 1;
  }
  const masterRows = [["Мастер", "Всего заявок", "Монтаж", "Ремонт/другое"]];
  Object.entries(byMaster).forEach(([name, stats]) => {
    masterRows.push([name, stats.total, stats.installs, stats.repairs]);
  });
  const wsMasters = XLSX.utils.aoa_to_sheet(masterRows);
  XLSX.utils.book_append_sheet(wb, wsMasters, "Сводка по мастерам");

  const tmpDir = os.tmpdir();
  // Имя файла вида: Установки_01.03.2026-31.03.2026.xlsx
  const fromStr = formatDate(from);
  const toStr = formatDate(to);
  const filename =
    fromStr === toStr
      ? `Установки_${fromStr}.xlsx`
      : `Установки_${fromStr}-${toStr}.xlsx`;
  const filePath = path.join(tmpDir, filename);
  XLSX.writeFile(wb, filePath);
  return filePath;
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
  await sendMessage(order.masterTgId, text, {
    reply_markup: masterOrderKeyboard(order.id),
  });
}

// =============================
// Start server
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server started on port ${PORT}`);
  // Меню команд: при открытии чата в (/) будет видна команда «Показать меню»
  try {
    await tg("setMyCommands", {
      commands: [
        { command: "start", description: "Показать меню" },
        { command: "getmyid", description: "Мой Telegram ID" },
      ],
    });
  } catch (e) {
    console.warn("setMyCommands:", e?.message || e);
  }
});
