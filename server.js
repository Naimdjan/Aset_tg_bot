require("dotenv").config();
// Default timezone for all Date() operations (Render/Node respects TZ)
process.env.TZ = process.env.TZ || "Asia/Dushanbe";

const express = require("express");
const axios = require("axios");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const path = require("path");
const os = require("os");
const fs = require("fs");
const DATA_FILE_PATH = path.join(process.cwd(), "data.json");

const app = express();
app.use(express.json());

// =============================
// ENV
// =============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN not found in environment variables");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Пароль для доступа к боту (если задан — после /start нужно ввести пароль)
function normalizePassword(s) {
  if (!s || typeof s !== "string") return "";
  let t = s.trim().replace(/\r/g, "");
  const m = t.match(/^["']?(.+?)["']?$/);
  if (m) t = m[1].trim();
  return t;
}
const BOT_PASSWORD = normalizePassword(process.env.BOT_PASSWORD || "");
const authorizedChatIds = new Set(); // chatId строкой
const authorizedRoles = new Map();   // chatId -> "MASTER"|"ADMIN"
let userProfiles = {};               // chatId -> { name, city, role, username }
let auditLog = [];                   // события аудита
const seenMasters = new Set();       // мастера, уже подключавшиеся (сбрасывается при рестарте)
const pendingApprovalInfo = new Map(); // applicantChatId -> { username }

function isAllowedWithoutApproval(chatId) {
  return String(chatId) === String(SUPER_ADMIN_ID) || String(chatId) === String(ADMIN_CHAT_ID) || isMasterChat(chatId);
}
function isAuthorized(chatId) {
  return isAllowedWithoutApproval(chatId) || authorizedChatIds.has(String(chatId));
}
function setAuthorized(chatId) {
  authorizedChatIds.add(String(chatId));
  saveData();
}

// =============================
// Роли: супер-админ и админ для общения с мастерами
const SUPER_ADMIN_ID = 7862998301;   // супер-админ: все права, все уведомления, весь чат
const ADMIN_CHAT_ID = 1987607156;    // админ: общается с мастерами, но не видит чат супер-админа

const MASTERS = [
  { tgId: 8095234574, name: "Иброхимчон", city: "Худжанд" },
  { tgId: 1039628701, name: "Акаи Шухрат", city: "Бохтар" },
  { tgId: 8026685490, name: "тест", city: "Душанбе" },
  { tgId: 1099184597, name: "Абдухалим", city: "Душанбе" },
];
const authorizedMasterCity = new Map();  // chatId -> city
const pendingMasterCity = new Map();     // adminChatId -> applicantChatId
const activeMasterIds = new Set();      // активные мастера
const inactiveMasterIds = new Set();    // неактивные мастера
const dynamicMasters = new Map();      // chatId -> { name, city }
MASTERS.forEach((m) => activeMasterIds.add(String(m.tgId)));

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      saveData();
      console.log("📄 data.json создан: " + DATA_FILE_PATH);
      return;
    }
    const raw = fs.readFileSync(DATA_FILE_PATH, "utf8");
    const j = JSON.parse(raw);
    if (j.authorizedChatIds && Array.isArray(j.authorizedChatIds)) {
      j.authorizedChatIds.forEach((id) => authorizedChatIds.add(String(id)));
    }
    if (j.authorizedRoles && typeof j.authorizedRoles === "object") {
      for (const [k, v] of Object.entries(j.authorizedRoles)) authorizedRoles.set(String(k), v);
    }
    if (j.userProfiles && typeof j.userProfiles === "object") userProfiles = j.userProfiles;
    if (j.auditLog && Array.isArray(j.auditLog)) auditLog = j.auditLog;
    if (j.activeMasterIds && Array.isArray(j.activeMasterIds)) {
      activeMasterIds.clear();
      j.activeMasterIds.forEach((id) => activeMasterIds.add(String(id)));
    }
    if (j.inactiveMasterIds && Array.isArray(j.inactiveMasterIds)) {
      inactiveMasterIds.clear();
      j.inactiveMasterIds.forEach((id) => inactiveMasterIds.add(String(id)));
    }
    if (j.authorizedMasterCity && typeof j.authorizedMasterCity === "object") {
      for (const [k, v] of Object.entries(j.authorizedMasterCity)) authorizedMasterCity.set(String(k), v);
    }
    if (j.dynamicMasters && typeof j.dynamicMasters === "object") {
      dynamicMasters.clear();
      for (const [k, v] of Object.entries(j.dynamicMasters)) dynamicMasters.set(String(k), v);
    }
  } catch (e) {
    console.error("loadData error:", e?.message || e);
  }
}
function saveData() {
  try {
    const j = {
      authorizedChatIds: [...authorizedChatIds],
      authorizedRoles: Object.fromEntries(authorizedRoles),
      userProfiles,
      auditLog: auditLog.slice(-50000),
      activeMasterIds: [...activeMasterIds],
      inactiveMasterIds: [...inactiveMasterIds],
      authorizedMasterCity: Object.fromEntries(authorizedMasterCity),
      dynamicMasters: Object.fromEntries(dynamicMasters),
    };
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(j, null, 2), "utf8");
  } catch (e) {
    console.error("saveData error:", e?.message || e, e);
  }
}
/** Запись события в auditLog. Вызов: logEvent(type, details) или logEvent({ action, actorId, targetId, meta }) */
function logEvent(typeOrEv, details) {
  let entry;
  if (typeof typeOrEv === "string") {
    const d = details || {};
    entry = {
      ts: new Date().toISOString(),
      action: typeOrEv,
      actorId: d.actorId ?? null,
      targetId: d.targetId ?? null,
      meta: d.meta ?? null,
    };
  } else {
    const ev = typeOrEv;
    entry = { ts: new Date().toISOString(), actorId: ev.actorId, action: ev.action, targetId: ev.targetId ?? null, meta: ev.meta ?? null };
  }
  // Enrich actor identity (username/full name) for audit log
  try {
    const actorId = entry.actorId;
    const metaUser = entry?.meta?.user || null;
    const prof = actorId && typeof userProfiles === "object" ? userProfiles[String(actorId)] : null;
    entry.actorUsername = metaUser?.username || prof?.username || null;
    entry.actorName = metaUser?.name || metaUser?.fullName || prof?.name || null;
  } catch (e) {}

  auditLog.push(entry);
  if (auditLog.length > 50000) auditLog.shift();
  saveData();
}
loadData();

// Опции сгруппированы: Устройства / Аксессуары / Другое
const OPTIONS_DEVICES     = ["FMB920", "FMB125", "FMB140", "DUT"];
const OPTIONS_ACCESSORIES = ["Реле", "Temp."];
const OPTIONS_OTHER       = ["Video", "Другое"];
const OPTIONS = [...OPTIONS_DEVICES, ...OPTIONS_ACCESSORIES, ...OPTIONS_OTHER];

// Аксессуары — фото не нужны
const ACCESSORIES = new Set(OPTIONS_ACCESSORIES);

// Возвращает полный список фото-слотов для заявки.
// Правила:
//  - Аксессуары (Реле, Temp.) → без фото
//  - Если выбраны FMB125 И DUT: DUT привязывается к FMB125 (не отдельно)
//  - Каждая единица устройства: device (обяз.) + [dut (обяз.)] + odometer + plate
// Ключ: "{DeviceName}_{unitIdx}_{photoType}"
function getPhotoSlots(order) {
  const opts = order.options?.length ? order.options : [];
  if (!opts.length) return [];

  const hasFMB125 = opts.includes("FMB125");
  const hasDutOpt = opts.includes("DUT");
  const dutPaired = hasFMB125 && hasDutOpt; // DUT будет привязан к FMB125

  const deviceCounts = {};
  const slots = [];

  const addUnitSlots = (name, unitIdx, hasDut) => {
    const n = unitIdx + 1;
    slots.push({ key: `${name}_${unitIdx}_device`,   label: `${name}-${n}`,         deviceName: name, photoType: "device",   unitIdx, required: true  });
    if (name === "DUT") return; // DUT: только фото устройства, без пробега/номера
    if (hasDut) {
      slots.push({ key: `${name}_${unitIdx}_dut`,    label: `DUT-${n}|${name}-${n}`, deviceName: name, photoType: "dut",      unitIdx, required: true  });
    }
    slots.push({ key: `${name}_${unitIdx}_odometer`, label: `Пробег ${name}-${n}`, deviceName: name, photoType: "odometer", unitIdx, required: false });
    slots.push({ key: `${name}_${unitIdx}_plate`,    label: `Номер ${name}-${n}`,  deviceName: name, photoType: "plate",    unitIdx, required: false });
  };

  for (const opt of opts) {
    if (ACCESSORIES.has(opt)) continue;
    if (opt === "DUT" && dutPaired) continue; // DUT обрабатывается внутри FMB125

    const qty = order.deviceQuantities?.[opt] || 1;
    const dutQty = dutPaired && opt === "FMB125" ? (order.deviceQuantities?.["DUT"] || 1) : 0;

    for (let i = 0; i < qty; i++) {
      const unitIdx = deviceCounts[opt] || 0;
      deviceCounts[opt] = unitIdx + 1;
      // Первые min(qty,dutQty) единиц FMB125 получают DUT
      addUnitSlots(opt, unitIdx, dutPaired && opt === "FMB125" && i < dutQty);
    }

    // Если DUT > FMB125 — оставшиеся DUT как самостоятельные устройства
    if (dutPaired && opt === "FMB125") {
      const fmb125Qty = qty;
      const dutQtyVal = order.deviceQuantities?.["DUT"] || 1;
      for (let i = fmb125Qty; i < dutQtyVal; i++) {
        const unitIdx = deviceCounts["DUT"] || 0;
        deviceCounts["DUT"] = unitIdx + 1;
        addUnitSlots("DUT", unitIdx, false);
      }
    }
  }

  return slots;
}

// =============================
// In-memory storage
// =============================
let lastOrderId = 0;
const orders = new Map();    // orderId -> order
const userState = new Map(); // chatId -> { step, data }
const dedupe = new Map();    // update_id -> ts

function cleanupDedupe() {
  const ttl = 60 * 1000;
  const t = Date.now();
  for (const [k, v] of dedupe.entries()) {
    if (t - v > ttl) dedupe.delete(k);
  }
}

// Удаляем закрытые/выполненные заявки старше 7 дней (защита от утечки памяти)
function cleanupOldOrders() {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  const t = Date.now();
  for (const [id, order] of orders.entries()) {
    const terminal = ["CLOSED", "DECLINED_BY_MASTER"].includes(order.status);
    const ts = order.closedAt || order.completedAt || order.createdAt;
    if (terminal && ts && t - new Date(ts).getTime() > maxAge) {
      orders.delete(id);
    }
  }
}
setInterval(cleanupOldOrders, 60 * 60 * 1000); // раз в час

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

async function answerCb(callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) { payload.text = text; payload.show_alert = showAlert; }
  return tg("answerCallbackQuery", payload).catch(() => {});
}

async function sendPhoto(chatId, fileId, caption) {
  return tg("sendPhoto", { chat_id: chatId, photo: fileId, caption });
}

// Безопасная отправка — не бросает исключение при ошибке Telegram API
async function safeSend(chatId, text, extra = {}) {
  return sendMessage(chatId, text, extra).catch((e) =>
    console.warn(`safeSend to ${chatId} failed: ${e?.message || e}`)
  );
}

// Пересылает любое сообщение (текст, фото, видео, файл, голос, контакт, геолокация, стикер, видеозаметка)
async function forwardChatMessage(message, toChatId, fromLabel) {
  const cap = (extra) => extra ? `${fromLabel}:\n${extra}` : fromLabel;
  if (message.text) {
    await safeSend(toChatId, `${fromLabel}:\n${message.text}`);
  } else if (message.photo?.length) {
    const fid = message.photo[message.photo.length - 1].file_id;
    await tg("sendPhoto", { chat_id: toChatId, photo: fid, caption: cap(message.caption) }).catch(() => {});
  } else if (message.document) {
    await tg("sendDocument", { chat_id: toChatId, document: message.document.file_id, caption: cap(message.caption) }).catch(() => {});
  } else if (message.video) {
    await tg("sendVideo", { chat_id: toChatId, video: message.video.file_id, caption: cap(message.caption) }).catch(() => {});
  } else if (message.voice) {
    await tg("sendVoice", { chat_id: toChatId, voice: message.voice.file_id, caption: cap(message.caption) }).catch(() => {});
  } else if (message.audio) {
    await tg("sendAudio", { chat_id: toChatId, audio: message.audio.file_id, caption: cap(message.caption) }).catch(() => {});
  } else if (message.video_note) {
    await safeSend(toChatId, fromLabel);
    await tg("sendVideoNote", { chat_id: toChatId, video_note: message.video_note.file_id }).catch(() => {});
  } else if (message.sticker) {
    await safeSend(toChatId, `${fromLabel}: [стикер]`);
    await tg("sendSticker", { chat_id: toChatId, sticker: message.sticker.file_id }).catch(() => {});
  } else if (message.contact) {
    const c = message.contact;
    await safeSend(toChatId, `${fromLabel}: 📱 Контакт`);
    await tg("sendContact", { chat_id: toChatId, phone_number: c.phone_number, first_name: c.first_name || "", last_name: c.last_name || "" }).catch(() => {});
  } else if (message.location) {
    await safeSend(toChatId, `${fromLabel}: 📍 Геолокация`);
    await tg("sendLocation", { chat_id: toChatId, latitude: message.location.latitude, longitude: message.location.longitude }).catch(() => {});
  }
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
function adminMenuReplyKeyboard(chatId) {
  const rows = [
    [{ text: "📋 Новая заявка" }, { text: "🔧 Ремонт / другое" }],
    [{ text: "📊 Отчёт" }, { text: "💬 Чат с мастером" }],
    [{ text: "👷 Мастера" }],
    [{ text: "❌ Отмена" }],
  ];

  // Private chat between Admin and Super Admin (masters never see it)
  if (ADMIN_CHAT_ID && SUPER_ADMIN_ID) {
    const cid = String(chatId);
    if (cid === String(ADMIN_CHAT_ID) || cid === String(SUPER_ADMIN_ID)) {
      const label = cid === String(SUPER_ADMIN_ID) ? "🧑‍💼💬 Чат с админом" : "🧑‍💼💬 Чат с супер-админом";
      rows.splice(2, 0, [{ text: label }]);
    }
  }

  if (chatId != null && String(chatId) === String(SUPER_ADMIN_ID)) {
    rows.push([{ text: "📇 Контакты (Excel)" }, { text: "📒 Журнал (Excel)" }, { text: "🔁 Роли" }]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
    one_time_keyboard: false,
    selective: false,
  };
}

function masterMenuReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "📊 Мой отчёт" }, { text: "💬 Написать админу" }],
      [{ text: "❌ Отмена" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    selective: false,
  };
}

function isMasterChat(chatId) {
  return activeMasterIds.has(String(chatId));
}

function getMasterLabel(tgId) {
  const sid = String(tgId);
  const prof = userProfiles[sid];
  if (prof && (prof.name || prof.city)) return `${prof.city || "—"} · ${prof.name || sid}`;
  const m = MASTERS.find((x) => String(x.tgId) === sid);
  if (m) return `${m.city} · ${m.name}`;
  const d = dynamicMasters.get(sid);
  if (d) return `${d.city} · ${d.name}`;
  return sid;
}
function getMasterInfo(tgId) {
  const sid = String(tgId);
  const prof = userProfiles[sid];
  if (prof) return { name: prof.name || sid, city: prof.city || "—" };
  const m = MASTERS.find((x) => String(x.tgId) === sid);
  if (m) return { name: m.name, city: m.city };
  const d = dynamicMasters.get(sid);
  if (d) return { name: d.name, city: d.city };
  return { name: sid, city: "—" };
}

function menuKeyboardForChat(chatId) {
  if (activeMasterIds.has(String(chatId))) return masterMenuReplyKeyboard();
  return adminMenuReplyKeyboard(chatId);
}

// Inline keyboards (для выбора)
function mastersKeyboard() {
  const rows = [...activeMasterIds].map((tid) => [
    { text: `🏙 ${getMasterLabel(tid)}`, callback_data: `ADMIN_PICK_MASTER:${tid}` },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function mastersChatKeyboard() {
  const rows = [...activeMasterIds].map((tid) => [
    { text: `💬 ${getMasterLabel(tid)}`, callback_data: `ADMIN_CHAT_MASTER:${tid}` },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function orderTypeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🛠 Монтаж", callback_data: "ADMIN_TYPE:INSTALL" },
        { text: "🔧 Ремонт / другое", callback_data: "ADMIN_TYPE:REPAIR" },
      ],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

function logisticsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🚗 Выезд", callback_data: "ADMIN_LOG:VISIT" },
        { text: "🏢 Сам приедет", callback_data: "ADMIN_LOG:COME" },
      ],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

// Клавиатура выбора типа/периода отчёта
function reportPeriodKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📆 Сегодня", callback_data: "REPORT_PERIOD:TODAY" },
        { text: "📆 Вчера", callback_data: "REPORT_PERIOD:YESTERDAY" },
      ],
      [
        { text: "🗓 Этот месяц", callback_data: "REPORT_PERIOD:THIS_MONTH" },
        { text: "🗓 Прошлый месяц", callback_data: "REPORT_PERIOD:LAST_MONTH" },
      ],
      [
        { text: "📅 7 дней", callback_data: "REPORT_PERIOD:LAST_7" },
        { text: "📅 Свой период", callback_data: "REPORT_PERIOD:PERIOD" },
      ],
      [{ text: "⏳ Ожидающие заявки", callback_data: "REPORT_PERIOD:PENDING" }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

// Компактный календарь для выбора даты отчёта (только дата, без времени)
function reportCalendarKeyboard(mode, yyyymm) {
  const prefix = mode === "START" ? "RP_START" : "RP_END";
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
    { text: "‹", callback_data: `${prefix}_MN:${prevYyyymm}` },
    { text: monthLabelShort(year, month), callback_data: "NOOP" },
    { text: "›", callback_data: `${prefix}_MN:${nextYyyymm}` },
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
      row.push({ text: String(day), callback_data: `${prefix}_MD:${yyyymmdd}` });
      day++;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }

  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

// Клавиатура для мастера по заявке
function masterOrderKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Сегодня", callback_data: `MASTER_ACCEPT:${orderId}:TODAY` },
        { text: "✅ Завтра", callback_data: `MASTER_ACCEPT:${orderId}:TOMORROW` },
      ],
      [{ text: "📅 Другая дата", callback_data: `MASTER_ACCEPT:${orderId}:CAL` }],
    ],
  };
}

// Возвращает предупреждение о пропущенных фото пробега/номера,
// либо null если всё заполнено.
function getMissingPhotoWarning(order) {
  const devPhotos = order.devicePhotos || {};
  const slots = getPhotoSlots(order);
  const unitWarnings = {};

  for (const slot of slots) {
    if (slot.photoType !== "odometer" && slot.photoType !== "plate") continue;
    const fid = devPhotos[slot.key];
    if (fid && fid !== "SKIPPED") continue; // фото есть — всё OK
    const unitKey = `${slot.deviceName}_${slot.unitIdx}`;
    if (!unitWarnings[unitKey]) unitWarnings[unitKey] = { label: `${slot.deviceName}-${slot.unitIdx + 1}`, missing: [] };
    unitWarnings[unitKey].missing.push(slot.photoType === "odometer" ? "пробег" : "номер");
  }

  const lines = Object.values(unitWarnings)
    .filter(u => u.missing.length)
    .map(u => `• ${u.label}: нет фото ${u.missing.join(" и ")}`);

  return lines.length ? `⚠️ Отсутствуют фото:\n${lines.join("\n")}` : null;
}

// Кнопки для фото по прибытии клиента.
// Каждое устройство даёт: Фото X-N (обяз.), DUT для X-N (обяз., только FMB125+DUT),
// Пробег для X-N (необяз.), Номер для X-N (необяз.).
// Фото X-N и DUT для X-N ставятся рядом на одной строке.
// Аксессуары (Реле, Temp.) — без фото.
function masterArrivalPhotoKeyboard(orderId, order) {
  const rows = [];
  const devPhotos = order.devicePhotos || {};
  const pending = getPhotoSlots(order).filter(s => devPhotos[s.key] === undefined);

  let i = 0;
  while (i < pending.length) {
    const slot = pending[i];
    // Если текущий слот — device, а следующий — dut того же устройства → ставим рядом
    const next = pending[i + 1];
    if (
      slot.photoType === "device" &&
      next?.photoType === "dut" &&
      next?.deviceName === slot.deviceName &&
      next?.unitIdx === slot.unitIdx
    ) {
      rows.push([
        { text: slot.label, callback_data: `MASTER_PHOTO:${orderId}:${slot.key}` },
        { text: next.label,  callback_data: `MASTER_PHOTO:${orderId}:${next.key}` },
      ]);
      i += 2;
    } else {
      const row = [{ text: slot.label, callback_data: `MASTER_PHOTO:${orderId}:${slot.key}` }];
      if (!slot.required) {
        row.push({ text: "📷 Нет", callback_data: `MASTER_SKIP:${orderId}:${slot.key}` });
      }
      rows.push(row);
      i++;
    }
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
  for (let h = 5; h <= 24; h++) hours.push(h);
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

// Клавиатура выбора даты для предложения времени администратором
function adminProposeCalendarKeyboard(orderId, yyyymm) {
  const parsed = parseYyyymm(yyyymm);
  const now = new Date();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dow = (first.getDay() + 6) % 7;
  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const prevYm = formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1);
  const nextYm = formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1);
  const rows = [];
  rows.push([
    { text: "‹", callback_data: `APROP_MN:${orderId}:${prevYm}` },
    { text: monthLabelShort(year, month), callback_data: "NOOP" },
    { text: "›", callback_data: `APROP_MN:${orderId}:${nextYm}` },
  ]);
  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if (week === 0 && i < dow) { row.push({ text: "·", callback_data: "NOOP" }); continue; }
      if (day > daysInMonth) { row.push({ text: "·", callback_data: "NOOP" }); continue; }
      const yyyymmdd = `${year}${pad2(month)}${pad2(day)}`;
      row.push({ text: String(day), callback_data: `APROP_MD:${orderId}:${yyyymmdd}` });
      day++;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

// Клавиатура выбора часа для предложения времени администратором
function adminProposeHourKeyboard(orderId, yyyymmdd) {
  const hours = [];
  for (let h = 5; h <= 24; h++) hours.push(h);
  const rows = [];
  for (let i = 0; i < hours.length; i += 4) {
    rows.push(
      hours.slice(i, i + 4).map((h) => ({
        text: `${pad2(h)}:00`,
        callback_data: `APROP_MH:${orderId}:${yyyymmdd}:${pad2(h)}`,
      }))
    );
  }
  rows.push([{ text: "⬅ Дата", callback_data: `APROP_MB:${orderId}:${yyyymmdd.slice(0, 6)}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

// Мульти-выбор: selected — массив выбранных индексов
function optionsKeyboard(orderId, selected = []) {
  const rows = [];

  // Вспомогательная функция: рядами по 2 кнопки из массива названий
  const addGroup = (header, names) => {
    rows.push([{ text: header, callback_data: "NOOP" }]);
    for (let i = 0; i < names.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, names.length); j++) {
        const idx = OPTIONS.indexOf(names[j]);
        row.push({
          text: (selected.includes(idx) ? "✅ " : "") + names[j],
          callback_data: `ADMIN_OPT:${orderId}:${idx}`,
        });
      }
      rows.push(row);
    }
  };

  addGroup("🔧 Устройства", OPTIONS_DEVICES);
  addGroup("🔩 Аксессуары", OPTIONS_ACCESSORIES);
  addGroup("📦 Другое", OPTIONS_OTHER);

  if (selected.length > 0) {
    rows.push([{ text: `✅ Подтвердить выбор (${selected.length})`, callback_data: `ADMIN_OPT_CONFIRM:${orderId}` }]);
  }
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

// Клавиатура для шага ввода комментария: Отправить + Отмена
function adminCommentKeyboard(orderId) {
  return {
    inline_keyboard: [[
      { text: "✅ Отправить", callback_data: `ADMIN_SUBMIT_COMMENT:${orderId}` },
      { text: "❌ Отмена",   callback_data: "CANCEL" },
    ]],
  };
}

// Клавиатура выбора количества устройства (1-10 + ввод вручную)
function qtyKeyboard(orderId) {
  return {
    inline_keyboard: [
      [1, 2, 3, 4, 5].map(n => ({ text: String(n), callback_data: `ADMIN_QTY:${orderId}:${n}` })),
      [6, 7, 8, 9, 10].map(n => ({ text: String(n), callback_data: `ADMIN_QTY:${orderId}:${n}` })),
      [{ text: "✏️ Больше...", callback_data: `ADMIN_QTY_CUSTOM:${orderId}` }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

// Клавиатура оценки времени установки (при 5+ устройств)
function installTimeKeyboard(orderId) {
  return {
    inline_keyboard: [
      [1, 2, 3, 4].map(h => ({ text: `${h} ч`, callback_data: `INST_TIME:${orderId}:${h}` })),
      [5, 6, 8, 10].map(h => ({ text: `${h} ч`, callback_data: `INST_TIME:${orderId}:${h}` })),
      [{ text: "⏩ Пропустить", callback_data: `INST_TIME:${orderId}:0` }],
    ],
  };
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
      dedupe.set(update.update_id, Date.now());
    }

    if (update.message) {
      const msg = update.message;
      let msgType = "text";
      if (msg.photo) msgType = "photo";
      else if (msg.document) msgType = "document";
      else if (msg.video) msgType = "video";
      else if (msg.voice) msgType = "voice";
      else if (msg.sticker) msgType = "sticker";
      else if (msg.video_note) msgType = "video_note";
      else if (msg.contact) msgType = "contact";
      else if (msg.location) msgType = "location";
      logEvent({ actorId: msg.chat?.id, action: "message", targetId: null, meta: { type: msgType, preview: (msg.text || msg.caption || "").slice(0, 150), user: { id: msg.from?.id, username: msg.from?.username || null, fullName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || null } } });
      await onMessage(update.message);
    }
    if (update.callback_query) {
      const cq = update.callback_query;
      logEvent({ actorId: cq.from?.id, action: "callback", targetId: null, meta: { data: (cq.data || "").slice(0, 200), user: { id: cq.from?.id, username: cq.from?.username || null, fullName: [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(" ") || null } } });
      await onCallback(update.callback_query);
    }
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
  const from = message.from || {};

  // При каждом сообщении обновляем профиль (имя, username)
  if (from && message.chat?.type === "private") {
    const cid = String(chatId);
    if (!userProfiles[cid]) userProfiles[cid] = {};
    userProfiles[cid].username = from.username ?? userProfiles[cid].username;
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
    if (fullName) userProfiles[cid].name = fullName;
  }

  if (!isAuthorized(chatId)) {
    await sendMessage(chatId, "⛔ Доступ не выдан. Запрос отправлен администратору.");
    pendingApprovalInfo.set(String(chatId), { username: from.username });
    let msgType = "текст";
    if (message.photo) msgType = "фото";
    else if (message.document) msgType = "документ";
    else if (message.video) msgType = "видео";
    else if (message.voice) msgType = "голос";
    else if (message.sticker) msgType = "стикер";
    else if (message.video_note) msgType = "видеозаметка";
    else if (message.contact) msgType = "контакт";
    else if (message.location) msgType = "геолокация";
    const content = message.text || message.caption || "(нет текста/подписи)";
    const reqText = `Заявка на доступ:\nchatId: ${chatId}\nusername: @${from.username || "-"}\nИмя: ${from.first_name || "-"} ${from.last_name || "-"}\nТип: ${msgType}\nСодержимое: ${content}`;
    const approveKb = { inline_keyboard: [[{ text: "✅ Approve MASTER", callback_data: `APPROVE_MASTER:${chatId}` }, { text: "✅ Approve ADMIN", callback_data: `APPROVE_ADMIN:${chatId}` }], [{ text: "❌ Decline", callback_data: `DECLINE:${chatId}` }]] };
    await safeSend(SUPER_ADMIN_ID, reqText, { reply_markup: approveKb });
    if (String(ADMIN_CHAT_ID) !== String(SUPER_ADMIN_ID)) await safeSend(ADMIN_CHAT_ID, reqText, { reply_markup: approveKb });
    return;
  }

  // Уведомление админу при первом подключении мастера
  if (isMasterChat(chatId) && !seenMasters.has(String(chatId))) {
    seenMasters.add(String(chatId));
    const masterName = getMasterLabel(chatId);
    const notifyMsg = `🟢 Мастер ${masterName} впервые подключился к боту.`;
    safeSend(SUPER_ADMIN_ID, notifyMsg);
    if (String(ADMIN_CHAT_ID) !== String(SUPER_ADMIN_ID)) safeSend(ADMIN_CHAT_ID, notifyMsg);
  }

  // Если включён пароль — проверяем доступ
  if (BOT_PASSWORD) {
    const st = getState(chatId);
    if (!isAuthorized(chatId)) {
      const enteredPassword = normalizePassword(text);
      // Принимаем пароль в любом случае (даже без /start), чтобы не ломаться при потере состояния
      if (enteredPassword && enteredPassword === BOT_PASSWORD) {
        setAuthorized(chatId);
        clearState(chatId);
        await sendMessage(chatId, "✅ Доступ разрешён. Меню активировано.", {
          reply_markup: menuKeyboardForChat(chatId),
        });
        return;
      }
      if (text.startsWith("/start")) {
        setState(chatId, "WAIT_PASSWORD", {});
        await sendMessage(chatId, "🔐 Введите пароль для доступа к боту:");
        return;
      }
      if (st && st.step === "WAIT_PASSWORD") {
        await sendMessage(chatId, "❌ Неверный пароль. Введите пароль ещё раз или нажмите /start.");
        return;
      }
      await sendMessage(chatId, "🔐 Доступ закрыт. Введите /start и укажите пароль.");
      return;
    }
  }

  // Команды оставим, но меню выдаём без /start
  if (text === "/start") {
    const fromId = message.from?.id;
    const keyboard = fromId != null && String(fromId) === String(SUPER_ADMIN_ID)
      ? adminMenuReplyKeyboard(chatId)
      : menuKeyboardForChat(chatId);
    await sendMessage(chatId, "✅ Меню активировано.", { reply_markup: keyboard });
    return;
  }
  if (text === "/getmyid") {
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

  if (text === "📊 Отчёт" || text === "📊 Мой отчёт") {
    const isMaster = isMasterChat(chatId);
    const scope = isMaster ? "MASTER" : "ADMIN";
    const masterTgId = isMaster ? chatId : null;

    setState(chatId, "REPORT_WAIT_PERIOD", { scope, masterTgId });
    await sendMessage(chatId, "📊 Выберите период отчёта:", {
      reply_markup: reportPeriodKeyboard(),
    });
    return;
  }
  // Private Admin ↔ Super Admin chat
  if (text === "🧑‍💼💬 Чат с супер-админом" || text === "🧑‍💼💬 Чат с админом") {
    if (!ADMIN_CHAT_ID || !SUPER_ADMIN_ID) {
      await sendMessage(chatId, "⚠️ Не настроены ADMIN_CHAT_ID / SUPER_ADMIN_ID в переменных окружения.");
      return;
    }
    const peerId = String(chatId) === String(SUPER_ADMIN_ID) ? String(ADMIN_CHAT_ID) : String(SUPER_ADMIN_ID);
    setState(chatId, "ADMIN_SUPER_CHAT", { peerId });
    await sendMessage(chatId, `✅ Режим чата включён. Сообщения будут отправляться напрямую.

Чтобы выйти — отправьте: /cancel`);
    return;
  }

  if (text === "💬 Написать админу" || text === "💬 Продолжить чат" || text === "💬 Чат с мастером") {
    if (isMasterChat(chatId)) {
      // мастер: чат с админом
      setState(chatId, "MASTER_CHAT_WITH_ADMIN", {});
      await sendMessage(chatId, "💬 Чат с админом. Напишите сообщение. Для выхода нажмите «❌ Отмена».", {
        reply_markup: masterMenuReplyKeyboard(),
      });
      return;
    } else {
      // только назначенный админ или супер-админ могут начинать чат с мастерами
      if (String(chatId) !== String(ADMIN_CHAT_ID) && String(chatId) !== String(SUPER_ADMIN_ID)) {
        await sendMessage(chatId, "⚠️ У вас нет прав для общения с мастерами.", {
          reply_markup: menuKeyboardForChat(chatId),
        });
        return;
      }
      // админ: сначала выбрать мастера
      setState(chatId, "ADMIN_CHAT_PICK_MASTER", {});
      await sendMessage(chatId, "💬 Выберите мастера:", {
        reply_markup: mastersChatKeyboard(),
      });
      return;
    }
  }

  if (text === "📋 Новая заявка") {
    setState(chatId, "ADMIN_WAIT_PHONE", { presetType: "INSTALL" });
    await sendMessage(chatId, "📞 Введите номер телефона клиента:", { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  if (text === "🔧 Ремонт / другое") {
    setState(chatId, "ADMIN_WAIT_PHONE", { presetType: "REPAIR" });
    await sendMessage(chatId, "📞 Введите номер телефона клиента:", { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  if (String(chatId) === String(SUPER_ADMIN_ID) || String(chatId) === String(ADMIN_CHAT_ID)) {
    const stApp = getState(chatId);
    if (stApp && stApp.step === "APPROVE_MASTER_NAME") {
      const applicantChatId = stApp.data.applicantChatId;
      const name = text.trim();
      if (!name || name.length > 80) {
        await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:");
        return;
      }
      setState(chatId, "APPROVE_MASTER_CITY", { applicantChatId, name });
      await sendMessage(chatId, "🏙 Введите город для мастера (текстом). Например: Душанбе");
      return;
    }
    if (stApp && stApp.step === "APPROVE_MASTER_CITY") {
      const applicantChatId = stApp.data.applicantChatId;
      const name = stApp.data.name;
      const city = text.trim();
      if (city.length < 2 || city.length > 40) {
        await sendMessage(chatId, "Город должен быть от 2 до 40 символов. Введите снова:");
        return;
      }
      clearState(chatId);
      const username = pendingApprovalInfo.get(String(applicantChatId))?.username ?? userProfiles[String(applicantChatId)]?.username;
      pendingApprovalInfo.delete(String(applicantChatId));
      authorizedChatIds.add(String(applicantChatId));
      authorizedRoles.set(String(applicantChatId), "MASTER");
      authorizedMasterCity.set(String(applicantChatId), city);
      activeMasterIds.add(String(applicantChatId));
      dynamicMasters.set(String(applicantChatId), { name, city });
      userProfiles[String(applicantChatId)] = { name, city, role: "MASTER", username: username ?? null };
      saveData();
      logEvent({ actorId: chatId, action: "approve_master", targetId: applicantChatId, meta: { name, city } });
      await sendMessage(applicantChatId, `✅ Доступ выдан. Роль: MASTER. Город: ${city}. Меню активировано.`, { reply_markup: masterMenuReplyKeyboard() });
      await sendMessage(chatId, `✅ Мастер активирован: ${name}, ${city} (chatId: ${applicantChatId})`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    if (stApp && stApp.step === "APPROVE_ADMIN_NAME") {
      const applicantChatId = stApp.data.applicantChatId;
      const name = text.trim();
      if (!name || name.length > 80) {
        await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:");
        return;
      }
      clearState(chatId);
      const username = pendingApprovalInfo.get(String(applicantChatId))?.username ?? userProfiles[String(applicantChatId)]?.username;
      pendingApprovalInfo.delete(String(applicantChatId));
      authorizedChatIds.add(String(applicantChatId));
      authorizedRoles.set(String(applicantChatId), "ADMIN");
      userProfiles[String(applicantChatId)] = { name, city: null, role: "ADMIN", username: username ?? null };
      saveData();
      logEvent({ actorId: chatId, action: "approve_admin", targetId: applicantChatId, meta: { name } });
      await sendMessage(applicantChatId, "✅ Доступ выдан. Роль: ADMIN. Меню активировано.", { reply_markup: adminMenuReplyKeyboard(applicantChatId) });
      await sendMessage(chatId, `✅ Пользователь одобрен как ADMIN: ${name} (chatId: ${applicantChatId})`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    if (stApp && stApp.step === "MASTER_EDIT_NAME") {
      const targetTgId = stApp.data.targetTgId;
      const name = text.trim();
      if (!name || name.length > 80) {
        await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:");
        return;
      }
      setState(chatId, "MASTER_EDIT_CITY", { targetTgId, name });
      await sendMessage(chatId, "🏙 Введите город для мастера:");
      return;
    }
    if (stApp && stApp.step === "MASTER_EDIT_CITY") {
      const targetTgId = stApp.data.targetTgId;
      const name = stApp.data.name;
      const city = text.trim();
      if (city.length < 2 || city.length > 40) {
        await sendMessage(chatId, "Город от 2 до 40 символов. Введите снова:");
        return;
      }
      clearState(chatId);
      const sid = String(targetTgId);
      if (userProfiles[sid]) { userProfiles[sid].name = name; userProfiles[sid].city = city; }
      else userProfiles[sid] = { name, city, role: "MASTER", username: null };
      dynamicMasters.set(sid, { name, city });
      authorizedMasterCity.set(sid, city);
      saveData();
      logEvent({ actorId: chatId, action: "master_edit", targetId: targetTgId, meta: { name, city } });
      await sendMessage(chatId, `✅ Мастер обновлён: ${name}, ${city}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    if (stApp && stApp.step === "ROLE_SET_MASTER_CITY") {
      const targetTgId = stApp.data.targetTgId;
      const city = text.trim();
      if (city.length < 2 || city.length > 40) {
        await sendMessage(chatId, "Город от 2 до 40 символов. Введите снова:");
        return;
      }
      clearState(chatId);
      const sid = String(targetTgId);
      authorizedRoles.set(sid, "MASTER");
      activeMasterIds.add(sid);
      if (userProfiles[sid]) { userProfiles[sid].role = "MASTER"; userProfiles[sid].city = city; }
      else userProfiles[sid] = { name: sid, city, role: "MASTER", username: null };
      authorizedMasterCity.set(sid, city);
      dynamicMasters.set(sid, { name: userProfiles[sid].name || sid, city });
      saveData();
      logEvent({ actorId: chatId, action: "role_change_master", targetId: targetTgId, meta: { city } });
      await sendMessage(chatId, `✅ Роль установлена: MASTER, город ${city}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
  }

  if (text === "📒 Журнал (Excel)" && String(chatId) === String(SUPER_ADMIN_ID)) {
    await sendAuditExcel(chatId);
    return;
  }
  if (text === "📇 Контакты (Excel)" && String(chatId) === String(SUPER_ADMIN_ID)) {
    await sendContactsExcel(chatId);
    return;
  }
  if (text === "🔁 Роли" && String(chatId) === String(SUPER_ADMIN_ID)) {
    const entries = [...authorizedRoles.entries()].filter(([, role]) => role === "ADMIN" || role === "MASTER");
    const rows = entries.slice(0, 50).map(([cid, role]) => {
      const p = userProfiles[cid];
      const label = (p && p.name) ? `${p.name} (${role})` : `${cid} (${role})`;
      return [{ text: label, callback_data: `ROLE_EDIT:${cid}` }];
    });
    rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
    await sendMessage(chatId, "🔁 Смена ролей. Выберите пользователя:", { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (text === "👷 Мастера") {
    await sendMessage(chatId, "👷 Мастера:", {
      reply_markup: { inline_keyboard: [[{ text: "✅ Активные", callback_data: "MLIST:ACTIVE" }, { text: "🗃 Неактивные", callback_data: "MLIST:INACTIVE" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] },
    });
    return;
  }

  // FSM
  const st = getState(chatId);
  if (!st) {
    // Если человек написал что-то без процесса — просто покажем меню
    await sendMessage(chatId, "Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  // ADMIN: чат с выбранным мастером
  if (st.step === "ADMIN_CHAT_WITH_MASTER") {
    const masterTgId = st.data.masterTgId;
    const masterName = getMasterInfo(masterTgId).name;
    const hasContent = text || message.photo || message.document || message.video ||
      message.voice || message.audio || message.video_note || message.sticker ||
      message.contact || message.location;
    if (hasContent) {
      await forwardChatMessage(message, masterTgId, "💬 Сообщение от админа");
      if (String(chatId) === String(ADMIN_CHAT_ID)) {
        await forwardChatMessage(message, SUPER_ADMIN_ID, `📡 Чат админа с мастером ${masterName}`);
      }
      await sendMessage(chatId, `✅ Отправлено ${masterName}.`, { reply_markup: adminMenuReplyKeyboard(chatId) });
    }
    return;
  }

  // MASTER: чат с админом
  if (st.step === "MASTER_CHAT_WITH_ADMIN") {
    const masterName = getMasterInfo(chatId).name;
    const hasContent = text || message.photo || message.document || message.video ||
      message.voice || message.audio || message.video_note || message.sticker ||
      message.contact || message.location;
    if (hasContent) {
      await forwardChatMessage(message, ADMIN_CHAT_ID, `💬 Мастер ${masterName}`);
      if (String(SUPER_ADMIN_ID) !== String(ADMIN_CHAT_ID)) {
        await forwardChatMessage(message, SUPER_ADMIN_ID, `📡 Мастер ${masterName} → админу`);
      }
      await sendMessage(chatId, "✅ Отправлено админу.", { reply_markup: masterMenuReplyKeyboard() });
    }
    return;
  }

  // ADMIN: ждём телефон
  if (st.step === "ADMIN_WAIT_PHONE") {
    const phoneDigits = text.replace(/\D/g, "");
    if (phoneDigits.length !== 9) {
      const hint = phoneDigits.length < 9
        ? `Введено ${phoneDigits.length} цифр — не хватает ${9 - phoneDigits.length}.`
        : `Введено ${phoneDigits.length} цифр — лишние ${phoneDigits.length - 9}.`;
      await sendMessage(chatId, `⚠️ Номер телефона должен содержать строго 9 цифр (без кода страны).\n${hint}\nПопробуйте ещё раз.`, {
        reply_markup: adminMenuReplyKeyboard(chatId),
      });
      return;
    }
    st.data.phone = phoneDigits;
    setState(chatId, "ADMIN_WAIT_MASTER", st.data);
    await sendMessage(chatId, "Выберите мастера (город подтянется автоматически):", {
      reply_markup: adminMenuReplyKeyboard(chatId),
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
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    order.address = text;

    // дальше: REPAIR -> comment, INSTALL -> options
    if (order.type === "REPAIR") {
      setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
      await sendMessage(
        chatId,
        `🧰 Ремонт / другое\n🚗 Выезд к клиенту\n📍 Адрес: ${order.address}\n\n✍️ Напишите комментарий (что сломано / что нужно сделать):`,
        { reply_markup: adminCommentKeyboard(orderId) }
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

  // ADMIN: ждём ввод произвольного количества устройства
  if (st.step === "ADMIN_WAIT_QTY_CUSTOM") {
    const { orderId, qtyIdx, quantities } = st.data;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    const qty = parseInt(text, 10);
    if (!qty || qty < 1 || qty > 999) {
      await sendMessage(chatId, "⚠️ Введите число от 1 до 999:");
      return;
    }
    const deviceName = order.options[qtyIdx];
    quantities[deviceName] = qty;
    const nextIdx = qtyIdx + 1;
    if (nextIdx < order.options.length) {
      setState(chatId, "ADMIN_WAIT_QTY", { orderId, qtyIdx: nextIdx, quantities });
      await sendMessage(chatId, `✅ ${deviceName}: ${qty} шт.\n\n🔢 Сколько ${order.options[nextIdx]}?`, {
        reply_markup: qtyKeyboard(orderId),
      });
      return;
    }
    order.deviceQuantities = { ...quantities };
    order.totalDevices = Object.values(quantities).reduce((a, b) => a + b, 0);
    const qtyText = order.options.map(o => `${o} × ${quantities[o]}`).join(", ");
    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
    await sendMessage(chatId, `✅ ${deviceName}: ${qty} шт.\n✅ Устройства: ${qtyText}\n\n✍️ Напишите комментарий:`, {
      reply_markup: adminCommentKeyboard(orderId),
    });
    return;
  }

  // ADMIN: ждём комментарий (для монтажа/ремонта/другого)
  if (st.step === "ADMIN_WAIT_COMMENT") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    order.adminComment = text;
    order.status = "SENT_TO_MASTER";
    logEvent({
      actorId: chatId,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });

    clearState(chatId);

    // отправка мастеру
    await sendOrderToMaster(order);

    // подтверждение админу
    await sendMessage(chatId, formatAdminConfirm(order), { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  // MASTER: выбор времени делается через календарь/часы (см. callback-обработчики MN/MD/MH/MM)

  // MASTER: отправка фото по кнопке (номер / пробег / устройство)
  if (st.step === "MASTER_WAIT_PHOTO") {
    const orderId   = st.data.orderId;
    const photoType = st.data.photoType;
    const origMsgId = st.data.messageId; // сообщение с клавиатурой заявки
    const frMsgId   = st.data.frMsgId;   // force_reply сообщение
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
      await sendMessage(chatId, "⚠️ Пожалуйста, отправьте именно фото.");
      return;
    }

    // Удаляем force_reply сообщение и само фото мастера из чата
    if (frMsgId) {
      await tg("deleteMessage", { chat_id: chatId, message_id: frMsgId }).catch(() => {});
    }
    await tg("deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => {});

    const fileId = photos[photos.length - 1].file_id;
    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;

    if (!order.devicePhotos) order.devicePhotos = {};
    order.devicePhotos[photoType] = fileId;
    const slot = getPhotoSlots(order).find(s => s.key === photoType);
    const photoLabel = slot ? slot.label : photoType;

    // Пересылаем фото администратору
    const photoDate = order.createdAt ? formatDate(new Date(order.createdAt)) : "—";
    const photoCaption =
      `📷 ${photoLabel}\n` +
      `📋 Заявка #${order.id}\n` +
      `📅 Дата: ${photoDate}\n` +
      `📞 Клиент: ${order.phone || "—"}`;
    await sendPhoto(adminChatIdImm, fileId, photoCaption).catch(() => {});
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) {
      sendPhoto(SUPER_ADMIN_ID, fileId, photoCaption).catch(() => {});
    }

    clearState(chatId);
    const kb = masterArrivalPhotoKeyboard(orderId, order);

    if (kb) {
      // Убираем клавиатуру из старого сообщения
      if (origMsgId) {
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: origMsgId,
          text: `✅ ${photoLabel} — принято (заявка #${order.id})`,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
      // Отправляем НОВОЕ сообщение с кнопками НИЖЕ фото
      await sendMessage(chatId, `📷 Заявка #${order.id} — выберите следующее:`, { reply_markup: kb });
      return;
    }

    // Все фото/пропуски собраны
    setState(chatId, "MASTER_WAIT_DONE", { orderId });
    const warnMsg = getMissingPhotoWarning(order);
    const adminChatIdW = order.adminChatId || SUPER_ADMIN_ID;
    if (warnMsg) {
      safeSend(adminChatIdW, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnMsg}`);
      if (String(adminChatIdW) !== String(SUPER_ADMIN_ID)) {
        safeSend(SUPER_ADMIN_ID, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnMsg}`);
      }
    }
    const doneText =
      `✅ Заявка #${order.id} — все фото сохранены.` +
      (warnMsg ? `\n\n${warnMsg}` : "") +
      `\n\n<b>По завершению работ нажмите «✅ Выполнено».</b>`;
    if (origMsgId) {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: origMsgId,
        text: doneText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] },
      }).catch(() => {});
    } else {
      if (warnMsg) await sendMessage(chatId, warnMsg);
      await sendMessage(chatId, doneText, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] },
      });
    }
    return;
  }


  if (st.step === "MASTER_WAIT_DONE") {
    await sendMessage(chatId, "Нажмите кнопку «✅ Выполнено» в сообщении выше.", {
      reply_markup: masterMenuReplyKeyboard(),
    });
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

  if (data.startsWith("APPROVE_ADMIN:")) {
    const applicantChatId = data.slice("APPROVE_ADMIN:".length);
    const fromId = cb.from && cb.from.id;
    const isAdmin = String(fromId) === String(SUPER_ADMIN_ID) || String(fromId) === String(ADMIN_CHAT_ID);
    if (!isAdmin) {
      await answerCb(cb.id, "⛔ Только админ может одобрять.", true);
      return;
    }
    setState(chatId, "APPROVE_ADMIN_NAME", { applicantChatId });
    await sendMessage(chatId, "✏️ Введите имя пользователя (для роли ADMIN):");
    await answerCb(cb.id, "Ожидаю ввод имени");
    return;
  }
  if (data.startsWith("APPROVE_MASTER:")) {
    const applicantChatId = data.slice("APPROVE_MASTER:".length);
    const fromId = cb.from && cb.from.id;
    const isAdmin = String(fromId) === String(SUPER_ADMIN_ID) || String(fromId) === String(ADMIN_CHAT_ID);
    if (!isAdmin) {
      await answerCb(cb.id, "⛔ Только админ может одобрять.", true);
      return;
    }
    setState(chatId, "APPROVE_MASTER_NAME", { applicantChatId });
    await sendMessage(chatId, "✏️ Введите имя мастера:");
    await answerCb(cb.id, "Ожидаю ввод имени");
    return;
  }
  if (data.startsWith("DECLINE:")) {
    const applicantChatId = data.slice("DECLINE:".length);
    const fromId = cb.from && cb.from.id;
    const isAdmin = String(fromId) === String(SUPER_ADMIN_ID) || String(fromId) === String(ADMIN_CHAT_ID);
    if (!isAdmin) {
      await answerCb(cb.id, "⛔ Только админ может отклонять.", true);
      return;
    }
    logEvent({ actorId: chatId, action: "decline_access", targetId: applicantChatId, meta: null });
    await safeSend(applicantChatId, "❌ Доступ отклонён.");
    await answerCb(cb.id, "Отклонено.");
    return;
  }

  if (!isAuthorized(chatId) && data !== "CANCEL") {
    await answerCb(cb.id, "⛔ Доступ не выдан.", true);
    return;
  }

  // Сразу отвечаем на callback (убирает спиннер), не ожидая
  answerCb(cb.id).catch(() => {});

  if (BOT_PASSWORD && !isAuthorized(chatId)) {
    await sendMessage(chatId, "🔐 Доступ закрыт. Введите /start и укажите пароль.");
    return;
  }

  // Разделители в клавиатурах (не кликабельные заголовки)
  if (data === "NOOP") return;

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

  const fromId = cb.from && cb.from.id;
  const isAdminCb = String(fromId) === String(SUPER_ADMIN_ID) || String(fromId) === String(ADMIN_CHAT_ID);

  const isSuperAdminCb = String(fromId) === String(SUPER_ADMIN_ID);
  if (data === "MLIST:ACTIVE") {
    if (!isAdminCb) return;
    const rows = [...activeMasterIds].map((tid) => {
      const row = [{ text: `⛔ ${getMasterLabel(tid)}`, callback_data: `MASTER_DEACT:${tid}` }];
      row.push({ text: "✏️ Имя/Город", callback_data: `MASTER_EDIT:${tid}` });
      return row;
    });
    rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
    await editMessage(chatId, messageId, "✅ Активные мастера:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data === "MLIST:INACTIVE") {
    if (!isAdminCb) return;
    const rows = [...inactiveMasterIds].map((tid) => {
      const row = [{ text: `✅ ${getMasterLabel(tid)}`, callback_data: `MASTER_ACT:${tid}` }];
      row.push({ text: "✏️ Имя/Город", callback_data: `MASTER_EDIT:${tid}` });
      return row;
    });
    rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
    await editMessage(chatId, messageId, "🗃 Неактивные мастера:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith("MASTER_DEACT:")) {
    const tgId = data.slice("MASTER_DEACT:".length);
    if (!isAdminCb) return;
    activeMasterIds.delete(String(tgId));
    inactiveMasterIds.add(String(tgId));
    saveData();
    logEvent("master_deactivate", { actorId: chatId, targetId: tgId });
    const rows = [...activeMasterIds].map((tid) => {
      const row = [{ text: `⛔ ${getMasterLabel(tid)}`, callback_data: `MASTER_DEACT:${tid}` }];
      row.push({ text: "✏️ Имя/Город", callback_data: `MASTER_EDIT:${tid}` });
      return row;
    });
    rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
    await editMessage(chatId, messageId, "✅ Активные мастера:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith("MASTER_ACT:")) {
    const tgId = data.slice("MASTER_ACT:".length);
    if (!isAdminCb) return;
    inactiveMasterIds.delete(String(tgId));
    activeMasterIds.add(String(tgId));
    saveData();
    logEvent("master_activate", { actorId: chatId, targetId: tgId });
    const rows = [...inactiveMasterIds].map((tid) => {
      const row = [{ text: `✅ ${getMasterLabel(tid)}`, callback_data: `MASTER_ACT:${tid}` }];
      row.push({ text: "✏️ Имя/Город", callback_data: `MASTER_EDIT:${tid}` });
      return row;
    });
    rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
    await editMessage(chatId, messageId, "🗃 Неактивные мастера:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith("MASTER_EDIT:")) {
    const tgId = data.slice("MASTER_EDIT:".length);
    if (!isAdminCb) return;
    setState(chatId, "MASTER_EDIT_NAME", { targetTgId: tgId });
    await sendMessage(chatId, "✏️ Введите новое имя мастера:");
    await answerCb(cb.id).catch(() => {});
    return;
  }
  if (data.startsWith("ROLE_EDIT:")) {
    const targetChatId = data.slice("ROLE_EDIT:".length);
    if (!isSuperAdminCb) return;
    const rows = [
      [{ text: "Set ADMIN", callback_data: `ROLE_SET_ADMIN:${targetChatId}` }, { text: "Set MASTER", callback_data: `ROLE_SET_MASTER:${targetChatId}` }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ];
    await editMessage(chatId, messageId, `🔁 Роль для ${targetChatId}:`, { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith("ROLE_SET_ADMIN:")) {
    const targetChatId = data.slice("ROLE_SET_ADMIN:".length);
    if (!isSuperAdminCb) return;
    const sid = String(targetChatId);
    authorizedRoles.set(sid, "ADMIN");
    activeMasterIds.delete(sid);
    if (userProfiles[sid]) { userProfiles[sid].role = "ADMIN"; userProfiles[sid].city = null; }
    else userProfiles[sid] = { name: sid, city: null, role: "ADMIN", username: null };
    authorizedMasterCity.delete(sid);
    dynamicMasters.delete(sid);
    saveData();
    logEvent({ actorId: chatId, action: "role_change_admin", targetId: targetChatId, meta: null });
    await editMessage(chatId, messageId, `✅ Роль установлена: ADMIN для ${targetChatId}`);
    return;
  }
  if (data.startsWith("ROLE_SET_MASTER:")) {
    const targetChatId = data.slice("ROLE_SET_MASTER:".length);
    if (!isSuperAdminCb) return;
    const sid = String(targetChatId);
    const prof = userProfiles[sid];
    if (prof && prof.city) {
      authorizedRoles.set(sid, "MASTER");
      activeMasterIds.add(sid);
      if (userProfiles[sid]) userProfiles[sid].role = "MASTER"; else userProfiles[sid] = { name: sid, city: prof.city, role: "MASTER", username: null };
      authorizedMasterCity.set(sid, prof.city);
      dynamicMasters.set(sid, { name: prof.name || sid, city: prof.city });
      saveData();
      logEvent({ actorId: chatId, action: "role_change_master", targetId: targetChatId, meta: { city: prof.city } });
      await editMessage(chatId, messageId, `✅ Роль установлена: MASTER (${prof.city})`);
    } else {
      setState(chatId, "ROLE_SET_MASTER_CITY", { targetTgId: targetChatId });
      await sendMessage(chatId, "🏙 Введите город для мастера:");
      await answerCb(cb.id).catch(() => {});
    }
    return;
  }

  // Выбор типа/периода отчёта
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

    if (code === "PENDING") {
      await sendPendingReport(chatId, { scope, masterTgId });
      return;
    }

    if (code === "PERIOD") {
      const now = new Date();
      const yyyymm = formatYyyymm(now.getFullYear(), now.getMonth() + 1);
      setState(chatId, "REPORT_PICK_START", { scope, masterTgId, yyyymm });
      await editMessage(chatId, messageId, "📅 Свой период\n\nШаг 1 из 2 — выберите дату ОТ:", {
        reply_markup: reportCalendarKeyboard("START", yyyymm),
      });
      return;
    }

    // TODAY / YESTERDAY / THIS_MONTH / LAST_MONTH / LAST_7
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

  // Календарь отчёта: навигация по месяцу (начало периода)
  if (data.startsWith("RP_START_MN:")) {
    const yyyymm = data.split(":")[1];
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_PICK_START") return;
    setState(chatId, "REPORT_PICK_START", { ...st.data, yyyymm });
    await editMessage(chatId, messageId, "📅 Свой период\n\nШаг 1 из 2 — выберите дату ОТ:", {
      reply_markup: reportCalendarKeyboard("START", yyyymm),
    });
    return;
  }

  // Календарь отчёта: выбрана дата начала
  if (data.startsWith("RP_START_MD:")) {
    const yyyymmdd = data.split(":")[1];
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_PICK_START") return;
    const scope = st.data.scope || "ADMIN";
    const masterTgId = st.data.masterTgId || null;
    const d = parseYyyymmdd(yyyymmdd);
    if (!d) return;
    const fromDate = new Date(d.y, d.mo - 1, d.d);
    const fromLabel = formatDate(fromDate);
    setState(chatId, "REPORT_PICK_END", { scope, masterTgId, fromTs: fromDate.getTime(), yyyymm: yyyymmdd.slice(0, 6) });
    await editMessage(chatId, messageId, `📅 Свой период\nОТ: ${fromLabel}\n\nШаг 2 из 2 — выберите дату ДО:`, {
      reply_markup: reportCalendarKeyboard("END", yyyymmdd.slice(0, 6)),
    });
    return;
  }

  // Календарь отчёта: навигация по месяцу (конец периода)
  if (data.startsWith("RP_END_MN:")) {
    const yyyymm = data.split(":")[1];
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_PICK_END") return;
    const fromLabel = st.data.fromTs ? formatDate(new Date(st.data.fromTs)) : "—";
    setState(chatId, "REPORT_PICK_END", { ...st.data, yyyymm });
    await editMessage(chatId, messageId, `📅 Свой период\nОТ: ${fromLabel}\n\nШаг 2 из 2 — выберите дату ДО:`, {
      reply_markup: reportCalendarKeyboard("END", yyyymm),
    });
    return;
  }

  // Календарь отчёта: выбрана дата окончания — формируем отчёт
  if (data.startsWith("RP_END_MD:")) {
    const yyyymmdd = data.split(":")[1];
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_PICK_END") return;
    const scope = st.data.scope || "ADMIN";
    const masterTgId = st.data.masterTgId || null;
    const fromTs = st.data.fromTs;
    const d = parseYyyymmdd(yyyymmdd);
    if (!d || fromTs == null) return;
    const fromDate = new Date(fromTs);
    const toDate = new Date(d.y, d.mo - 1, d.d, 23, 59, 59, 999);
    if (toDate.getTime() < fromDate.getTime()) toDate.setTime(fromDate.getTime());
    clearState(chatId);
    await editMessage(chatId, messageId, `📊 Отчёт за период ${formatDate(fromDate)}–${formatDate(toDate)} формируется...`);
    await sendTextReport(chatId, fromDate, toDate, { scope, masterTgId });
    return;
  }

  // Отправить отчёт в Excel (после просмотра текстового отчёта)
  if (data === "REPORT_EXCEL") {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_SENT") {
      await sendMessage(chatId, "⚠️ Сначала сформируйте отчёт (📊 Отчёт).", {
        reply_markup: menuKeyboardForChat(chatId),
      });
      return;
    }
    const scope = st.data.scope || "ADMIN";
    const masterTgId = st.data.masterTgId || null;
    let filePath;
    try {
      if (st.data.pending) {
        filePath = buildExcelReportPending({ scope, masterTgId });
        await sendDocument(chatId, filePath, "📋 Ожидающие заявки");
        logEvent({
          actorId: cb.from && cb.from.id,
          action: "excel_export_pending",
          targetId: null,
          meta: { scope, masterTgId },
        });
      } else {
        const from = new Date(st.data.fromTs);
        const to = new Date(st.data.toTs);
        filePath = buildExcelReport(from, to, { scope, masterTgId });
        await sendDocument(chatId, filePath, `📊 Отчёт ${formatDate(from)}–${formatDate(to)}`);
        logEvent({
          actorId: cb.from && cb.from.id,
          action: "excel_export_report",
          targetId: null,
          meta: { scope, masterTgId, from: from.toISOString(), to: to.toISOString() },
        });
      }
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

    const dayChoice = data.split(":")[2]; // TODAY | TOMORROW

    order.status = "ACCEPTED_BY_MASTER";
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });
    if (!order.acceptedAt) order.acceptedAt = new Date().toISOString();
    await editMessage(
      chatId,
      messageId,
      formatOrderForMaster(order) + "\n\n✅ Вы взяли эту заявку.",
    );

    const now = new Date();

    if (dayChoice === "TODAY" || dayChoice === "TOMORROW") {
      // Пропускаем календарь — сразу выбор часа
      const target = new Date(now);
      if (dayChoice === "TOMORROW") target.setDate(target.getDate() + 1);
      order.acceptPlannedDayAt = target.toISOString();

      const yyyymmdd = `${target.getFullYear()}${pad2(target.getMonth() + 1)}${pad2(target.getDate())}`;
      setState(chatId, "MASTER_PICK_HOUR", { orderId, yyyymmdd });
      const dayLabel = dayChoice === "TODAY" ? "сегодня" : "завтра";
      await sendMessage(chatId, `🕒 Вы берёте заявку на ${dayLabel}. Выберите час:`, {
        reply_markup: masterHourKeyboard(orderId, yyyymmdd),
      });
    } else {
      // Обычный поток — выбор даты через календарь
      const yyyymm = formatYyyymm(now.getFullYear(), now.getMonth() + 1);
      setState(chatId, "MASTER_PICK_DATE", { orderId, yyyymm });
      await sendMessage(chatId, "📅 Выберите дату визита:", {
        reply_markup: masterCalendarKeyboard(orderId, yyyymm),
      });
    }

    const dayLabel = dayChoice === "TODAY" ? " (сегодня)" : dayChoice === "TOMORROW" ? " (завтра)" : " (выбирает дату)";
    const acceptMsg = `✅ Мастер ${order.masterName} взял заявку #${order.id}${dayLabel}.`;

    if (order.adminChatId) {
      await sendMessage(order.adminChatId, acceptMsg, { reply_markup: adminMenuReplyKeyboard(chatId) });
    }
    // Супер-админ всегда получает уведомление
    if (String(order.adminChatId) !== String(SUPER_ADMIN_ID)) {
      await safeSend(SUPER_ADMIN_ID, acceptMsg);
    }

    return;
  }

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

    const dp = parseYyyymmdd(yyyymmdd);
    if (dp) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const chosen = new Date(dp.y, dp.mo - 1, dp.d);
      if (chosen < today) {
        await editMessage(
          chatId, messageId,
          `⚠️ Нельзя выбрать прошедшую дату (${pad2(dp.d)}.${pad2(dp.mo)}.${dp.y}).\nВыберите сегодня или позже:`,
          { reply_markup: masterCalendarKeyboard(orderId, yyyymmdd.slice(0, 6)) }
        );
        return;
      }
    }

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

    // Проверка прошедшего времени
    const chosen = new Date(d.y, d.mo - 1, d.d, Number(hh), 0);
    if (chosen <= new Date()) {
      await editMessage(
        chatId, messageId,
        `⚠️ Нельзя выбрать прошедшее время (${hh}:00 ${pad2(d.d)}.${pad2(d.mo)}.${d.y}).\nВыберите более позднее время:`,
        { reply_markup: masterHourKeyboard(orderId, yyyymmdd) }
      );
      return;
    }

    const timeText = `${pad2(d.d)}.${pad2(d.mo)}.${d.y} ${hh}:00`;

    order.masterSuggestedTimeText = timeText;
    order.status = "WAIT_ADMIN_CONFIRM_TIME";
    clearState(chatId);

    await editMessage(chatId, messageId, `✅ Предложено время: ${timeText}\n\nОтправлено администратору.`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "CANCEL" }]] },
    });

    if (order.adminChatId) {
      const now2 = new Date();
      const yyyymm2 = formatYyyymm(now2.getFullYear(), now2.getMonth() + 1);
      await sendMessage(
        order.adminChatId,
        `🕒 Мастер ${order.masterName} предложил время для заявки #${order.id}:\n⏰ ${order.masterSuggestedTimeText}\n\nПодтвердить?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Подтвердить время", callback_data: `ADMIN_CONFIRM_TIME:${order.id}` }],
              [{ text: "🕒 Предложить другое", callback_data: `ADMIN_PROPOSE_TIME:${order.id}:${yyyymm2}` }],
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
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });
    await editMessage(
      chatId,
      messageId,
      formatOrderForMaster(order) + "\n\n❌ Вы отказались от этой заявки.",
    );

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `❌ Мастер ${order.masterName} отказался от заявки #${order.id}.`,
        { reply_markup: adminMenuReplyKeyboard(chatId) }
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
        reply_markup: adminMenuReplyKeyboard(chatId),
      });
      return;
    }

    order.confirmedTimeText = order.masterSuggestedTimeText || "";
    order.status = "TIME_CONFIRMED";
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });

    await editMessage(
      chatId,
      messageId,
      `✅ Время для заявки #${order.id} подтверждено:\n⏰ ${order.confirmedTimeText}`,
    );

    // Уведомление мастеру
    const isVisit = order.logistics === "VISIT";
    const arrivalBtnText = isVisit ? "🚗 Я у клиента" : "🚗 Клиент приехал";
    const arrivalPrompt = isVisit
      ? "Когда прибудете к клиенту, нажмите кнопку ниже:"
      : "Когда клиент приедет, нажмите кнопку ниже:";
    const commentPart = order.adminComment
      ? `\n\n<b>💬 Комментарий: ${order.adminComment}</b>`
      : "";
    await sendMessage(
      order.masterTgId,
      `✅ Администратор подтвердил время для заявки #${order.id}:\n⏰ ${order.confirmedTimeText}${commentPart}\n\n${arrivalPrompt}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: arrivalBtnText, callback_data: `MASTER_CLIENT_ARRIVED:${order.id}` }],
          ],
        },
      }
    );

    return;
  }

  // ADMIN: предлагает другое время (показ календаря)
  if (data.startsWith("ADMIN_PROPOSE_TIME:")) {
    const parts = data.split(":");
    const orderId = parts[1];
    const yyyymm = parts[2] || formatYyyymm(new Date().getFullYear(), new Date().getMonth() + 1);
    const order = orders.get(orderId);
    if (!order) { await sendMessage(chatId, "⚠️ Заявка не найдена."); return; }
    setState(chatId, "ADMIN_PROPOSE_DATE", { orderId, yyyymm });
    await editMessage(chatId, messageId, "📅 Выберите дату для предложения мастеру:", {
      reply_markup: adminProposeCalendarKeyboard(orderId, yyyymm),
    });
    return;
  }

  // ADMIN: навигация по календарю при предложении времени
  if (data.startsWith("APROP_MN:")) {
    const [, orderId, yyyymm] = data.split(":");
    const order = orders.get(orderId);
    if (!order) return;
    setState(chatId, "ADMIN_PROPOSE_DATE", { orderId, yyyymm });
    await editMessage(chatId, messageId, "📅 Выберите дату:", {
      reply_markup: adminProposeCalendarKeyboard(orderId, yyyymm),
    });
    return;
  }

  // ADMIN: выбрал дату
  if (data.startsWith("APROP_MD:")) {
    const [, orderId, yyyymmdd] = data.split(":");
    const order = orders.get(orderId);
    if (!order) return;
    setState(chatId, "ADMIN_PROPOSE_HOUR", { orderId, yyyymmdd });
    await editMessage(chatId, messageId, "🕒 Выберите час:", {
      reply_markup: adminProposeHourKeyboard(orderId, yyyymmdd),
    });
    return;
  }

  // ADMIN: назад к дате (из выбора часа)
  if (data.startsWith("APROP_MB:")) {
    const [, orderId, yyyymm] = data.split(":");
    const order = orders.get(orderId);
    if (!order) return;
    setState(chatId, "ADMIN_PROPOSE_DATE", { orderId, yyyymm });
    await editMessage(chatId, messageId, "📅 Выберите дату:", {
      reply_markup: adminProposeCalendarKeyboard(orderId, yyyymm),
    });
    return;
  }

  // ADMIN: выбрал час — отправляет предложение мастеру
  if (data.startsWith("APROP_MH:")) {
    const [, orderId, yyyymmdd, hh] = data.split(":");
    const order = orders.get(orderId);
    if (!order) return;
    const d = parseYyyymmdd(yyyymmdd);
    if (!d) return;
    const timeText = `${pad2(d.d)}.${pad2(d.mo)}.${d.y} ${hh}:00`;
    order.adminSuggestedTimeText = timeText;
    order.status = "WAIT_MASTER_CONFIRM_TIME";
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });
    clearState(chatId);
    await editMessage(chatId, messageId, `✅ Вы предложили время: ${timeText}\nОтправлено мастеру на подтверждение.`);
    await sendMessage(
      order.masterTgId,
      `⏰ Администратор предлагает время для заявки #${order.id}:\n<b>${timeText}</b>\n\nПримите или предложите своё:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Принять", callback_data: `MASTER_ACCEPT_TIME:${order.id}` }],
            [{ text: "🕒 Предложить своё", callback_data: `MASTER_RESUGGEST_TIME:${order.id}` }],
          ],
        },
      }
    );
    await sendMessage(chatId, "Ожидаем ответа мастера.", { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  // MASTER: принимает время предложенное админом
  if (data.startsWith("MASTER_ACCEPT_TIME:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;
    order.confirmedTimeText = order.adminSuggestedTimeText || "";
    order.status = "TIME_CONFIRMED";
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });
    await editMessage(chatId, messageId, `✅ Время принято: ${order.confirmedTimeText}`);
    const isVisit = order.logistics === "VISIT";
    const arrivalBtnText = isVisit ? "🚗 Я у клиента" : "🚗 Клиент приехал";
    const arrivalPrompt = isVisit ? "Когда прибудете к клиенту, нажмите кнопку ниже:" : "Когда клиент приедет, нажмите кнопку ниже:";
    const commentPart = order.adminComment ? `\n\n<b>💬 Комментарий: ${order.adminComment}</b>` : "";
    await sendMessage(
      chatId,
      `✅ Время для заявки #${order.id}: ${order.confirmedTimeText}${commentPart}\n\n${arrivalPrompt}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: arrivalBtnText, callback_data: `MASTER_CLIENT_ARRIVED:${order.id}` }]] },
      }
    );
    if (order.adminChatId) {
      await safeSend(order.adminChatId, `✅ Мастер ${order.masterName} принял время для заявки #${order.id}: ${order.confirmedTimeText}`);
    }
    if (String(order.adminChatId) !== String(SUPER_ADMIN_ID)) {
      await safeSend(SUPER_ADMIN_ID, `✅ Мастер ${order.masterName} принял время для заявки #${order.id}: ${order.confirmedTimeText}`);
    }
    return;
  }

  // MASTER: предлагает своё время в ответ на предложение админа (возвращаем к выбору даты)
  if (data.startsWith("MASTER_RESUGGEST_TIME:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;
    const now = new Date();
    const yyyymm = formatYyyymm(now.getFullYear(), now.getMonth() + 1);
    setState(chatId, "MASTER_PICK_DATE", { orderId, yyyymm });
    await editMessage(chatId, messageId, "📅 Выберите дату для предложения:", {
      reply_markup: masterCalendarKeyboard(orderId, yyyymm),
    });
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
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });

    const photoKb = masterArrivalPhotoKeyboard(orderId, order);
    const deviceUnitCount = photoKb
      ? getPhotoSlots(order).filter(s => s.photoType === "device").length
      : 0;

    if (photoKb && deviceUnitCount > 5) {
      // Много устройств — сначала просим оценку времени
      await editMessage(
        chatId, messageId,
        `🚗 Клиент по заявке #${order.id} прибыл.\n\n⚠️ Установок: ${deviceUnitCount} устр. Сколько времени займёт установка?`,
        { reply_markup: installTimeKeyboard(orderId) }
      );
    } else if (photoKb) {
      await editMessage(
        chatId, messageId,
        `🚗 Клиент по заявке #${order.id} прибыл в сервис.\n\nНажмите нужную кнопку ниже:`,
        { reply_markup: photoKb }
      );
    } else {
      // Только аксессуары — фото не нужны, сразу показываем «Выполнено»
      setState(chatId, "MASTER_WAIT_DONE", { orderId });
      await editMessage(
        chatId, messageId,
        `🚗 Клиент по заявке #${order.id} прибыл.\n\nФото не требуются. По завершению работ нажмите «✅ Выполнено».`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]],
          },
        }
      );
    }

    if (order.adminChatId) {
      await sendMessage(
        order.adminChatId,
        `🚗 Клиент по заявке #${order.id} прибыл в сервис.`,
        { reply_markup: adminMenuReplyKeyboard(chatId) }
      );
    }

    return;
  }

  // MASTER: оценил время установки (при 5+ устройств)
  if (data.startsWith("INST_TIME:")) {
    const [, orderId, hoursStr] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    const hours = Number(hoursStr);
    if (hours > 0) {
      order.estimatedInstallHours = hours;
      const note = `🛠 Мастер ${order.masterName}: заявка #${order.id} (${order.phone}) — оценка установки ~${hours} ч.`;
      if (order.adminChatId) {
        await safeSend(order.adminChatId, note);
      }
      if (String(order.adminChatId) !== String(SUPER_ADMIN_ID)) {
        await safeSend(SUPER_ADMIN_ID, note);
      }
    }

    const photoKb = masterArrivalPhotoKeyboard(orderId, order);
    if (photoKb) {
      const estLine = hours > 0 ? `⏱ Оценка: ~${hours} ч.\n\n` : "";
      await editMessage(
        chatId, messageId,
        `🚗 Клиент по заявке #${order.id} прибыл в сервис.\n\n${estLine}Нажмите нужную кнопку ниже:`,
        { reply_markup: photoKb }
      );
    } else {
      setState(chatId, "MASTER_WAIT_DONE", { orderId });
      await editMessage(
        chatId, messageId,
        `🚗 Клиент по заявке #${order.id} прибыл.\n\nФото не требуются. По завершению работ нажмите «✅ Выполнено».`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] } }
      );
    }
    return;
  }

  // MASTER: нажал кнопку фото — ждём отправку фото
  if (data.startsWith("MASTER_PHOTO:")) {
    const [, orderId, photoType] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    const slot = getPhotoSlots(order).find(s => s.key === photoType);
    const label = slot ? slot.label : photoType;

    // Обновляем текст сообщения — показываем какой слот ожидается
    await editMessage(
      chatId, messageId,
      `📷 Заявка #${order.id} — ожидается фото: ${label}`,
      { reply_markup: masterArrivalPhotoKeyboard(orderId, order) }
    ).catch(() => {});

    // force_reply открывает поле ответа (скрепка → Фото)
    const frResult = await tg("sendMessage", {
      chat_id: chatId,
      text: `📎 ${label} — прикрепите фото:`,
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: "Отправьте фото…" },
    }).catch(() => null);
    const frMsgId = frResult?.result?.message_id ?? null;

    // Сохраняем messageId клавиатуры и force_reply чтобы удалить после получения фото
    setState(chatId, "MASTER_WAIT_PHOTO", { orderId, photoType, messageId, frMsgId });
    return;
  }

  // MASTER: нажал «⏭ Без» — пропускаем слот
  if (data.startsWith("MASTER_SKIP:")) {
    const [, orderId, skipType] = data.split(":");
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    if (!order.devicePhotos) order.devicePhotos = {};
    order.devicePhotos[skipType] = "SKIPPED";
    const slot = getPhotoSlots(order).find(s => s.key === skipType);
    const skipLabel = slot ? slot.label : skipType;

    // Моментальное уведомление админу
    const skipAdminId = order.adminChatId || SUPER_ADMIN_ID;
    safeSend(skipAdminId, `📷 Нет фото: ${skipLabel} — заявка #${order.id} (${order.masterName})`);
    if (String(skipAdminId) !== String(SUPER_ADMIN_ID)) {
      safeSend(SUPER_ADMIN_ID, `📷 Нет фото: ${skipLabel} — заявка #${order.id} (${order.masterName})`);
    }

    const kb = masterArrivalPhotoKeyboard(orderId, order);
    if (kb) {
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: kb }).catch(() => {});
      return;
    }

    // Все слоты обработаны — показываем «Выполнено» в том же сообщении
    setState(chatId, "MASTER_WAIT_DONE", { orderId });
    const warnSkip = getMissingPhotoWarning(order);
    const adminChatIdWS = order.adminChatId || SUPER_ADMIN_ID;
    if (warnSkip) {
      safeSend(adminChatIdWS, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnSkip}`);
      if (String(adminChatIdWS) !== String(SUPER_ADMIN_ID)) {
        safeSend(SUPER_ADMIN_ID, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnSkip}`);
      }
    }
    await editMessage(
      chatId, messageId,
      `✅ Заявка #${order.id} — все данные сохранены.` +
      (warnSkip ? `\n\n${warnSkip}` : "") +
      `\n\n<b>По завершению работ нажмите «✅ Выполнено».</b>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] },
      }
    ).catch(() => {});
    return;
  }

  // MASTER: нажал «Выполнено» — завершение заявки и уведомление админу
  if (data.startsWith("MASTER_DONE:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order || String(order.masterTgId) !== String(cb.from.id)) return;

    order.status = "DONE";
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });
    order.completedAt = new Date().toISOString();
    clearState(chatId);
    await editMessage(chatId, messageId, "✅ Выполнено.", { reply_markup: { inline_keyboard: [] } });
    await sendMessage(chatId, "✅ Готово.", { reply_markup: masterMenuReplyKeyboard() });

    const adminChatId = order.adminChatId || SUPER_ADMIN_ID;
    const doneCloseKb = { inline_keyboard: [[{ text: "🔒 Закрыть заявку", callback_data: `ADMIN_CLOSE:${order.id}` }]] };
    const doneDeviceLine = order.type === "INSTALL" ? `\n📦 Установлено: ${optionsLabel(order)}` : "";
    const doneMsg =
      `✅ Заявка #${order.id} выполнена.\n` +
      `👷 Мастер: ${order.masterName}\n` +
      `🚗/🏢: ${logisticsLabel(order)}` +
      doneDeviceLine;
    // 1. Уведомление о завершении (без кнопки закрытия)
    await sendMessage(adminChatId, doneMsg);
    // 2. Только обязательные фото, которые не были предоставлены
    const devPhotos = order.devicePhotos || {};
    const doneSlots = getPhotoSlots(order);
    for (const slot of doneSlots) {
      const fid = devPhotos[slot.key];
      if (!fid && slot.required) {
        await sendMessage(adminChatId, `⚠️ ${slot.label}: обязательное фото не предоставлено`);
      }
    }
    // 3. Кнопка закрытия — В САМОМ КОНЦЕ
    await sendMessage(adminChatId, "Нажмите для официального закрытия заявки:", { reply_markup: doneCloseKb });
    if (String(adminChatId) !== String(SUPER_ADMIN_ID)) {
      await safeSend(SUPER_ADMIN_ID, doneMsg);
      await safeSend(SUPER_ADMIN_ID, "Нажмите для официального закрытия заявки:", { reply_markup: doneCloseKb });
    }
    return;
  }

  // ADMIN: закрытие заявки после выполнения мастером
  if (data.startsWith("ADMIN_CLOSE:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.");
      return;
    }
    // Проверка: закрыть может только назначенный администратор или супер-админ
    const isAllowedToClose =
      String(chatId) === String(SUPER_ADMIN_ID) ||
      String(chatId) === String(ADMIN_CHAT_ID) ||
      String(chatId) === String(order.adminChatId);
    if (!isAllowedToClose) {
      await sendMessage(chatId, "⚠️ У вас нет прав для закрытия этой заявки.");
      return;
    }
    if (order.status === "CLOSED") {
      await editMessage(chatId, messageId, `🔒 Заявка #${order.id} уже закрыта.`, { reply_markup: { inline_keyboard: [] } });
      return;
    }
    order.status = "CLOSED";
    order.closedAt = new Date().toISOString();
    order.closedBy = chatId;
    logEvent({
      actorId: cb.from && cb.from.id,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });
    const closedDeviceLine = order.type === "INSTALL" ? `\n📦 Установлено: ${optionsLabel(order)}` : "";
    await editMessage(
      chatId, messageId,
      `🔒 Заявка #${order.id} закрыта.\n👷 Мастер: ${order.masterName}\n📞 Клиент: ${order.phone}${closedDeviceLine}`,
      { reply_markup: { inline_keyboard: [] } }
    );
    // Уведомить мастера
    if (order.masterTgId) {
      await safeSend(order.masterTgId, `🔒 Заявка #${order.id} официально закрыта администратором.`);
    }
    // Если закрыл обычный админ — уведомить супер-админа
    if (String(chatId) !== String(SUPER_ADMIN_ID)) {
      await safeSend(SUPER_ADMIN_ID, `🔒 Заявка #${order.id} закрыта администратором (${order.masterName}).`);
    }
    return;
  }

  // ADMIN: picked master
  if (data.startsWith("ADMIN_PICK_MASTER:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_MASTER") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const masterTgId = Number(data.split(":")[1]);
    if (!activeMasterIds.has(String(masterTgId))) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Мастер не найден.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    const masterInfo = getMasterInfo(masterTgId);
    const orderId = String(++lastOrderId);
    const order = {
      id: orderId,
      createdAt: new Date().toISOString(),
      phone: st.data.phone,

      masterTgId,
      masterName: masterInfo.name,
      city: masterInfo.city,

      adminChatId: chatId,

      type: st.data.presetType || null, // INSTALL | REPAIR
      logistics: null,                  // VISIT | COME
      address: "",                      // адрес при VISIT

      adminComment: "",

      masterSuggestedTimeText: "",
      adminSuggestedTimeText: "",
      confirmedTimeText: "",
      actualArrivalAt: null,
      acceptedAt: null,              // когда мастер принял заявку
      lastReminderAt: null,          // когда последний раз отправлено напоминание
      reminderCount: 0,              // сколько напоминаний отправлено
      estimatedInstallHours: null,   // оценка мастера: сколько часов займёт установка

      devicePhotos: {},   // { slotKey: fileId|"SKIPPED" }

      options: [],
      deviceQuantities: {},  // { "FMB920": 2, "FMB125+DUT": 1 }
      totalDevices: 0,
      acceptPlannedDayAt: null,

      status: "NEW",
    };
    orders.set(orderId, order);

    logEvent({
      actorId: chatId,
      action: "order_status_change",
      targetId: order.id,
      meta: { status: order.status },
    });

    // Если тип уже задан кнопкой меню — сразу логистика
    if (order.type) {
      setState(chatId, "ADMIN_WAIT_LOGISTICS", { orderId });
      await editMessage(
        chatId,
        messageId,
        `✅ Мастер выбран.\n\nВыберите логистику:`,
        { reply_markup: logisticsKeyboard() }
      );
      return;
    }

    // Иначе — сначала спросим тип
    setState(chatId, "ADMIN_WAIT_TYPE", { orderId });
    await editMessage(
      chatId,
      messageId,
      `✅ Мастер выбран.\n\nВыберите тип заявки:`,
      { reply_markup: orderTypeKeyboard() }
    );
    return;
  }

  // ADMIN: выбрал мастера для чата
  if (data.startsWith("ADMIN_CHAT_MASTER:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_CHAT_PICK_MASTER") {
      await sendMessage(chatId, "⚠️ Сессия чата устарела. Нажмите «💬 Чат с мастером» ещё раз.", {
        reply_markup: menuKeyboardForChat(chatId),
      });
      return;
    }

    const masterTgId = Number(data.split(":")[1]);
    if (!activeMasterIds.has(String(masterTgId))) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Мастер не найден.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    const masterInfo = getMasterInfo(masterTgId);
    setState(chatId, "ADMIN_CHAT_WITH_MASTER", { masterTgId });
    await editMessage(
      chatId,
      messageId,
      `💬 Чат с мастером ${masterInfo.name} (${masterInfo.city}).\nНапишите сообщение. Для выхода нажмите «❌ Отмена».`
    );
    await sendMessage(chatId, "Можете писать сообщение мастеру.", {
      reply_markup: adminMenuReplyKeyboard(chatId),
    });
    return;
  }

  // ADMIN: picked type
  if (data.startsWith("ADMIN_TYPE:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_TYPE") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard(chatId) });
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
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard(chatId) });
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
        { reply_markup: adminCommentKeyboard(orderId) }
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

  // ADMIN: toggle option (мульти-выбор устройств)
  if (data.startsWith("ADMIN_OPT:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_OPTION") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const parts = data.split(":");
    const orderId = parts[1];
    const optIndex = Number(parts[2]);

    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    if (optIndex < 0 || optIndex >= OPTIONS.length) {
      await sendMessage(chatId, "⚠️ Опция не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const selectedOpts = st.data.selectedOpts ? [...st.data.selectedOpts] : [];
    const idx = selectedOpts.indexOf(optIndex);
    if (idx === -1) selectedOpts.push(optIndex);
    else selectedOpts.splice(idx, 1);

    setState(chatId, "ADMIN_WAIT_OPTION", { orderId, selectedOpts });

    const chosen = selectedOpts.map(i => OPTIONS[i]).join(", ") || "ничего не выбрано";
    await editMessage(
      chatId, messageId,
      `🛠 Монтаж\n\nВыберите устройства (можно несколько):\n\nВыбрано: ${chosen}`,
      { reply_markup: optionsKeyboard(orderId, selectedOpts) }
    );
    return;
  }

  // ADMIN: подтверждение выбора устройств
  if (data.startsWith("ADMIN_OPT_CONFIRM:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_OPTION") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена. Начните заново.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const selectedOpts = st.data.selectedOpts || [];
    if (selectedOpts.length === 0) {
      await sendMessage(chatId, "⚠️ Выберите хотя бы одно устройство из списка.");
      return;
    }

    order.options = selectedOpts.map(i => OPTIONS[i]);

    // Запрашиваем количество для первого устройства
    setState(chatId, "ADMIN_WAIT_QTY", { orderId, qtyIdx: 0, quantities: {} });
    await editMessage(
      chatId, messageId,
      `✅ Выбрано: ${order.options.join(", ")}\n\n🔢 Сколько ${order.options[0]}?`,
      { reply_markup: qtyKeyboard(orderId) }
    );
    return;
  }

  // ADMIN: нажал «✏️ Больше...» — ждём ввод числа текстом
  if (data.startsWith("ADMIN_QTY_CUSTOM:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_QTY") {
      await sendMessage(chatId, "⚠️ Сессия устарела.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    const deviceName = order.options[st.data.qtyIdx];
    setState(chatId, "ADMIN_WAIT_QTY_CUSTOM", { orderId, qtyIdx: st.data.qtyIdx, quantities: st.data.quantities || {} });
    await editMessage(chatId, messageId, `✏️ Введите количество для ${deviceName} (число от 1 до 999):`);
    return;
  }

  // ADMIN: ввод количества для устройства
  if (data.startsWith("ADMIN_QTY:")) {
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_QTY") {
      await sendMessage(chatId, "⚠️ Сессия устарела. Выберите действие:", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const parts = data.split(":");
    const orderId = parts[1];
    const qty = Number(parts[2]);
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }

    const { qtyIdx, quantities } = st.data;
    const deviceName = order.options[qtyIdx];
    quantities[deviceName] = qty;

    const nextIdx = qtyIdx + 1;
    if (nextIdx < order.options.length) {
      setState(chatId, "ADMIN_WAIT_QTY", { orderId, qtyIdx: nextIdx, quantities });
      await editMessage(
        chatId, messageId,
        `✅ ${deviceName}: ${qty} шт.\n\n🔢 Сколько ${order.options[nextIdx]}?`,
        { reply_markup: qtyKeyboard(orderId) }
      );
      return;
    }

    // Все количества заполнены
    order.deviceQuantities = { ...quantities };
    order.totalDevices = Object.values(quantities).reduce((a, b) => a + b, 0);

    const qtyText = order.options.map(o => `${o} × ${quantities[o]}`).join(", ");

    // Итого: устройства и аксессуары отдельно
    const devTotal = order.options
      .filter(o => OPTIONS_DEVICES.includes(o))
      .reduce((s, o) => s + (quantities[o] || 0), 0);
    const accTotal = order.options
      .filter(o => OPTIONS_ACCESSORIES.includes(o))
      .reduce((s, o) => s + (quantities[o] || 0), 0);
    const summaryParts = [];
    if (devTotal) summaryParts.push(`${devTotal} устр.`);
    if (accTotal) summaryParts.push(`${accTotal} акс.`);
    const summaryLine = summaryParts.length ? `📊 Итого: ${summaryParts.join(", ")}\n\n` : "";

    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });

    const hint =
      "✍️ Напишите комментарий.\n" +
      "Например: «поставить реле, SIM клиента, серийники позже»";

    await editMessage(chatId, messageId, `✅ Устройства: ${qtyText}\n\n${summaryLine}${hint}`, {
      reply_markup: adminCommentKeyboard(orderId),
    });
    return;
  }

  // ADMIN: нажал «✅ Отправить» в шаге комментария (пустой или уже введённый комментарий)
  if (data.startsWith("ADMIN_SUBMIT_COMMENT:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) {
      await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    // Защита от повторной отправки (если уже отправлено через текстовый ввод)
    if (order.status === "SENT_TO_MASTER") {
      await editMessage(chatId, messageId, "✅ Заявка уже отправлена мастеру.");
      return;
    }
    if (!order.adminComment) order.adminComment = "";
    order.status = "SENT_TO_MASTER";
    clearState(chatId);
    await sendOrderToMaster(order);
    await editMessage(chatId, messageId, formatAdminConfirm(order));
    await sendMessage(chatId, "✅ Заявка отправлена мастеру.", { reply_markup: adminMenuReplyKeyboard(chatId) });
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

const STATUS_LABELS = {
  NEW:                   "Новая",
  SENT_TO_MASTER:        "Отправлена мастеру",
  ACCEPTED_BY_MASTER:    "Принята мастером",
  DECLINED_BY_MASTER:    "Отклонена мастером",
  WAIT_ADMIN_CONFIRM_TIME:  "Ожидает подтв. времени (admin)",
  WAIT_MASTER_CONFIRM_TIME: "Ожидает подтв. времени (мастер)",
  TIME_CONFIRMED:           "Время подтверждено",
  CLIENT_ARRIVED:        "Клиент прибыл",
  DONE:                  "Выполнена",
  CLOSED:                "Закрыта",
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status || "—";
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

  if (code === "TODAY") {
    const from = startOfDay(now);
    const to = endOfDay(now);
    return { from, to };
  }

  if (code === "YESTERDAY") {
    const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const from = startOfDay(yest);
    const to = endOfDay(yest);
    return { from, to };
  }

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

// Ожидающие заявки (не завершённые и не закрытые)
function getPendingReportItems(opts = {}) {
  const scope = opts.scope || "ADMIN";
  const masterTgId = opts.masterTgId || null;
  const all = Array.from(orders.values());
  return all.filter((o) => {
    if (o.status === "DONE" || o.status === "CLOSED" || o.status === "DECLINED_BY_MASTER") return false;
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
  // Учитываем, что в одной заявке может быть несколько опций и количество устройств по каждой опции.
  const byOption = {}; // { [optionName]: { orders: number, devices: number } }
  for (const o of installs) {
    const optsList = Array.isArray(o.options) && o.options.length ? o.options : [o.option].filter(Boolean);
    for (const optName of optsList.length ? optsList : ["—"]) {
      const key = optName || "—";
      const qty =
        (o.deviceQuantities && typeof o.deviceQuantities === "object" && Number(o.deviceQuantities[key])) ||
        (o.devices && typeof o.devices === "object" && Number(o.devices[key])) ||
        1;
      if (!byOption[key]) byOption[key] = { orders: 0, devices: 0 };
      byOption[key].orders += 1;
      byOption[key].devices += Math.max(1, qty);
    }
  }
  const optionLines = Object.entries(byOption)
    .map(([opt, v]) => `• ${opt}: заявок ${v.orders}, устройств ${v.devices}`)
    .join("\n");

  let header = `📊 Отчёт за период ${formatDate(from)}–${formatDate(to)}`;
  if (scope === "MASTER" && masterTgId != null) {
    header += `\n👷 Мастер: ${getMasterInfo(masterTgId).name}`;
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

// Текстовый отчёт по ожидающим заявкам
async function sendPendingReport(chatId, opts = {}) {
  const scope = opts.scope || "ADMIN";
  const masterTgId = opts.masterTgId || null;
  const items = getPendingReportItems(opts);

  if (!items.length) {
    await sendMessage(
      chatId,
      scope === "MASTER" ? "📋 Ожидающих заявок у вас нет." : "📋 Ожидающих заявок нет.",
      { reply_markup: menuKeyboardForChat(chatId) }
    );
    return;
  }

  const byStatus = {};
  for (const o of items) {
    const s = statusLabel(o.status);
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const statusLines = Object.entries(byStatus)
    .map(([s, cnt]) => `• ${s}: ${cnt}`)
    .join("\n");

  let header = "📋 Ожидающие заявки";
  if (scope === "MASTER" && masterTgId != null) {
    header += `\n👷 Мастер: ${getMasterInfo(masterTgId).name}`;
  }
  const text = `${header}\n\nВсего: ${items.length}\n\nПо статусам:\n${statusLines}`;

  setState(chatId, "REPORT_SENT", { pending: true, scope, masterTgId });
  await sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: "📥 Отправить в Excel", callback_data: "REPORT_EXCEL" }]] },
  });
}

// Колонки устройств для сводки по мастерам
const DEVICE_COLS = [...OPTIONS_DEVICES, ...OPTIONS_ACCESSORIES];

// Строит лист "Сводка по мастерам" с отдельной колонкой на каждый тип устройства
function buildMasterSummaryRows(items) {
  const byMaster = {};
  for (const o of items) {
    const name = o.masterName || "—";
    if (!byMaster[name]) {
      byMaster[name] = { total: 0, installs: 0, repairs: 0, visits: 0 };
      for (const d of DEVICE_COLS) byMaster[name][d] = 0;
    }
    byMaster[name].total += 1;
    if (o.type === "INSTALL") {
      byMaster[name].installs += 1;
      const oOpts = o.options?.length ? o.options : [];
      for (const opt of oOpts) {
        const qty = o.deviceQuantities?.[opt] || 1;
        if (byMaster[name][opt] !== undefined) byMaster[name][opt] += qty;
      }
    } else if (o.type === "REPAIR") byMaster[name].repairs += 1;
    if (o.logistics === "VISIT") byMaster[name].visits += 1;
  }
  let rows = [["Мастер", "Всего заявок", "Монтаж", "Ремонт/другое", "Выездов", ...DEVICE_COLS]];
  Object.entries(byMaster).forEach(([name, s]) =>
    rows.push([name, s.total, s.installs, s.repairs, s.visits, ...DEVICE_COLS.map(d => s[d])])
  );
  return addTotalsRow(rows);
}

// Хелпер: добавить строку ИТОГО в конец массива строк
function addTotalsRow(rows, label = "ИТОГО") {
  if (rows.length <= 1) return rows;
  const header = rows[0];
  const totals = header.map((_, ci) => {
    if (ci === 0) return label;
    const nums = rows.slice(1).map(r => (typeof r[ci] === "number" ? r[ci] : 0));
    const sum = nums.reduce((a, b) => a + b, 0);
    return nums.some(n => n !== 0) ? sum : "";
  });
  return [...rows, totals];
}

// Сборка Excel-файла отчёта, возвращает путь к временному файлу
function buildExcelReport(from, to, opts = {}) {
  const items = getReportItems(from, to, opts);

  const rows = [
    [
      "№",
      "Дата создания",
      "Время создания",
      "Дата выполнения (мастер)",
      "Время выполнения (мастер)",
      "Дата закрытия (админ)",
      "Время закрытия (админ)",
      "Тип",
      "Устройства",
      "Кол-во уст.",
      "Город",
      "Мастер",
      "Логистика",
      "План работ (дата)",
      "Адрес выезда",
      "Телефон",
      "Комментарий",
      "Статус",
    ],
  ];
  // Add explicit period row at the top (useful when exporting / forwarding)
  {
    const headerLen = rows[0].length;
    const periodText = `Период отчёта: ${formatDate(fromDate)}–${formatDate(toDate)} (${REPORT_TIMEZONE})`;
    rows.unshift([periodText, ...Array(Math.max(0, headerLen - 1)).fill(" ")]);
  }


  items.forEach((o, i) => {
    const dStart   = o.createdAt   ? new Date(o.createdAt)   : null;
    const dDone    = o.completedAt ? new Date(o.completedAt) : null;
    const dClosed  = o.closedAt    ? new Date(o.closedAt)    : null;
    rows.push([
      i + 1,
      dStart  ? formatDateInTz(dStart)  : "",
      dStart  ? formatTimeInTz(dStart)  : "",
      dDone   ? formatDateInTz(dDone)   : "",
      dDone   ? formatTimeInTz(dDone)   : "",
      dClosed ? formatDateInTz(dClosed) : "",
      dClosed ? formatTimeInTz(dClosed) : "",
      o.type === "INSTALL" ? "Монтаж" : "Ремонт/другое",
      o.type === "INSTALL" ? optionsLabel(o) : "—",
      o.type === "INSTALL" ? (o.totalDevices || 1) : 0,
      o.city || "—",
      o.masterName || "—",
      o.logistics === "VISIT" ? "Выезд" : o.logistics === "COME" ? "Клиент приедет" : "—",
      o.acceptPlannedDayAt ? formatDateInTz(new Date(o.acceptPlannedDayAt)) : "",
      o.address || "—",
      o.phone || "—",
      (o.adminComment || "").replace(/\n/g, " "),
      statusLabel(o.status),
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Заявки");

  // Сводка по видам монтажа — с фактическим количеством устройств
  const installs = items.filter((o) => o.type === "INSTALL");
  const byOption = {};
  for (const o of installs) {
    const opts2 = o.options?.length ? o.options : ["—"];
    for (const opt of opts2) {
      const qty = o.deviceQuantities?.[opt] || 1;
      if (!byOption[opt]) byOption[opt] = { orders: 0, devices: 0 };
      byOption[opt].orders += 1;
      byOption[opt].devices += qty;
    }
  }
  let optionRows = [["Вид монтажа", "Заявок", "Устройств"]];
  Object.entries(byOption).forEach(([opt, s]) => optionRows.push([opt, s.orders, s.devices]));
  optionRows = addTotalsRow(optionRows);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(optionRows), "Сводка по видам");

  const masterRows = buildMasterSummaryRows(items);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(masterRows), "Сводка по мастерам");

  const tmpDir = os.tmpdir();
  const fromStr = formatDate(from);
  const toStr = formatDate(to);
  const filename = fromStr === toStr
    ? `Установки_${fromStr}.xlsx`
    : `Установки_${fromStr}-${toStr}.xlsx`;
  const filePath = path.join(tmpDir, filename);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

// Excel по ожидающим заявкам (та же структура листов)
function buildExcelReportPending(opts = {}) {
  const items = getPendingReportItems(opts);

  const rows = [
    [
      "№",
      "Дата создания",
      "Время создания",
      "Дата выполнения (мастер)",
      "Время выполнения (мастер)",
      "Дата закрытия (админ)",
      "Время закрытия (админ)",
      "Тип",
      "Устройства",
      "Кол-во уст.",
      "Город",
      "Мастер",
      "Логистика",
      "План работ (дата)",
      "Адрес выезда",
      "Телефон",
      "Комментарий",
      "Статус",
    ],
  ];
  {
    const headerLen = rows[0].length;
    const nowText = new Intl.DateTimeFormat("ru-RU", { timeZone: REPORT_TIMEZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date());
    const title = `Ожидающие заявки — выгрузка: ${nowText} (${REPORT_TIMEZONE})`;
    rows.unshift([title, ...Array(Math.max(0, headerLen - 1)).fill(" ")]);
  }


  items.forEach((o, i) => {
    const dStart  = o.createdAt   ? new Date(o.createdAt)   : null;
    const dDone   = o.completedAt ? new Date(o.completedAt) : null;
    const dClosed = o.closedAt    ? new Date(o.closedAt)    : null;
    rows.push([
      i + 1,
      dStart  ? formatDateInTz(dStart)  : "",
      dStart  ? formatTimeInTz(dStart)  : "",
      dDone   ? formatDateInTz(dDone)   : "",
      dDone   ? formatTimeInTz(dDone)   : "",
      dClosed ? formatDateInTz(dClosed) : "",
      dClosed ? formatTimeInTz(dClosed) : "",
      o.type === "INSTALL" ? "Монтаж" : "Ремонт/другое",
      o.type === "INSTALL" ? optionsLabel(o) : "—",
      o.type === "INSTALL" ? (o.totalDevices || 1) : 0,
      o.city || "—",
      o.masterName || "—",
      o.logistics === "VISIT" ? "Выезд" : o.logistics === "COME" ? "Клиент приедет" : "—",
      o.acceptPlannedDayAt ? formatDateInTz(new Date(o.acceptPlannedDayAt)) : "",
      o.address || "—",
      o.phone || "—",
      (o.adminComment || "").replace(/\n/g, " "),
      statusLabel(o.status),
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Заявки");

  const installs = items.filter((o) => o.type === "INSTALL");
  const byOption = {};
  for (const o of installs) {
    const opts2 = o.options?.length ? o.options : ["—"];
    for (const opt of opts2) {
      const qty = o.deviceQuantities?.[opt] || 1;
      if (!byOption[opt]) byOption[opt] = { orders: 0, devices: 0 };
      byOption[opt].orders += 1;
      byOption[opt].devices += qty;
    }
  }
  let optionRows = [["Вид монтажа", "Заявок", "Устройств"]];
  Object.entries(byOption).forEach(([opt, s]) => optionRows.push([opt, s.orders, s.devices]));
  optionRows = addTotalsRow(optionRows);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(optionRows), "Сводка по видам");

  const masterRowsPending = buildMasterSummaryRows(items);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(masterRowsPending), "Сводка по мастерам");

  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `Ожидающие_заявки_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

async function sendAuditExcel(chatId) {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("AuditLog", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "ts", key: "ts", width: 24 },
      { header: "actorId", key: "actorId", width: 14 },
      { header: "actorUsername", key: "actorUsername", width: 18 },
      { header: "actorName", key: "actorName", width: 22 },
      { header: "action", key: "action", width: 24 },
      { header: "targetId", key: "targetId", width: 14 },
      { header: "meta", key: "meta", width: 50 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const e of auditLog) {
      ws.addRow({
        ts: e.ts || "",
        actorId: e.actorId ?? "",
        action: e.action || "",
        targetId: e.targetId ?? "",
        meta: e.meta ? JSON.stringify(e.meta).slice(0, 500) : "",
      });
    }
    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `audit_log_${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(filePath);
    await sendDocument(chatId, filePath, "📒 Журнал (Excel)");
    fs.unlink(filePath, () => {});
    logEvent("excel_export_audit", { actorId: chatId, meta: { count: auditLog.length } });
  } catch (e) {
    console.error("sendAuditExcel error:", e?.message || e);
  }
}

async function sendContactsExcel(chatId) {
  try {
    const rows = [["chatId", "role", "name", "city", "username"]];
    const seen = new Set();

    function pushContact(id, role, name, city, username) {
      const key = String(id);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push([key, role || "", name || "", city || "", username || ""]);
    }

    // SUPER_ADMIN
    const superProf = userProfiles[String(SUPER_ADMIN_ID)] || {};
    pushContact(
      SUPER_ADMIN_ID,
      "SUPER_ADMIN",
      superProf.name || "SUPER_ADMIN",
      superProf.city || null,
      superProf.username || null
    );

    // ADMIN
    const adminProf = userProfiles[String(ADMIN_CHAT_ID)] || {};
    pushContact(
      ADMIN_CHAT_ID,
      adminProf.role || "ADMIN",
      adminProf.name || "ADMIN",
      adminProf.city || null,
      adminProf.username || null
    );

    // userProfiles
    for (const [cid, prof] of Object.entries(userProfiles)) {
      pushContact(
        cid,
        prof.role || (authorizedRoles.get(String(cid)) || ""),
        prof.name || cid,
        prof.city || null,
        prof.username || null
      );
    }

    // Static MASTERS not yet in profiles
    for (const m of MASTERS) {
      const cid = String(m.tgId);
      if (seen.has(cid)) continue;
      pushContact(cid, "MASTER", m.name, m.city, null);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Contacts", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "chatId", key: "chatId", width: 14 },
      { header: "role", key: "role", width: 14 },
      { header: "name", key: "name", width: 24 },
      { header: "city", key: "city", width: 18 },
      { header: "username", key: "username", width: 18 },
    ];
    ws.getRow(1).font = { bold: true };
    for (let i = 1; i < rows.length; i++) {
      ws.addRow(rows[i]);
    }
    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `contacts_${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(filePath);
    await sendDocument(chatId, filePath, "📇 Контакты (Excel)");
    fs.unlink(filePath, () => {});
    logEvent("excel_export_contacts", { actorId: chatId, meta: { count: rows.length - 1 } });
  } catch (e) {
    console.error("sendContactsExcel error:", e?.message || e);
  }
}

function optionsLabel(order) {
  if (order.type !== "INSTALL") return "";
  const opts = order.options?.length ? order.options : [];
  if (!opts.length) return "-";
  if (order.deviceQuantities && Object.keys(order.deviceQuantities).length) {
    return opts.map(o => `${o} ×${order.deviceQuantities[o] || 1}`).join(", ");
  }
  return opts.join(", ");
}

function formatOrderForMaster(order) {
  const addrLine = order.logistics === "VISIT" ? `📍 Адрес: ${order.address || "-"}` : "";
  const commentLine = `💬 Комментарий:\n${order.adminComment || "-"}`;

  let installLines = "";
  if (order.type === "INSTALL") {
    installLines += `📦 Устройства: ${optionsLabel(order)}\n`;
    // Итого только по устройствам (аксессуары не считаем)
    const deviceSlots = getPhotoSlots(order).filter(s => s.photoType === "device");
    if (deviceSlots.length) {
      const byDev = {};
      for (const s of deviceSlots) byDev[s.deviceName] = (byDev[s.deviceName] || 0) + 1;
      const summary = Object.entries(byDev).map(([n, c]) => `${n}×${c}`).join(", ");
      installLines += `📊 Итого устройств: ${summary} (${deviceSlots.length} шт.)\n`;
    }
  }

  return (
    `${typeLabel(order)} #${order.id}\n` +
    `📞 Телефон: ${order.phone}\n` +
    `🚗/🏢: ${logisticsLabel(order)}\n` +
    (addrLine ? `${addrLine}\n` : "") +
    installLines +
    `\n${commentLine}`
  );
}

function formatAdminConfirm(order) {
  const optLine = order.type === "INSTALL" ? `📦 Устройства: ${optionsLabel(order)}` : "";
  const addrLine = order.logistics === "VISIT" ? `📍 Адрес: ${order.address || "-"}` : "";

  let totalsLine = "";
  if (order.type === "INSTALL") {
    const deviceSlots = getPhotoSlots(order).filter(s => s.photoType === "device");
    if (deviceSlots.length) {
      const byDev = {};
      for (const s of deviceSlots) byDev[s.deviceName] = (byDev[s.deviceName] || 0) + 1;
      const summary = Object.entries(byDev).map(([n, c]) => `${n}×${c}`).join(", ");
      totalsLine = `📊 Итого устройств: ${summary} (${deviceSlots.length} шт.)`;
    }
  }

  return (
    `✅ Заявка #${order.id} отправлена мастеру.\n` +
    `📞 Телефон: ${order.phone}\n` +
    `📍 Город: ${order.city}\n` +
    `👷 Мастер: ${order.masterName}\n` +
    `🧾 Тип: ${order.type === "REPAIR" ? "Ремонт / другое" : "Монтаж"}\n` +
    `🚗/🏢: ${logisticsLabel(order)}\n` +
    (addrLine ? `${addrLine}\n` : "") +
    (optLine ? `${optLine}\n` : "") +
    (totalsLine ? `${totalsLine}\n` : "") +
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
// Order reminders
// =============================

const REMINDER_ACTIVE_STATUSES = new Set([
  "ACCEPTED_BY_MASTER",
  "WAIT_ADMIN_CONFIRM_TIME",
  "WAIT_MASTER_CONFIRM_TIME",
  "TIME_CONFIRMED",
  "CLIENT_ARRIVED",
]);

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const THIRTY_MIN_MS  = 30 * 60 * 1000;

async function checkOrderReminders() {
  const now = Date.now();
  for (const [, order] of orders) {
    if (!REMINDER_ACTIVE_STATUSES.has(order.status)) continue;
    if (!order.acceptedAt) continue;

    const acceptedTs = new Date(order.acceptedAt).getTime();
    const elapsed = now - acceptedTs;

    // Если мастер указал оценку — первое напоминание через estimatedInstallHours+30мин, но не раньше 3ч
    const estMs = order.estimatedInstallHours
      ? Math.max(order.estimatedInstallHours * 60 * 60 * 1000 + THIRTY_MIN_MS, THREE_HOURS_MS)
      : THREE_HOURS_MS;
    if (elapsed < estMs) continue;

    const lastRemTs = order.lastReminderAt ? new Date(order.lastReminderAt).getTime() : 0;
    const sinceLastRem = now - lastRemTs;

    // Первое напоминание — после estMs; следующие — каждые 30 мин
    if (lastRemTs !== 0 && sinceLastRem < THIRTY_MIN_MS) continue;

    order.lastReminderAt = new Date().toISOString();
    order.reminderCount = (order.reminderCount || 0) + 1;

    const hoursElapsed = Math.floor(elapsed / (60 * 60 * 1000));
    const minElapsed   = Math.floor((elapsed % (60 * 60 * 1000)) / 60000);
    const timeStr      = hoursElapsed > 0 ? `${hoursElapsed}ч ${minElapsed}мин` : `${minElapsed}мин`;
    const reminder     = order.reminderCount;
    const estNote      = order.estimatedInstallHours
      ? `\n📌 Оценка мастера была: ~${order.estimatedInstallHours} ч.`
      : "";

    // Уведомление мастеру
    safeSend(
      order.masterTgId,
      `⏰ Напоминание #${reminder}: заявка #${order.id} ещё активна!\n` +
      `📊 Статус: ${statusLabel(order.status)}\n` +
      `📞 Клиент: ${order.phone}\n` +
      `⏱ Прошло: ${timeStr} с момента принятия${estNote}\n\n` +
      `Завершите работы или свяжитесь с администратором.`
    );

    // Уведомление администратору
    const adminId = order.adminChatId || SUPER_ADMIN_ID;
    safeSend(
      adminId,
      `⏰ Напоминание #${reminder}: заявка #${order.id} не закрыта!\n` +
      `👷 Мастер: ${order.masterName}\n` +
      `📊 Статус: ${statusLabel(order.status)}\n` +
      `📞 Клиент: ${order.phone}\n` +
      `⏱ Прошло: ${timeStr} с момента принятия${estNote}`
    );
    if (String(adminId) !== String(SUPER_ADMIN_ID)) {
      safeSend(
        SUPER_ADMIN_ID,
        `⏰ Напоминание #${reminder}: заявка #${order.id} не закрыта!\n` +
        `👷 Мастер: ${order.masterName}\n` +
        `📊 Статус: ${statusLabel(order.status)}\n` +
        `📞 Клиент: ${order.phone}\n` +
        `⏱ Прошло: ${timeStr} с момента принятия${estNote}`
      );
    }

    logEvent({
      actorId: null,
      action: "order_reminder",
      targetId: order.id,
      meta: { reminder, status: order.status },
    });
  }
}

// Проверяем раз в 5 минут
setInterval(checkOrderReminders, 5 * 60 * 1000);

// =============================
// Start server
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server started on port ${PORT}`);
  // Кнопка «Меню» в левом нижнем углу
  try {
    await tg("setMyCommands", {
      commands: [{ command: "start", description: "Меню" }],
    });
    await tg("setChatMenuButton", { menu_button: { type: "commands" } });
  } catch (e) {
    console.warn("setMyCommands/setChatMenuButton:", e?.message || e);
  }
});

saveData();
