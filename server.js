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

// =============================
// UI builders
// =============================

// ✅ Главное меню — Reply Keyboard (кнопки прямо в строке ввода, без /start)
function mainMenuReplyKeyboard() {
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

  if (text === "📊 Отчёт") {
    const isMaster = MASTERS.some((m) => String(m.tgId) === String(chatId));
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
      reply_markup: mainMenuReplyKeyboard(),
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

  // MASTER: ждём время, когда клиент может подойти
  if (st.step === "MASTER_WAIT_TIME") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order || order.masterTgId !== chatId) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена или принадлежит другому мастеру.", {
        reply_markup: mainMenuReplyKeyboard(),
      });
      return;
    }

    order.masterSuggestedTimeText = text;
    order.status = "WAIT_ADMIN_CONFIRM_TIME";

    clearState(chatId);

    // Уведомление администратору
    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `🕒 Мастер ${order.masterName} предложил время для заявки #${order.id}:\n` +
          `⏰ ${order.masterSuggestedTimeText}\n\nПодтвердить?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Подтвердить время", callback_data: `ADMIN_CONFIRM_TIME:${order.id}` },
              ],
              [{ text: "❌ Отмена", callback_data: "CANCEL" }],
            ],
          },
        }
      );
    }

    await sendMessage(
      chatId,
      "✅ Время отправлено администратору на подтверждение.",
      { reply_markup: mainMenuReplyKeyboard() }
    );
    return;
  }

  // MASTER: отправка фото номера машины, пробега и устройства
  if (
    st.step === "MASTER_WAIT_PHOTO_PLATE" ||
    st.step === "MASTER_WAIT_PHOTO_ODOMETER" ||
    st.step === "MASTER_WAIT_PHOTO_DEVICE"
  ) {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order || order.masterTgId !== chatId) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена или принадлежит другому мастеру.", {
        reply_markup: mainMenuReplyKeyboard(),
      });
      return;
    }

    const photos = message.photo || [];
    if (!photos.length) {
      await sendMessage(chatId, "⚠️ Пожалуйста, отправьте именно фото.", {
        reply_markup: mainMenuReplyKeyboard(),
      });
      return;
    }

    const fileId = photos[photos.length - 1].file_id;

    if (st.step === "MASTER_WAIT_PHOTO_PLATE") {
      order.carNumberPhotoId = fileId;
      setState(chatId, "MASTER_WAIT_PHOTO_ODOMETER", { orderId });
      await sendMessage(chatId, "📸 Теперь отправьте фото пробега спидометра.", {
        reply_markup: mainMenuReplyKeyboard(),
      });
      return;
    }

    if (st.step === "MASTER_WAIT_PHOTO_ODOMETER") {
      order.odometerPhotoId = fileId;
      setState(chatId, "MASTER_WAIT_PHOTO_DEVICE", { orderId });
      await sendMessage(chatId, "📸 Теперь отправьте фото устройства / серийного номера.", {
        reply_markup: mainMenuReplyKeyboard(),
      });
      return;
    }

    if (st.step === "MASTER_WAIT_PHOTO_DEVICE") {
      order.devicePhotoId = fileId;
      order.status = "DONE";

      clearState(chatId);

      await sendMessage(chatId, `✅ Данные по заявке #${order.id} сохранены.`, {
        reply_markup: mainMenuReplyKeyboard(),
      });

      // Уведомление администратору + пересылка фото
      if (order.adminChatId) {
        await sendMessage(
          order.adminChatId,
          `✅ Клиент по заявке #${order.id} обслужен.\n` +
            `👷 Мастер: ${order.masterName}\n` +
            `🚗/🏢: ${logisticsLabel(order)}`
        );

        if (order.carNumberPhotoId) {
          await sendPhoto(order.adminChatId, order.carNumberPhotoId, "📷 Номер автомобиля");
        }
        if (order.odometerPhotoId) {
          await sendPhoto(order.adminChatId, order.odometerPhotoId, "📷 Пробег спидометра");
        }
        if (order.devicePhotoId) {
          await sendPhoto(order.adminChatId, order.devicePhotoId, "📷 Устройство / серийный номер");
        }
      }

      return;
    }
  }

   // ADMIN: ждём ввод произвольного периода отчёта
  if (st.step === "REPORT_WAIT_RANGE") {
    const rangeText = text;
    const parsed = parseDateRange(rangeText);
    if (!parsed) {
      await sendMessage(
        chatId,
        "⚠️ Неверный формат периода.\nВведите в виде: 01.03.2026-31.03.2026",
        { reply_markup: mainMenuReplyKeyboard() }
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
  await sendMessage(chatId, "⚠️ Сессия сброшена. Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
}

async function onCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data || "";

  await answerCb(cb.id);

  // Cancel — на шаге комментария не сбрасываем заявку: пользователь может ещё ввести текст
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
    await sendMessage(chatId, "Выберите действие:", { reply_markup: mainMenuReplyKeyboard() });
    return;
  }

  // ADMIN: выбор периода отчёта
  if (data.startsWith("REPORT_PERIOD:")) {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_WAIT_PERIOD") {
      await sendMessage(chatId, "⚠️ Сессия отчёта устарела. Нажмите «📊 Отчёт» ещё раз.", {
        reply_markup: mainMenuReplyKeyboard(),
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

  // MASTER: берёт заявку
  if (data.startsWith("MASTER_ACCEPT:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", {
        reply_markup: mainMenuReplyKeyboard(),
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

    setState(chatId, "MASTER_WAIT_TIME", { orderId });
    await sendMessage(
      chatId,
      "🕒 Укажите, когда клиент может подойти (например: 25.03 15:30).",
      { reply_markup: mainMenuReplyKeyboard() }
    );

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `✅ Мастер ${order.masterName} взял заявку #${order.id}.`,
        { reply_markup: mainMenuReplyKeyboard() }
      );
    }

    return;
  }

  // MASTER: не может взять заявку
  if (data.startsWith("MASTER_DECLINE:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", {
        reply_markup: mainMenuReplyKeyboard(),
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
        { reply_markup: mainMenuReplyKeyboard() }
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
        reply_markup: mainMenuReplyKeyboard(),
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

  // MASTER: отмечает приезд клиента
  if (data.startsWith("MASTER_CLIENT_ARRIVED:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", {
        reply_markup: mainMenuReplyKeyboard(),
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
      `🚗 Клиент по заявке #${order.id} прибыл в сервис.\n` +
        "Далее по шагам отправьте необходимые фото в чат.",
    );

    setState(chatId, "MASTER_WAIT_PHOTO_PLATE", { orderId });
    await sendMessage(chatId, "📸 Сначала отправьте фото номера автомобиля.", {
      reply_markup: mainMenuReplyKeyboard(),
    });

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `🚗 Клиент по заявке #${order.id} прибыл в сервис.`,
        { reply_markup: mainMenuReplyKeyboard() }
      );
    }

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

// Утилиты для дат
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
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

// Текстовый отчёт по заявкам за период
async function sendTextReport(chatId, from, to, opts = {}) {
  const scope = opts.scope || "ADMIN"; // ADMIN | MASTER
  const masterTgId = opts.masterTgId || null;

  const all = Array.from(orders.values());
  const items = all.filter((o) => {
    if (!o.createdAt) return false;
    const t = new Date(o.createdAt).getTime();
    if (t < from.getTime() || t > to.getTime()) return false;
    if (scope === "MASTER" && masterTgId != null) {
      return String(o.masterTgId) === String(masterTgId);
    }
    return true;
  });

  if (!items.length) {
    await sendMessage(
      chatId,
      scope === "MASTER"
        ? `📊 За период ${formatDate(from)}–${formatDate(to)} у вас нет заявок.`
        : `📊 За период ${formatDate(from)}–${formatDate(to)} заявок нет.`,
      { reply_markup: mainMenuReplyKeyboard() }
    );
    return;
  }

  const total = items.length;
  const installs = items.filter((o) => o.type === "INSTALL").length;
  const repairs = items.filter((o) => o.type === "REPAIR").length;

  const byCity = {};
  for (const o of items) {
    const c = o.city || "—";
    byCity[c] = (byCity[c] || 0) + 1;
  }

  const cityLines = Object.entries(byCity)
    .map(([city, cnt]) => `• ${city}: ${cnt}`)
    .join("\n");

  let header = `📊 Отчёт за период ${formatDate(from)}–${formatDate(to)}`;
  if (scope === "MASTER" && masterTgId != null) {
    const m = MASTERS.find((mm) => String(mm.tgId) === String(masterTgId));
    if (m) header += `\n👷 Мастер: ${m.name}`;
  }

  const text =
    `${header}\n\n` +
    `Всего заявок: ${total}\n` +
    `🛠 Монтаж: ${installs}\n` +
    `🧰 Ремонт / другое: ${repairs}\n\n` +
    `По городам:\n${cityLines}`;

  await sendMessage(chatId, text, { reply_markup: mainMenuReplyKeyboard() });
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
