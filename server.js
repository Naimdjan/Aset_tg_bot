const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const ExcelJS = require("exceljs");
require("dotenv").config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPER_ADMIN_ID = process.env.SUPER_ADMIN_ID || ADMIN_CHAT_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// =============================
// База данных (JSON файлы)
// =============================
let orders = new Map();
let authorizedChatIds = new Set();
let authorizedRoles = new Map();
let authorizedMasterCity = new Map();
let activeMasterIds = new Set();
let inactiveMasterIds = new Set();
let dynamicMasters = new Map();
let userProfiles = {};
let auditLog = [];
let lastOrderId = 0;
let seenMasters = new Set();

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const DB_FILES = {
  orders: path.join(DATA_DIR, "orders.json"),
  auth: path.join(DATA_DIR, "auth.json"),
  profiles: path.join(DATA_DIR, "profiles.json"),
  audit: path.join(DATA_DIR, "audit.json"),
  meta: path.join(DATA_DIR, "meta.json"),
};

function loadData() {
  try {
    if (fs.existsSync(DB_FILES.orders)) {
      const data = JSON.parse(fs.readFileSync(DB_FILES.orders, "utf8"));
      orders = new Map(Object.entries(data));
    }
    if (fs.existsSync(DB_FILES.auth)) {
      const data = JSON.parse(fs.readFileSync(DB_FILES.auth, "utf8"));
      authorizedChatIds = new Set(data.authorizedChatIds || []);
      authorizedRoles = new Map(Object.entries(data.authorizedRoles || {}));
      authorizedMasterCity = new Map(Object.entries(data.authorizedMasterCity || {}));
      activeMasterIds = new Set(data.activeMasterIds || []);
      inactiveMasterIds = new Set(data.inactiveMasterIds || []);
      dynamicMasters = new Map(Object.entries(data.dynamicMasters || {}));
    }
    if (fs.existsSync(DB_FILES.profiles)) {
      userProfiles = JSON.parse(fs.readFileSync(DB_FILES.profiles, "utf8"));
    }
    if (fs.existsSync(DB_FILES.audit)) {
      auditLog = JSON.parse(fs.readFileSync(DB_FILES.audit, "utf8"));
    }
    if (fs.existsSync(DB_FILES.meta)) {
      const data = JSON.parse(fs.readFileSync(DB_FILES.meta, "utf8"));
      lastOrderId = data.lastOrderId || 0;
      if (Array.isArray(data.seenMasters)) seenMasters = new Set(data.seenMasters);
    }
  } catch (e) { console.error("Load error:", e); }
}

function saveData() {
  try {
    fs.writeFileSync(DB_FILES.orders, JSON.stringify(Object.fromEntries(orders)));
    fs.writeFileSync(DB_FILES.auth, JSON.stringify({
      authorizedChatIds: [...authorizedChatIds],
      authorizedRoles: Object.fromEntries(authorizedRoles),
      authorizedMasterCity: Object.fromEntries(authorizedMasterCity),
      activeMasterIds: [...activeMasterIds],
      inactiveMasterIds: [...inactiveMasterIds],
      dynamicMasters: Object.fromEntries(dynamicMasters),
    }));
    fs.writeFileSync(DB_FILES.profiles, JSON.stringify(userProfiles));
    fs.writeFileSync(DB_FILES.audit, JSON.stringify(auditLog.slice(-5000)));
    fs.writeFileSync(DB_FILES.meta, JSON.stringify({ lastOrderId, seenMasters: [...seenMasters] }));
  } catch (e) { console.error("Save error:", e); }
}

loadData();

// =============================
// Время и форматирование (ИСПРАВЛЕНИЯ №13, №14)
// =============================
function nowTjIso() {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  return new Date(utc + 3600000 * 5).toISOString(); // GMT+5
}

function formatDate(dateInput) {
  if (!dateInput) return "—";
  const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) return "—";
  
  // Формат: дд.мм.гггг чч:мм, часовой пояс Dushanbe
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Dushanbe",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d).replace(",", "");
}

// =============================
// Базовые функции API (ИСПРАВЛЕНИЯ №5, №10)
// =============================
async function sendMessage(chatId, text, options = {}) {
  try {
    // Исправление 10: всегда используем HTML для красивого текста без тегов
    if (!options.parse_mode) options.parse_mode = "HTML";
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
  } catch (e) { console.error("Send error:", e.response?.data || e.message); }
}

async function editMessage(chatId, messageId, text, options = {}) {
  try {
    if (!options.parse_mode) options.parse_mode = "HTML";
    await axios.post(`${TELEGRAM_API}/editMessageText`, { chat_id: chatId, message_id: messageId, text, ...options });
  } catch (e) { console.error("Edit error:", e.response?.data || e.message); }
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: messageId });
  } catch (e) {}
}

async function answerCb(cbId, text, showAlert = false) {
  try { 
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: cbId, text, show_alert: showAlert }); 
  } catch (e) { console.error("Cb error:", e); }
}

async function setBotMenu(chatId) {
  // Исправление 5: Скрываем синюю кнопку меню для всех, кроме суперадмина
  try {
    const type = String(chatId) === String(SUPER_ADMIN_ID) ? "commands" : "default";
    await axios.post(`${TELEGRAM_API}/setChatMenuButton`, {
      chat_id: chatId,
      menu_button: { type: type }
    });
  } catch (e) { console.error("Menu button error:", e.message); }
}
// =============================
// ПОЛНАЯ ЛОГИКА КЛАВИАТУР И МЕНЮ
// =============================

// Главное меню (зависит от роли)
function menuKeyboardForChat(chatId) {
  const sId = String(chatId);
  if (sId === String(SUPER_ADMIN_ID)) return adminMenuReplyKeyboard(sId);
  if (authorizedRoles.get(sId) === "ADMIN") return adminMenuReplyKeyboard(sId);
  if (activeMasterIds.has(sId)) return masterMenuReplyKeyboard();
  return { remove_keyboard: true };
}

function adminMenuReplyKeyboard(chatId) {
  const rows = [
    [{ text: "📋 Новая заявка" }, { text: "🔧 Ремонт / другое" }],
    [{ text: "📊 Отчёт" }, { text: "💬 Чат с мастером" }],
    [{ text: "👷 Мастера" }]
  ];
  
  // Исправление №3: Приватный чат Админ <-> Супер-админ
  if (String(chatId) === String(SUPER_ADMIN_ID)) {
    rows.push([{ text: "🧑‍💼💬 Чат с админом" }]);
    rows.push([{ text: "📇 Контакты (Excel)" }, { text: "📒 Журнал (Excel)" }, { text: "🔁 Роли" }]);
  } else {
    rows.push([{ text: "🧑‍💼💬 Чат с супер-админом" }]);
  }
  return { keyboard: rows, resize_keyboard: true };
}

function masterMenuReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "📊 Мой отчёт" }, { text: "💬 Написать админу" }]
    ],
    resize_keyboard: true
  };
}

// Кнопки для Мастера: Принятие заявки
function masterOrderKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "✅ Принять и выбрать время", callback_data: `MASTER_ACCEPT:${orderId}:CAL` }],
      [{ text: "❌ Отказаться", callback_data: `MASTER_DECLINE_START:${orderId}` }]
    ]
  };
}

// Исправление №11 и №12: Опрос о планируемом времени (после выбора даты)
function masterWorkDurationKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "⏳ Меньше часа", callback_data: `DUR_PLAN:${orderId}:0.5` }, { text: "1 час", callback_data: `DUR_PLAN:${orderId}:1` }],
      [{ text: "2 часа", callback_data: `DUR_PLAN:${orderId}:2` }, { text: "3 часа", callback_data: `DUR_PLAN:${orderId}:3` }],
      [{ text: "4 часа", callback_data: `DUR_PLAN:${orderId}:4` }, { text: "Более 5 часов", callback_data: `DUR_PLAN:${orderId}:5` }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }]
    ]
  };
}

// Исправление №7: Умная кнопка прибытия (зависит от логистики)
function masterArrivedKeyboard(orderId, order) {
  // Если логика "Сам приедет", мастер жмет "Клиент приехал", иначе "Я на месте"
  const label = (order && order.logistics === "COME") ? "🤝 Клиент приехал" : "📍 Я на месте";
  return {
    inline_keyboard: [[{ text: label, callback_data: `MASTER_ARRIVED:${orderId}` }]]
  };
}

function masterCompleteKeyboard(orderId) {
  return {
    inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_COMPLETE:${orderId}` }]]
  };
}

// Исправление №9 и №11: Финальный опрос по факту выполнения (для Excel-отчета)
function masterFinalDurationKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "⏳ Меньше часа", callback_data: `DUR:${orderId}:0.5` }, { text: "1 час", callback_data: `DUR:${orderId}:1` }],
      [{ text: "2 часа", callback_data: `DUR:${orderId}:2` }, { text: "3 часа", callback_data: `DUR:${orderId}:3` }],
      [{ text: "4 часа", callback_data: `DUR:${orderId}:4` }, { text: "Более 5 часов", callback_data: `DUR:${orderId}:5` }]
    ]
  };
}

// Полный код календаря (оставлен без изменений, чтобы вы могли выбирать даты)
function getCalendarKeyboard(orderId, year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay(); 
  const startOffset = (firstDay === 0 ? 6 : firstDay - 1);
  const rows = [];
  const monthNames = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  
  rows.push([{ text: `${monthNames[month]} ${year}`, callback_data: "IGNORE" }]);
  
  const weekDays = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  rows.push(weekDays.map(d => ({ text: d, callback_data: "IGNORE" })));
  
  let currRow = Array(startOffset).fill({ text: " ", callback_data: "IGNORE" });
  for (let d = 1; d <= daysInMonth; d++) {
    currRow.push({ text: d.toString(), callback_data: `CAL_DAY:${orderId}:${year}:${month}:${d}` });
    if (currRow.length === 7) { 
      rows.push(currRow); 
      currRow = []; 
    }
  }
  if (currRow.length > 0) {
    while (currRow.length < 7) currRow.push({ text: " ", callback_data: "IGNORE" });
    rows.push(currRow);
  }
  
  rows.push([
    { text: "< Назад", callback_data: `CAL_PREV:${orderId}:${year}:${month}` },
    { text: "Вперед >", callback_data: `CAL_NEXT:${orderId}:${year}:${month}` }
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

// Форматирование уведомления для мастера (Исправление №10: Чистый текст, HTML парсинг будет на уровне sendMessage)
function formatMasterOrder(orderId, order) {
  return `🔔 <b>НОВАЯ ЗАЯВКА #${orderId}</b>\n\n` +
         `<b>Тип:</b> 🛠 ${order.type}\n` +
         `<b>Клиент:</b> ${order.phone}\n` +
         `<b>Логистика:</b> ${order.logistics === "COME" ? "🏢 Сам приедет" : "🚗 Выезд"}\n` +
         `<b>Адрес:</b> ${order.address}\n` +
         `<b>Устройства:</b> ${order.devices}\n` +
         `<b>Коммент:</b> ${order.comment || "—"}\n` +
         `<b>Статус:</b> Отправлено мастеру`;
}
// =============================
// ПОЛНАЯ ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ (Часть 3)
// =============================

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text ? msg.text.trim() : "";
  const st = userProfiles[chatId] || { step: "IDLE", data: {} };
  userProfiles[chatId] = st;

  if (text === "/start") {
    st.step = "IDLE"; st.data = {};
    saveData();
    await setBotMenu(chatId); // Исправление №5
    return sendMessage(chatId, "Система активна. Используйте меню ниже:", { reply_markup: menuKeyboardForChat(chatId) });
  }

  if (text === "❌ Отмена" || text === "/cancel") {
    st.step = "IDLE"; st.data = {};
    saveData();
    return sendMessage(chatId, "Действие отменено.", { reply_markup: menuKeyboardForChat(chatId) });
  }

  // Исправление №3: Приватный чат (Админ <-> Супер-админ)
  if (text === "🧑‍💼💬 Чат с супер-админом" || text === "🧑‍💼💬 Чат с админом") {
    st.step = "SUPER_CHAT";
    saveData();
    return sendMessage(chatId, "💬 Вы вошли в приватный чат. Все ваши сообщения будут пересланы. Для выхода нажмите «❌ Отмена».", {
      reply_markup: { keyboard: [[{ text: "❌ Отмена" }]], resize_keyboard: true }
    });
  }

  if (st.step === "SUPER_CHAT") {
    const targetId = (chatId === String(SUPER_ADMIN_ID)) ? ADMIN_CHAT_ID : SUPER_ADMIN_ID;
    const prefix = (chatId === String(SUPER_ADMIN_ID)) ? "⭐ СУПЕР-АДМИНИСТРАТОР:" : "👨‍💼 АДМИНИСТРАТОР:";
    await sendMessage(targetId, `<b>${prefix}</b>\n${text}`);
    return sendMessage(chatId, "✅ Отправлено.");
  }

  // --- ЛОГИКА АДМИНА: СОЗДАНИЕ ЗАЯВКИ ---

  if (text === "📋 Новая заявка" || text === "🔧 Ремонт / другое") {
    if (chatId !== String(SUPER_ADMIN_ID) && authorizedRoles.get(chatId) !== "ADMIN") return;
    st.step = "ADMIN_WAIT_TYPE";
    st.data = {};
    saveData();
    return sendMessage(chatId, "Выберите тип работы:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛠 Монтаж", callback_data: "TYPE:Монтаж" }, { text: "🔄 Демонтаж", callback_data: "TYPE:Демонтаж" }],
          [{ text: "🔧 Ремонт", callback_data: "TYPE:Ремонт" }, { text: "🔎 Диагностика", callback_data: "TYPE:Диагностика" }],
          [{ text: "❌ Отмена", callback_data: "CANCEL" }]
        ]
      }
    });
  }

  if (st.step === "ADMIN_WAIT_PHONE") {
    st.data.phone = text;
    st.step = "ADMIN_WAIT_LOGISTICS";
    saveData();
    return sendMessage(chatId, `Номер: ${text}\nВыберите логистику:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚗 Выезд", callback_data: "LOG:OUT" }, { text: "🏢 Сам приедет", callback_data: "LOG:COME" }],
          [{ text: "❌ Отмена", callback_data: "CANCEL" }]
        ]
      }
    });
  }

  // Исправление №2: Поиск заявки при вводе адреса с принудительным String(orderId)
  if (st.step === "ADMIN_WAIT_ADDRESS") {
    const orderId = String(st.data.orderId);
    const order = orders.get(orderId);
    if (!order) {
      st.step = "IDLE"; st.data = {}; saveData();
      return sendMessage(chatId, "⚠️ Ошибка: заявка не найдена. Попробуйте создать заново.", { reply_markup: menuKeyboardForChat(chatId) });
    }
    order.address = text;
    st.step = "ADMIN_WAIT_QTY_CONFIRM";
    saveData();
    return sendMessage(chatId, `Адрес: ${text}\nВведите количество устройств:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1", callback_data: "QTY:1" }, { text: "2", callback_data: "QTY:2" }, { text: "3", callback_data: "QTY:3" }],
          [{ text: "Свое число", callback_data: "QTY_CUSTOM" }],
          [{ text: "❌ Отмена", callback_data: "CANCEL" }]
        ]
      }
    });
  }

  if (st.step === "ADMIN_WAIT_QTY_CUSTOM") {
    if (isNaN(text) || parseInt(text) <= 0) return sendMessage(chatId, "Пожалуйста, введите корректное число (например, 5):");
    st.data.tempQty = text;
    st.step = "ADMIN_WAIT_DEVICE_NAME";
    saveData();
    return sendMessage(chatId, `Количество: ${text}. Введите название устройства (например, FMB920):`);
  }

  if (st.step === "ADMIN_WAIT_DEVICE_NAME") {
    const orderId = String(st.data.orderId);
    const order = orders.get(orderId);
    if (!order) { st.step = "IDLE"; return sendMessage(chatId, "Заявка не найдена."); }
    order.devices = `${text} × ${st.data.tempQty}`;
    st.step = "ADMIN_WAIT_COMMENT";
    saveData();
    return sendMessage(chatId, "Добавьте комментарий для мастера (или напишите /skip, чтобы пропустить):");
  }

  if (st.step === "ADMIN_WAIT_COMMENT") {
    const orderId = String(st.data.orderId);
    const order = orders.get(orderId);
    if (!order) { st.step = "IDLE"; return sendMessage(chatId, "Заявка не найдена."); }
    order.comment = text === "/skip" ? "" : text;
    st.step = "ADMIN_WAIT_MASTER";
    saveData();
    
    // Формируем список мастеров динамически
    const kbd = [];
    const activeArr = Array.from(activeMasterIds);
    for (let i = 0; i < activeArr.length; i += 2) {
      const row = [];
      const m1 = activeArr[i];
      const m1Name = dynamicMasters.get(m1)?.name || m1;
      row.push({ text: m1Name, callback_data: `SEL_MASTER:${m1}` });
      if (i + 1 < activeArr.length) {
        const m2 = activeArr[i + 1];
        const m2Name = dynamicMasters.get(m2)?.name || m2;
        row.push({ text: m2Name, callback_data: `SEL_MASTER:${m2}` });
      }
      kbd.push(row);
    }
    kbd.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
    
    return sendMessage(chatId, "Выберите мастера из списка:", { reply_markup: { inline_keyboard: kbd } });
  }

  // --- ЧАТ АДМИНА С МАСТЕРОМ ---

  if (text === "💬 Чат с мастером") {
    if (chatId !== String(SUPER_ADMIN_ID) && authorizedRoles.get(chatId) !== "ADMIN") return;
    const kbd = [];
    const activeArr = Array.from(activeMasterIds);
    for (let i = 0; i < activeArr.length; i += 2) {
      const row = [];
      const m1 = activeArr[i];
      const m1Name = dynamicMasters.get(m1)?.name || m1;
      row.push({ text: m1Name, callback_data: `CHAT_M:${m1}` });
      if (i + 1 < activeArr.length) {
        const m2 = activeArr[i + 1];
        const m2Name = dynamicMasters.get(m2)?.name || m2;
        row.push({ text: m2Name, callback_data: `CHAT_M:${m2}` });
      }
      kbd.push(row);
    }
    kbd.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
    return sendMessage(chatId, "Выберите мастера для начала чата:", { reply_markup: { inline_keyboard: kbd } });
  }

  // Исправление №8: Индикация СУПЕР-АДМИНА в чате с мастером
  if (st.step === "CHAT_WITH_MASTER") {
    const masterId = st.data.targetMasterId;
    const prefix = (chatId === String(SUPER_ADMIN_ID)) ? "⭐ СУПЕР-АДМИНИСТРАТОР:" : "👨‍💼 АДМИНИСТРАТОР:";
    await sendMessage(masterId, `<b>${prefix}</b>\n${text}`);
    return sendMessage(chatId, "✅ Сообщение доставлено мастеру.");
  }

  // --- ЛОГИКА МАСТЕРА ---

  if (text === "💬 Написать админу" && activeMasterIds.has(chatId)) {
    st.step = "MASTER_CHAT_ADMIN";
    saveData();
    return sendMessage(chatId, "Напишите сообщение администратору. Для выхода нажмите «❌ Отмена».", {
      reply_markup: { keyboard: [[{ text: "❌ Отмена" }]], resize_keyboard: true }
    });
  }

  if (st.step === "MASTER_CHAT_ADMIN") {
    const masterName = dynamicMasters.get(chatId)?.name || chatId;
    await sendMessage(ADMIN_CHAT_ID, `📩 <b>Сообщение от мастера ${masterName}:</b>\n${text}`);
    return sendMessage(chatId, "✅ Ваше сообщение отправлено администратору.");
  }

  if (text === "📊 Мой отчёт" && activeMasterIds.has(chatId)) {
    return sendReportMenu(chatId);
  }

  // --- ОТЧЕТЫ И ПРОЧЕЕ МЕНЮ АДМИНА ---

  if (text === "📊 Отчёт") {
    if (chatId !== String(SUPER_ADMIN_ID) && authorizedRoles.get(chatId) !== "ADMIN") return;
    return sendReportMenu(chatId);
  }

  if (text === "👷 Мастера") {
    if (chatId !== String(SUPER_ADMIN_ID) && authorizedRoles.get(chatId) !== "ADMIN") return;
    return sendMessage(chatId, "Управление мастерами:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Добавить мастера", callback_data: "MASTER_ADD" }, { text: "➖ Удалить мастера", callback_data: "MASTER_REMOVE" }],
          [{ text: "📋 Список мастеров", callback_data: "MASTER_LIST" }],
          [{ text: "❌ Отмена", callback_data: "CANCEL" }]
        ]
      }
    });
  }

  if (st.step === "WAIT_CUSTOM_DATE") {
    const rx = /^\d{2}\.\d{2}\.\d{4}-\d{2}\.\d{2}\.\d{4}$/;
    if (!rx.test(text)) return sendMessage(chatId, "Неверный формат. Ожидается: дд.мм.гггг-дд.мм.гггг");
    st.data.period = text;
    st.step = "REPORT_READY";
    saveData();
    // Меню выгрузки для своего периода
    return sendMessage(chatId, `✅ Выбран период: ${text}\nВ каком виде выгрузить?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "В сообщении (текст)", callback_data: "REPORT_TEXT" }, { text: "Файл Excel (.xlsx)", callback_data: "REPORT_EXCEL" }],
          [{ text: "❌ Отмена", callback_data: "CANCEL" }]
        ]
      }
    });
  }

  // Если текст не попал ни в одно условие и не является командой меню
  if (st.step === "IDLE" && !text.startsWith("/")) {
    return sendMessage(chatId, "Пожалуйста, используйте кнопки меню для работы с ботом.", { reply_markup: menuKeyboardForChat(chatId) });
  }
}

async function sendReportMenu(chatId) {
  const isAdmin = (chatId === String(SUPER_ADMIN_ID) || authorizedRoles.get(chatId) === "ADMIN");
  const keyboard = {
    inline_keyboard: [
      [{ text: "Сегодня", callback_data: "REPORT_PERIOD:TODAY" }, { text: "Вчера", callback_data: "REPORT_PERIOD:YESTERDAY" }],
      [{ text: "7 дней", callback_data: "REPORT_PERIOD:LAST_7" }, { text: "Месяц", callback_data: "REPORT_PERIOD:THIS_MONTH" }]
    ]
  };
  // Добавляем функции только для админов
  if (isAdmin) {
    // Ожидающие (Исправление №6: Pending будет иметь выбор Текст/Excel в onCallback)
    keyboard.inline_keyboard.push([{ text: "⏳ Ожидающие (Pending)", callback_data: "REPORT_PERIOD:PENDING" }]);
    keyboard.inline_keyboard.push([{ text: "📅 Свой период", callback_data: "REPORT_CUSTOM" }]);
  }
  keyboard.inline_keyboard.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  
  await sendMessage(chatId, "📊 Выберите период отчёта:", { reply_markup: keyboard });
}
// =============================
// ПОЛНАЯ ОБРАБОТКА НАЖАТИЙ КНОПОК (Часть 4)
// =============================

async function onCallback(cb) {
  const chatId = String(cb.message.chat.id);
  const messageId = cb.message.message_id;
  const data = cb.data;
  const st = userProfiles[chatId] || { step: "IDLE", data: {} };

  if (data === "IGNORE") return answerCb(cb.id, "");
  
  if (data === "CANCEL") {
    st.step = "IDLE"; st.data = {}; saveData();
    await editMessage(chatId, messageId, "Действие отменено.");
    return answerCb(cb.id, "Отменено");
  }

  // --- ЛОГИКА ОТЧЕТОВ (Исправления №1 и №6: всегда есть выбор формата) ---
  if (data.startsWith("REPORT_PERIOD:")) {
    const p = data.split(":")[1];
    st.data.period = p;
    st.step = "REPORT_READY";
    const title = p === "PENDING" ? "⏳ Ожидающие заявки" : `Отчёт за период: ${p}`;
    
    // ВАЖНО: добавлен reply_markup вокруг inline_keyboard
    await editMessage(chatId, messageId, `✅ Выбрано: ${title}\nВ каком виде выгрузить?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "В сообщении (текст)", callback_data: "REPORT_TEXT" }, { text: "Файл Excel (.xlsx)", callback_data: "REPORT_EXCEL" }],
          [{ text: "❌ Отмена", callback_data: "CANCEL" }]
        ]
      }
    });
    saveData();
    return answerCb(cb.id, "Выберите формат");
  }

  if (data === "REPORT_CUSTOM") {
    st.step = "WAIT_CUSTOM_DATE";
    saveData();
    await editMessage(chatId, messageId, "Введите период в формате дд.мм.гггг-дд.мм.гггг (например: 01.02.2026-28.02.2026):");
    return answerCb(cb.id, "");
  }

  // Формирование самого отчета вынесено в функции build... в Части 5
  if (data === "REPORT_TEXT" || data === "REPORT_EXCEL") {
    const period = st.data.period;
    if (!period) return answerCb(cb.id, "Ошибка: период не выбран", true);
    st.step = "IDLE"; saveData();
    
    if (data === "REPORT_TEXT") {
      await editMessage(chatId, messageId, "⏳ Формирую текстовый отчет...");
      const txt = await buildTextReport(chatId, orders, period);
      await sendMessage(chatId, txt);
      return answerCb(cb.id, "Готово");
    } else {
      await editMessage(chatId, messageId, "⏳ Формирую Excel файл...");
      const filePath = await buildExcelReport(chatId, orders, period);
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
        chat_id: chatId,
        document: fs.createReadStream(filePath)
      }, { headers: { 'Content-Type': 'multipart/form-data' } });
      fs.unlinkSync(filePath);
      return answerCb(cb.id, "Файл отправлен");
    }
  }

  // --- СОЗДАНИЕ ЗАЯВКИ (АДМИН) ---
  if (data.startsWith("TYPE:")) {
    st.data.type = data.split(":")[1];
    st.data.orderId = ++lastOrderId;
    st.step = "ADMIN_WAIT_PHONE";
    saveData();
    await editMessage(chatId, messageId, `Тип: ${st.data.type}\nВведите номер телефона клиента:`);
    return answerCb(cb.id, "");
  }

  if (data.startsWith("LOG:")) {
    st.data.logistics = data.split(":")[1];
    st.step = "ADMIN_WAIT_ADDRESS";
    saveData();
    const txt = st.data.logistics === "COME" ? "Сам приедет" : "Выезд";
    await editMessage(chatId, messageId, `Логистика: ${txt}\nВведите адрес клиента:`);
    return answerCb(cb.id, "");
  }

  if (data.startsWith("QTY:")) {
    const val = data.split(":")[1];
    if (val === "CUSTOM") {
      st.step = "ADMIN_WAIT_QTY_CUSTOM";
      saveData();
      await editMessage(chatId, messageId, "Введите количество устройств цифрами:");
    } else {
      st.data.tempQty = val;
      st.step = "ADMIN_WAIT_DEVICE_NAME";
      saveData();
      await editMessage(chatId, messageId, `Количество: ${val}. Введите название устройства:`);
    }
    return answerCb(cb.id, "");
  }

  if (data.startsWith("SEL_MASTER:")) {
    const masterId = data.split(":")[1];
    const orderId = String(st.data.orderId);
    
    const masterName = dynamicMasters.get(masterId)?.name || masterId;
    const order = {
      id: orderId,
      type: st.data.type,
      phone: st.data.phone,
      logistics: st.data.logistics,
      address: orders.get(orderId)?.address || "Не указан",
      devices: orders.get(orderId)?.devices || "Не указано",
      comment: orders.get(orderId)?.comment || "",
      status: "Отправлено мастеру",
      masterId: masterId,
      masterName: masterName,
      createdAt: nowTjIso()
    };
    orders.set(orderId, order);
    st.step = "IDLE"; st.data = {};
    saveData();

    await editMessage(chatId, messageId, `✅ Заявка #${orderId} создана и отправлена мастеру ${masterName}.`);
    
    const msgText = formatMasterOrder(orderId, order);
    await sendMessage(masterId, msgText, { reply_markup: masterOrderKeyboard(orderId) });
    return answerCb(cb.id, "Заявка отправлена");
  }

  // --- ЛОГИКА МАСТЕРА: ПРИНЯТИЕ И КАЛЕНДАРЬ ---
  if (data.startsWith("MASTER_ACCEPT:")) {
    const parts = data.split(":");
    const orderId = parts[1];
    const mode = parts[2];
    const order = orders.get(String(orderId));
    if (!order) return answerCb(cb.id, "Заявка не найдена", true);
    
    if (mode === "CAL") {
      const now = new Date();
      await editMessage(chatId, messageId, "📅 Выберите дату начала работ:", {
        reply_markup: getCalendarKeyboard(orderId, now.getFullYear(), now.getMonth())
      });
    }
    return answerCb(cb.id, "");
  }

  if (data.startsWith("CAL_PREV:") || data.startsWith("CAL_NEXT:")) {
    const parts = data.split(":");
    const isNext = data.startsWith("CAL_NEXT:");
    const orderId = parts[1];
    let y = parseInt(parts[2]);
    let m = parseInt(parts[3]);
    if (isNext) { m++; if (m > 11) { m = 0; y++; } } 
    else { m--; if (m < 0) { m = 11; y--; } }
    await editMessage(chatId, messageId, "📅 Выберите дату начала работ:", {
      reply_markup: getCalendarKeyboard(orderId, y, m)
    });
    return answerCb(cb.id, "");
  }

  // Исправления №11 и №12: Переход от календаря к опросу о времени
  if (data.startsWith("CAL_DAY:")) {
    const parts = data.split(":");
    const orderId = parts[1];
    const y = parts[2];
    const m = parts[3];
    const d = parts[4];
    const execDate = `${d.padStart(2, '0')}.${(parseInt(m) + 1).toString().padStart(2, '0')}.${y}`;
    
    const order = orders.get(String(orderId));
    if (order) {
      order.execDate = execDate;
      saveData();
      await editMessage(chatId, messageId, `📅 Дата: <b>${execDate}</b>.\n⏳ Теперь укажите примерное время выполнения (установка + аксессуары):`, {
        reply_markup: masterWorkDurationKeyboard(orderId)
      });
    }
    return answerCb(cb.id, "Дата выбрана");
  }

  // Исправление №12: Сохранение плана времени
  if (data.startsWith("DUR_PLAN:")) {
    const parts = data.split(":");
    const orderId = parts[1];
    const hours = parts[2];
    const order = orders.get(String(orderId));
    if (order) {
      order.plannedHours = hours;
      order.status = "Принято (назначена дата)";
      saveData();
      const timeStr = hours === "0.5" ? "меньше часа" : (hours === "5" ? "более 5 часов" : `${hours} ч.`);
      await sendMessage(ADMIN_CHAT_ID, `✅ Мастер ${order.masterName} принял заявку #${orderId}.\n📅 Дата: <b>${order.execDate}</b>\n⏳ План. время: ~${timeStr}`);
      await editMessage(chatId, messageId, `✅ Вы приняли заявку на ${order.execDate}.\nПлан: ${timeStr}.\nКогда прибудете к клиенту или клиент приедет к вам, нажмите соответствующую кнопку в меню заявок (если потребуется, админ отправит напоминание).`, {
         reply_markup: masterArrivedKeyboard(orderId, order)
      });
    }
    return answerCb(cb.id, "Время запланировано");
  }

  if (data.startsWith("MASTER_DECLINE_START:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (order) {
      order.status = "ОТКАЗ (до начала)";
      saveData();
      await editMessage(chatId, messageId, `❌ Вы отказались от заявки #${orderId}.`);
      await sendMessage(ADMIN_CHAT_ID, `⚠️ Мастер ${order.masterName} ОТКАЗАЛСЯ от заявки #${orderId}.`);
    }
    return answerCb(cb.id, "Отказано");
  }

  // --- ЛОГИКА МАСТЕРА: ВЫПОЛНЕНИЕ ---
  if (data.startsWith("MASTER_ARRIVED:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (order) {
      order.status = "Мастер на месте";
      order.arrivedAt = nowTjIso();
      saveData();
      await sendMessage(ADMIN_CHAT_ID, `📍 Мастер ${order.masterName} прибыл по заявке #${orderId}.`);
      await editMessage(chatId, messageId, `✅ Статус обновлен: Вы на месте (Заявка #${orderId}).\nПосле завершения работ нажмите кнопку ниже:`, {
        reply_markup: masterCompleteKeyboard(orderId)
      });
    }
    return answerCb(cb.id, "Вы на месте");
  }

  if (data.startsWith("MASTER_COMPLETE:")) {
    const orderId = data.split(":")[1];
    await editMessage(chatId, messageId, `Укажите ФАКТИЧЕСКОЕ время, затраченное на заявку #${orderId}:`, {
      reply_markup: masterFinalDurationKeyboard(orderId)
    });
    return answerCb(cb.id, "");
  }

  if (data.startsWith("DUR:")) {
    const parts = data.split(":");
    const orderId = parts[1];
    const hours = parts[2];
    const order = orders.get(String(orderId));
    if (order) {
      order.actualHours = hours;
      order.status = "Ожидает фото";
      saveData();
      st.step = "MASTER_WAIT_PHOTO";
      st.data.orderId = orderId;
      st.data.photos = [];
      saveData();
      await editMessage(chatId, messageId, `✅ Время (${hours === "0.5" ? "меньше часа" : hours + " ч."}) учтено.\n📸 Теперь отправьте фото выполненной работы (можно несколько). После отправки всех фото нажмите /done.`);
    }
    return answerCb(cb.id, "");
  }

  // --- ЛОГИКА АДМИНА: ЗАКРЫТИЕ И ВОЗВРАТ ---
  if (data.startsWith("ADMIN_CLOSE:")) {
    const orderId = data.split(":")[1];
    st.step = "ADMIN_WAIT_PRICE";
    st.data.orderId = orderId;
    saveData();
    await editMessage(chatId, messageId, `Заявка #${orderId}.\nВведите итоговую сумму (только число):`);
    return answerCb(cb.id, "");
  }

  // Исправление №4: Возврат (недоделка)
  if (data.startsWith("ADMIN_RETURN:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (order) {
      order.status = "Мастер на месте (ДОРАБОТКА)";
      saveData();
      await sendMessage(order.masterId, `⚠️ <b>Внимание!</b> Заявка #${orderId} возвращена на доработку.\nСвяжитесь с администратором для уточнения деталей, затем снова отправьте фото выполненной работы.`);
      await editMessage(chatId, messageId, `✅ Заявка #${orderId} возвращена мастеру на доработку (статус изменен).`);
    }
    return answerCb(cb.id, "Возвращено");
  }

  if (data.startsWith("ADMIN_CANCEL:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (order) {
      order.status = "ОТМЕНЕНА АДМИНОМ";
      saveData();
      await editMessage(chatId, messageId, `🚫 Заявка #${orderId} отменена.`);
    }
    return answerCb(cb.id, "Отменено");
  }

  // --- ЧАТ И УПРАВЛЕНИЕ МАСТЕРАМИ ---
  if (data.startsWith("CHAT_M:")) {
    const masterId = data.split(":")[1];
    st.step = "CHAT_WITH_MASTER";
    st.data.targetMasterId = masterId;
    saveData();
    const mName = dynamicMasters.get(masterId)?.name || masterId;
    await editMessage(chatId, messageId, `💬 Чат с мастером ${mName}.\nНапишите сообщение. Для выхода нажмите «❌ Отмена».`, {
      reply_markup: { keyboard: [[{ text: "❌ Отмена" }]], resize_keyboard: true }
    });
    return answerCb(cb.id, "");
  }

  if (data === "MASTER_LIST") {
    let txt = "📋 Список мастеров:\n\n";
    dynamicMasters.forEach((m, id) => {
      const status = activeMasterIds.has(id) ? "✅ Активен" : (inactiveMasterIds.has(id) ? "❌ Неактивен" : "❓ Неизвестно");
      txt += `ID: <code>${id}</code>\nИмя: ${m.name}\nГород: ${m.city}\nСтатус: ${status}\n\n`;
    });
    await editMessage(chatId, messageId, txt || "Мастеров пока нет.");
    return answerCb(cb.id, "");
  }

  if (data === "MASTER_ADD") {
    st.step = "ADMIN_ADD_MASTER_ID";
    saveData();
    await editMessage(chatId, messageId, "Введите Telegram ID нового мастера:");
    return answerCb(cb.id, "");
  }

  if (data === "MASTER_REMOVE") {
    st.step = "ADMIN_DEL_MASTER_ID";
    saveData();
    await editMessage(chatId, messageId, "Введите Telegram ID мастера для удаления:");
    return answerCb(cb.id, "");
  }
}
// =============================
// ДОПОЛНИТЕЛЬНАЯ ОБРАБОТКА (Фото, Цена, Мастера)
// =============================

async function handlePhoto(msg) {
  const chatId = String(msg.chat.id);
  const st = userProfiles[chatId];
  if (!st || st.step !== "MASTER_WAIT_PHOTO") return;

  let fileId;
  if (msg.photo) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document) fileId = msg.document.file_id;
  if (!fileId) return;

  if (!st.data.photos) st.data.photos = [];
  st.data.photos.push(fileId);
  saveData();
  await sendMessage(chatId, `✅ Файл получен (${st.data.photos.length} шт.). Отправьте еще фото или нажмите /done для завершения.`);
}

async function handleDone(msg) {
  const chatId = String(msg.chat.id);
  const st = userProfiles[chatId];
  if (st && st.step === "MASTER_WAIT_PHOTO") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (order) {
      order.status = "Ожидает закрытия";
      order.completedAt = nowTjIso(); // Время завершения (Таджикистан)
      saveData();
      
      await sendMessage(chatId, `✅ Заявка #${orderId} завершена и отправлена администратору на проверку.`, { reply_markup: menuKeyboardForChat(chatId) });
      
      const adminKbd = {
        inline_keyboard: [
          [{ text: "💰 Закрыть (Оплачено)", callback_data: `ADMIN_CLOSE:${orderId}` }],
          [{ text: "🔄 Возврат (Недоделка)", callback_data: `ADMIN_RETURN:${orderId}` }], // Исправление №4
          [{ text: "❌ Отменить", callback_data: `ADMIN_CANCEL:${orderId}` }]
        ]
      };
      
      // Отправляем фото админу
      if (st.data.photos && st.data.photos.length > 0) {
        const media = st.data.photos.slice(0, 10).map((id, index) => ({
          type: 'photo',
          media: id,
          caption: index === 0 ? `📸 Фото по заявке #${orderId} (Мастер: ${order.masterName})` : ""
        }));
        try { await axios.post(`${TELEGRAM_API}/sendMediaGroup`, { chat_id: ADMIN_CHAT_ID, media: media }); } 
        catch (e) { console.error("MediaGroup error", e.message); }
      }
      
      const tHours = order.actualHours === "0.5" ? "меньше часа" : `${order.actualHours} ч.`;
      await sendMessage(ADMIN_CHAT_ID, `✅ <b>Мастер ${order.masterName} завершил заявку #${orderId}</b>.\n⏳ Время по факту: ${tHours}\n\nПроверьте фото и выберите действие:`, { reply_markup: adminKbd });
    }
    st.step = "IDLE"; st.data = {}; saveData();
    return true;
  }
  return false;
}

// Перехватчик для этапов, требующих ввода текста (Цена, Добавление мастеров)
async function handleRemainingText(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text ? msg.text.trim() : "";
  const st = userProfiles[chatId];
  if (!st) return false;

  if (st.step === "ADMIN_WAIT_PRICE") {
    if (isNaN(text)) { await sendMessage(chatId, "Пожалуйста, введите сумму цифрами:"); return true; }
    const order = orders.get(String(st.data.orderId));
    if (order) {
      order.totalPrice = text;
      order.status = "Полностью ЗАКРЫТА";
      saveData();
      await sendMessage(chatId, `✅ Заявка #${order.id} закрыта! Итоговая сумма: ${text} с.`);
      await sendMessage(order.masterId, `💰 Ваша заявка #${order.id} проверена и закрыта.\nОдобренная сумма: ${text} с.`);
    }
    st.step = "IDLE"; st.data = {}; saveData();
    return true;
  }

  if (st.step === "ADMIN_ADD_MASTER_ID") {
    st.data.newMasterId = text; st.step = "ADMIN_ADD_MASTER_NAME"; saveData();
    await sendMessage(chatId, `ID ${text} принят. Теперь введите Имя мастера:`); return true;
  }
  if (st.step === "ADMIN_ADD_MASTER_NAME") {
    st.data.newMasterName = text; st.step = "ADMIN_ADD_MASTER_CITY"; saveData();
    await sendMessage(chatId, `Имя ${text} принято. Введите Город:`); return true;
  }
  if (st.step === "ADMIN_ADD_MASTER_CITY") {
    const mId = st.data.newMasterId;
    dynamicMasters.set(mId, { name: st.data.newMasterName, city: text });
    activeMasterIds.add(mId); inactiveMasterIds.delete(mId);
    st.step = "IDLE"; st.data = {}; saveData();
    await sendMessage(chatId, `✅ Мастер ${st.data.newMasterName} (ID: ${mId}) успешно добавлен.`); return true;
  }
  if (st.step === "ADMIN_DEL_MASTER_ID") {
    if (dynamicMasters.has(text)) {
      activeMasterIds.delete(text); inactiveMasterIds.add(text);
      st.step = "IDLE"; st.data = {}; saveData();
      await sendMessage(chatId, `✅ Мастер ${text} удален из активных.`);
    } else {
      st.step = "IDLE"; st.data = {}; saveData();
      await sendMessage(chatId, `⚠️ Мастер с ID ${text} не найден.`);
    }
    return true;
  }
  return false;
}

// =============================
// ГЕНЕРАЦИЯ ОТЧЕТОВ (Исправления №13, №14)
// =============================

function filterOrdersByPeriod(ordersMap, period) {
  const all = Array.from(ordersMap.values());
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const tjDate = new Date(utc + 3600000 * 5); // Часовой пояс Dushanbe

  const startOfDay = new Date(tjDate.getFullYear(), tjDate.getMonth(), tjDate.getDate()).getTime();
  const startOfYesterday = startOfDay - 86400000;
  
  if (period === "PENDING") return all.filter(o => o.status !== "Полностью ЗАКРЫТА" && o.status !== "ОТМЕНЕНА АДМИНОМ" && !o.status.startsWith("ОТКАЗ"));
  
  if (period === "TODAY") return all.filter(o => new Date(o.completedAt || o.createdAt).getTime() >= startOfDay);
  if (period === "YESTERDAY") return all.filter(o => {
      const t = new Date(o.completedAt || o.createdAt).getTime();
      return t >= startOfYesterday && t < startOfDay;
  });
  if (period === "LAST_7") return all.filter(o => new Date(o.completedAt || o.createdAt).getTime() >= (startOfDay - 7 * 86400000));
  if (period === "THIS_MONTH") return all.filter(o => new Date(o.completedAt || o.createdAt).getTime() >= new Date(tjDate.getFullYear(), tjDate.getMonth(), 1).getTime());
  
  if (period.includes("-")) {
    const [startStr, endStr] = period.split("-");
    const [sd, sm, sy] = startStr.split(".");
    const [ed, em, ey] = endStr.split(".");
    const sTime = new Date(sy, sm - 1, sd).getTime();
    const eTime = new Date(ey, em - 1, ed, 23, 59, 59).getTime();
    return all.filter(o => {
      const t = new Date(o.completedAt || o.createdAt).getTime();
      return t >= sTime && t <= eTime;
    });
  }
  return all;
}

async function buildTextReport(chatId, ordersMap, period) {
  let text = `📊 <b>ОТЧЁТ: ${period}</b>\n\n`;
  const filtered = filterOrdersByPeriod(ordersMap, period);
  if (filtered.length === 0) return text + "За указанный период заявок не найдено.";

  filtered.forEach(o => {
    const dateStr = formatDate(o.completedAt || o.createdAt);
    text += `🔹 <b>#${o.id}</b> | ${dateStr}\n`;
    text += `🛠 ${o.type} (${o.devices})\n`;
    text += `👷 Мастер: ${o.masterName}\n`;
    text += `💰 Сумма: ${o.totalPrice || 0} с.\n\n`;
  });
  return text;
}

async function buildExcelReport(chatId, ordersMap, period) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Отчёт');
  
  sheet.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Дата', key: 'date', width: 20 },
    { header: 'Тип работы', key: 'type', width: 15 },
    { header: 'Мастер', key: 'master', width: 20 },
    { header: 'Устройства', key: 'devices', width: 25 },
    { header: 'Время (ч)', key: 'hours', width: 10 },
    { header: 'Сумма (с.)', key: 'price', width: 15 },
    { header: 'Адрес', key: 'address', width: 30 }
  ];

  const filtered = filterOrdersByPeriod(ordersMap, period);
  filtered.forEach(o => {
    sheet.addRow({
      id: o.id,
      date: formatDate(o.completedAt || o.createdAt),
      type: o.type,
      master: o.masterName,
      devices: o.devices,
      hours: o.actualHours || o.plannedHours || 0,
      price: o.totalPrice || 0,
      address: o.address
    });
  });

  const filePath = path.join(os.tmpdir(), `report_${chatId}_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

// =============================
// ЗАПУСК СЕРВЕРА (ВЕБХУКИ)
// =============================
const PORT = process.env.PORT || 3000;

app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  try {
    const body = req.body;
    if (body.message) {
      const msg = body.message;
      if (msg.text === "/done") {
        await handleDone(msg);
      } else if (msg.photo || msg.document) {
        await handlePhoto(msg);
      } else {
        const isHandled = await handleRemainingText(msg);
        if (!isHandled) {
          // Если handleRemainingText не обработал текст, передаем в основную функцию (Часть 3)
          if (typeof handleMessage === "function") await handleMessage(msg);
        }
      }
    }
    if (body.callback_query) {
      if (typeof onCallback === "function") await onCallback(body.callback_query);
    }
  } catch (e) { 
    console.error("Webhook route error:", e); 
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер успешно запущен на порту ${PORT}`);
  console.log(`🌍 Часовой пояс синхронизирован: Asia/Dushanbe`);
});
