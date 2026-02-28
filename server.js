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
// Telegram UI helpers
// =============================
async function setChatMenuButtonForChat(chatId, type) {
  try {
    if (!chatId) return;
    await tg("setChatMenuButton", {
      chat_id: chatId,
      menu_button: { type },
    });
  } catch (e) {
    console.warn("setChatMenuButtonForChat:", e?.message || e);
  }
}

// =============================
// ENV (Пароли удалены для безопасности)
// =============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN not found in environment variables");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const authorizedChatIds = new Set(); // chatId строкой
const authorizedRoles = new Map();   // chatId -> "MASTER"|"ADMIN"
let userProfiles = {};               // chatId -> { name, city, role, username }
const seenMasters = new Set();       // мастера, уже подключавшиеся
const pendingApprovalInfo = new Map(); // applicantChatId -> { username }

// Роли: супер-админ и админ
const SUPER_ADMIN_ID = 7862998301;
const ADMIN_CHAT_ID = 1987607156;

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

const MASTERS = [
  { tgId: 8095234574, name: "Иброхимчон", city: "Худжанд" },
  { tgId: 1039628701, name: "Акаи Шухрат", city: "Бохтар" },
  { tgId: 8026685490, name: "Тест", city: "Ашт" },
  { tgId: 1099184597, name: "Абдухалим", city: "Душанбе" },
];
const authorizedMasterCity = new Map();
const pendingMasterCity = new Map();
const activeMasterIds = new Set();
const inactiveMasterIds = new Set();
const dynamicMasters = new Map();
MASTERS.forEach((m) => activeMasterIds.add(String(m.tgId)));

// In-memory storage (Обязательно объявляем до loadData)
let lastOrderId = 0;
const orders = new Map();
const userState = new Map();
const dedupe = new Map();

// =============================
// БАГ №2: ИСПРАВЛЕНА ПОТЕРЯ ЗАЯВОК (Save/Load Data)
// =============================
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
    // ВОССТАНОВЛЕНИЕ ЗАЯВОК:
    if (j.lastOrderId !== undefined) lastOrderId = j.lastOrderId;
    if (j.orders && Array.isArray(j.orders)) {
      orders.clear();
      j.orders.forEach(([id, orderData]) => orders.set(String(id), orderData));
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
      activeMasterIds: [...activeMasterIds],
      inactiveMasterIds: [...inactiveMasterIds],
      authorizedMasterCity: Object.fromEntries(authorizedMasterCity),
      dynamicMasters: Object.fromEntries(dynamicMasters),
      // СОХРАНЕНИЕ ЗАЯВОК:
      lastOrderId: lastOrderId,
      orders: [...orders.entries()],
    };
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(j, null, 2), "utf8");
  } catch (e) {
    console.error("saveData error:", e?.message || e, e);
  }
}

// -----------------------------
// TIME (Asia/Dushanbe) helpers
// -----------------------------
function nowTjIso() {
  const tz = "Asia/Dushanbe";
  const d = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}+05:00`;
}

loadData();

const OPTIONS_DEVICES     = ["FMB920", "FMB125", "FMB140", "DUT"];
const OPTIONS_ACCESSORIES = ["Реле", "Temp."];
const OPTIONS_OTHER       = ["Video", "Другое"];
const OPTIONS = [...OPTIONS_DEVICES, ...OPTIONS_ACCESSORIES, ...OPTIONS_OTHER];
const ACCESSORIES = new Set(OPTIONS_ACCESSORIES);

function getPhotoSlots(order) {
  const opts = order.options?.length ? order.options : [];
  if (!opts.length) return [];
  const hasFMB125 = opts.includes("FMB125");
  const hasDutOpt = opts.includes("DUT");
  const dutPaired = hasFMB125 && hasDutOpt;
  const deviceCounts = {};
  const slots = [];

  const addUnitSlots = (name, unitIdx, hasDut) => {
    const n = unitIdx + 1;
    slots.push({ key: `${name}_${unitIdx}_device`, label: `${name}-${n}`, deviceName: name, photoType: "device", unitIdx, required: true });
    if (name === "DUT") return;
    if (hasDut) slots.push({ key: `${name}_${unitIdx}_dut`, label: `DUT-${n}|${name}-${n}`, deviceName: name, photoType: "dut", unitIdx, required: true });
    slots.push({ key: `${name}_${unitIdx}_odometer`, label: `Пробег ${name}-${n}`, deviceName: name, photoType: "odometer", unitIdx, required: false });
    slots.push({ key: `${name}_${unitIdx}_plate`, label: `Номер ${name}-${n}`, deviceName: name, photoType: "plate", unitIdx, required: false });
  };

  for (const opt of opts) {
    if (ACCESSORIES.has(opt)) continue;
    if (opt === "DUT" && dutPaired) continue;
    const qty = order.deviceQuantities?.[opt] || 1;
    const dutQty = dutPaired && opt === "FMB125" ? (order.deviceQuantities?.["DUT"] || 1) : 0;
    for (let i = 0; i < qty; i++) {
      const unitIdx = deviceCounts[opt] || 0;
      deviceCounts[opt] = unitIdx + 1;
      addUnitSlots(opt, unitIdx, dutPaired && opt === "FMB125" && i < dutQty);
    }
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

function cleanupDedupe() {
  const ttl = 60 * 1000;
  const t = Date.now();
  for (const [k, v] of dedupe.entries()) {
    if (t - v > ttl) dedupe.delete(k);
  }
}

// =============================
// БАГ №6: ИСПРАВЛЕНО УДАЛЕНИЕ ИСТОРИИ (Храним год + корректный timestamp)
// =============================
function cleanupOldOrders() {
  const maxAge = 365 * 24 * 60 * 60 * 1000; // 365 дней вместо 7
  const t = Date.now();

  const parseTsToMs = (ts) => {
    if (ts == null) return null;
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
    if (typeof ts !== "string") return null;
    const s = ts.trim();
    if (!s) return null;

    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return parsed;

    const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      const yyyy = Number(m[3]);
      const HH = m[4] ? Number(m[4]) : 0;
      const MI = m[5] ? Number(m[5]) : 0;
      const SS = m[6] ? Number(m[6]) : 0;
      const d = new Date(yyyy, mm - 1, dd, HH, MI, SS, 0);
      const ms = d.getTime();
      return Number.isNaN(ms) ? null : ms;
    }
    return null;
  };

  for (const [id, order] of orders.entries()) {
    const terminal = ["CLOSED", "DECLINED_BY_MASTER"].includes(order.status);
    const ts = order.closedAt || order.completedAt || order.createdAt;
    const tsMs = parseTsToMs(ts);
    if (terminal && tsMs != null && (t - tsMs > maxAge)) {
      orders.delete(id);
    }
  }
}
setInterval(cleanupOldOrders, 60 * 60 * 1000);

function setState(chatId, step, data = {}) { userState.set(String(chatId), { step, data }); }
function getState(chatId) { return userState.get(String(chatId)) || null; }
function clearState(chatId) { userState.delete(String(chatId)); }

// =============================
// Telegram helpers
// =============================
async function tg(method, payload) { return axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 20000 }); }
async function sendMessage(chatId, text, extra = {}) { return tg("sendMessage", { chat_id: chatId, text, ...extra }); }
async function editMessage(chatId, messageId, text, extra = {}) { return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra }); }
async function answerCb(callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) { payload.text = text; payload.show_alert = showAlert; }
  return tg("answerCallbackQuery", payload).catch(() => {});
}
async function sendPhoto(chatId, fileId, caption) { return tg("sendPhoto", { chat_id: chatId, photo: fileId, caption }); }
async function safeSend(chatId, text, extra = {}) { return sendMessage(chatId, text, extra).catch((e) => console.warn(`safeSend to ${chatId} failed: ${e?.message || e}`)); }

async function forwardChatMessage(message, toChatId, fromLabel) {
  const cap = (extra) => extra ? `${fromLabel}:\n${extra}` : fromLabel;
  if (message.text) { await safeSend(toChatId, `${fromLabel}:\n${message.text}`); }
  else if (message.photo?.length) { await tg("sendPhoto", { chat_id: toChatId, photo: message.photo[message.photo.length - 1].file_id, caption: cap(message.caption) }).catch(() => {}); }
  else if (message.document) { await tg("sendDocument", { chat_id: toChatId, document: message.document.file_id, caption: cap(message.caption) }).catch(() => {}); }
  else if (message.video) { await tg("sendVideo", { chat_id: toChatId, video: message.video.file_id, caption: cap(message.caption) }).catch(() => {}); }
  else if (message.voice) { await tg("sendVoice", { chat_id: toChatId, voice: message.voice.file_id, caption: cap(message.caption) }).catch(() => {}); }
  else if (message.audio) { await tg("sendAudio", { chat_id: toChatId, audio: message.audio.file_id, caption: cap(message.caption) }).catch(() => {}); }
  else if (message.video_note) { await safeSend(toChatId, fromLabel); await tg("sendVideoNote", { chat_id: toChatId, video_note: message.video_note.file_id }).catch(() => {}); }
  else if (message.sticker) { await safeSend(toChatId, `${fromLabel}: [стикер]`); await tg("sendSticker", { chat_id: toChatId, sticker: message.sticker.file_id }).catch(() => {}); }
  else if (message.contact) { await safeSend(toChatId, `${fromLabel}: 📱 Контакт`); await tg("sendContact", { chat_id: toChatId, phone_number: message.contact.phone_number, first_name: message.contact.first_name || "", last_name: message.contact.last_name || "" }).catch(() => {}); }
  else if (message.location) { await safeSend(toChatId, `${fromLabel}: 📍 Геолокация`); await tg("sendLocation", { chat_id: toChatId, latitude: message.location.latitude, longitude: message.location.longitude }).catch(() => {}); }
}

async function sendDocument(chatId, filePath, caption) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", fs.createReadStream(filePath));
  if (caption) form.append("caption", caption);
  return axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders(), timeout: 30000, maxContentLength: Infinity, maxBodyLength: Infinity });
}

// =============================
// UI builders
// =============================
function adminMenuReplyKeyboard(chatId) {
  const rows = [
    [{ text: "📋 Новая заявка" }, { text: "🔧 Ремонт / другое" }],
    [{ text: "📊 Отчёт" }, { text: "💬 Чат с мастером" }],
    [{ text: "👷 Мастера" }],
    [{ text: "❌ Отмена" }],
  ];
  if (ADMIN_CHAT_ID && SUPER_ADMIN_ID) {
    const cid = String(chatId);
    if (cid === String(ADMIN_CHAT_ID) || cid === String(SUPER_ADMIN_ID)) {
      const label = cid === String(SUPER_ADMIN_ID) ? "🧑‍💼💬 Чат с админом" : "🧑‍💼💬 Чат с супер-админом";
      rows.splice(3, 0, [{ text: label }]);
    }
  }
  if (chatId != null && String(chatId) === String(SUPER_ADMIN_ID)) {
    rows.push([{ text: "➕ Добавить юзера (ID)" }, { text: "🔁 Роли" }]);
    rows.push([{ text: "📇 Контакты (Excel)" }]);
  }
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false, selective: false };
}

function masterMenuReplyKeyboard() {
  return {
    keyboard: [[{ text: "📊 Мой отчёт" }, { text: "💬 Написать админу" }], [{ text: "❌ Отмена" }]],
    resize_keyboard: true, one_time_keyboard: false, selective: false,
  };
}

function isMasterChat(chatId) { return activeMasterIds.has(String(chatId)); }

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

// =============================
// БАГ №10: ИСПРАВЛЕНА УТЕЧКА МЕНЮ ДЛЯ НЕАКТИВНЫХ МАСТЕРОВ
// =============================
function menuKeyboardForChat(chatId) {
  const cid = String(chatId);
  if (activeMasterIds.has(cid)) return masterMenuReplyKeyboard();
  if (cid === String(SUPER_ADMIN_ID) || cid === String(ADMIN_CHAT_ID)) return adminMenuReplyKeyboard(chatId);
  // Защита: если юзер деактивирован, но остался в authorizedChatIds, он не получит админку
  return { remove_keyboard: true };
}

function mastersKeyboard() {
  const rows = [...activeMasterIds].map((tid) => [{ text: `🏙 ${getMasterLabel(tid)}`, callback_data: `ADMIN_PICK_MASTER:${tid}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function mastersChatKeyboard() {
  const rows = [...activeMasterIds].map((tid) => [{ text: `💬 ${getMasterLabel(tid)}`, callback_data: `ADMIN_CHAT_MASTER:${tid}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function orderTypeKeyboard() {
  return { inline_keyboard: [[{ text: "🛠 Монтаж", callback_data: "ADMIN_TYPE:INSTALL" }, { text: "🔧 Ремонт / другое", callback_data: "ADMIN_TYPE:REPAIR" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] };
}
function logisticsKeyboard() {
  return { inline_keyboard: [[{ text: "🚗 Выезд", callback_data: "ADMIN_LOG:VISIT" }, { text: "🏢 Сам приедет", callback_data: "ADMIN_LOG:COME" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] };
}
function reportPeriodKeyboard() {
  return { inline_keyboard: [[{ text: "📆 Сегодня", callback_data: "REPORT_PERIOD:TODAY" }, { text: "📆 Вчера", callback_data: "REPORT_PERIOD:YESTERDAY" }], [{ text: "🗓 Этот месяц", callback_data: "REPORT_PERIOD:THIS_MONTH" }, { text: "🗓 Прошлый месяц", callback_data: "REPORT_PERIOD:LAST_MONTH" }], [{ text: "📅 7 дней", callback_data: "REPORT_PERIOD:LAST_7" }, { text: "📅 Свой период", callback_data: "REPORT_PERIOD:PERIOD" }], [{ text: "⏳ Ожидающие заявки", callback_data: "REPORT_PERIOD:PENDING" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] };
}

function reportCalendarKeyboard(mode, yyyymm) {
  const prefix = mode === "START" ? "RP_START" : "RP_END";
  const parsed = parseYyyymm(yyyymm);
  const now = new Date();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const jsDow = new Date(year, month - 1, 1).getDay();
  const dow = (jsDow + 6) % 7;
  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const rows = [];
  rows.push([{ text: "‹", callback_data: `${prefix}_MN:${formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1)}` }, { text: monthLabelShort(year, month), callback_data: "NOOP" }, { text: "›", callback_data: `${prefix}_MN:${formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1)}` }]);
  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if ((week === 0 && i < dow) || day > daysInMonth) { row.push({ text: "·", callback_data: "NOOP" }); continue; }
      row.push({ text: String(day), callback_data: `${prefix}_MD:${year}${pad2(month)}${pad2(day)}` });
      day++;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function masterOrderKeyboard(orderId) {
  return { inline_keyboard: [[{ text: "✅ Сегодня", callback_data: `MASTER_ACCEPT:${orderId}:TODAY` }, { text: "✅ Завтра", callback_data: `MASTER_ACCEPT:${orderId}:TOMORROW` }], [{ text: "📅 Другая дата", callback_data: `MASTER_ACCEPT:${orderId}:CAL` }]] };
}

function getMissingPhotoWarning(order) {
  const devPhotos = order.devicePhotos || {};
  const slots = getPhotoSlots(order);
  const unitWarnings = {};
  for (const slot of slots) {
    if (slot.photoType !== "odometer" && slot.photoType !== "plate") continue;
    if (devPhotos[slot.key] && devPhotos[slot.key] !== "SKIPPED") continue;
    const unitKey = `${slot.deviceName}_${slot.unitIdx}`;
    if (!unitWarnings[unitKey]) unitWarnings[unitKey] = { label: `${slot.deviceName}-${slot.unitIdx + 1}`, missing: [] };
    unitWarnings[unitKey].missing.push(slot.photoType === "odometer" ? "пробег" : "номер");
  }
  const lines = Object.values(unitWarnings).filter(u => u.missing.length).map(u => `• ${u.label}: нет фото ${u.missing.join(" и ")}`);
  return lines.length ? `⚠️ Отсутствуют фото:\n${lines.join("\n")}` : null;
}

function masterArrivalPhotoKeyboard(orderId, order) {
  const rows = [];
  const devPhotos = order.devicePhotos || {};
  const pending = getPhotoSlots(order).filter(s => devPhotos[s.key] === undefined);
  let i = 0;
  while (i < pending.length) {
    const slot = pending[i];
    const next = pending[i + 1];
    if (slot.photoType === "device" && next?.photoType === "dut" && next?.deviceName === slot.deviceName && next?.unitIdx === slot.unitIdx) {
      rows.push([{ text: slot.label, callback_data: `MASTER_PHOTO:${orderId}:${slot.key}` }, { text: next.label, callback_data: `MASTER_PHOTO:${orderId}:${next.key}` }]);
      i += 2;
    } else {
      const row = [{ text: slot.label, callback_data: `MASTER_PHOTO:${orderId}:${slot.key}` }];
      if (!slot.required) row.push({ text: "📷 Нет", callback_data: `MASTER_SKIP:${orderId}:${slot.key}` });
      rows.push(row);
      i++;
    }
  }
  if (rows.length === 0) return null;
  return { inline_keyboard: rows };
}

function pad2(n) { return String(n).padStart(2, "0"); }
function formatYyyymm(y, m) { return `${y}${pad2(m)}`; }
function parseYyyymm(yyyymm) {
  const m = String(yyyymm).match(/^(\d{4})(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]) };
}
function parseYyyymmdd(yyyymmdd) {
  const m = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}
const MONTH_SHORT = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
function monthLabelShort(y, mo) { return `${MONTH_SHORT[mo - 1]} ${y}`; }

function masterCalendarKeyboard(orderId, yyyymm) {
  const parsed = parseYyyymm(yyyymm);
  const now = new Date();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dow = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const rows = [];
  rows.push([{ text: "‹", callback_data: `MN:${orderId}:${formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1)}` }, { text: monthLabelShort(year, month), callback_data: "NOOP" }, { text: "›", callback_data: `MN:${orderId}:${formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1)}` }]);
  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if ((week === 0 && i < dow) || day > daysInMonth) { row.push({ text: "·", callback_data: "NOOP" }); continue; }
      row.push({ text: String(day), callback_data: `MD:${orderId}:${year}${pad2(month)}${pad2(day)}` });
      day++;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function masterHourKeyboard(orderId, yyyymmdd) {
  const hours = []; for (let h = 5; h <= 24; h++) hours.push(h);
  const rows = [];
  for (let i = 0; i < hours.length; i += 4) {
    rows.push(hours.slice(i, i + 4).map((h) => ({ text: `${pad2(h)}:00`, callback_data: `MH:${orderId}:${yyyymmdd}:${pad2(h)}` })));
  }
  rows.push([{ text: "⬅ Дата", callback_data: `MB:${orderId}:${yyyymmdd.slice(0, 6)}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function adminProposeCalendarKeyboard(orderId, yyyymm) {
  const parsed = parseYyyymm(yyyymm);
  const now = new Date();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dow = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const rows = [];
  rows.push([{ text: "‹", callback_data: `APROP_MN:${orderId}:${formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1)}` }, { text: monthLabelShort(year, month), callback_data: "NOOP" }, { text: "›", callback_data: `APROP_MN:${orderId}:${formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1)}` }]);
  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if ((week === 0 && i < dow) || day > daysInMonth) { row.push({ text: "·", callback_data: "NOOP" }); continue; }
      row.push({ text: String(day), callback_data: `APROP_MD:${orderId}:${year}${pad2(month)}${pad2(day)}` });
      day++;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function adminProposeHourKeyboard(orderId, yyyymmdd) {
  const hours = []; for (let h = 5; h <= 24; h++) hours.push(h);
  const rows = [];
  for (let i = 0; i < hours.length; i += 4) {
    rows.push(hours.slice(i, i + 4).map((h) => ({ text: `${pad2(h)}:00`, callback_data: `APROP_MH:${orderId}:${yyyymmdd}:${pad2(h)}` })));
  }
  rows.push([{ text: "⬅ Дата", callback_data: `APROP_MB:${orderId}:${yyyymmdd.slice(0, 6)}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function optionsKeyboard(orderId, selected = []) {
  const rows = [];
  const addGroup = (header, names) => {
    rows.push([{ text: header, callback_data: "NOOP" }]);
    for (let i = 0; i < names.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, names.length); j++) {
        const idx = OPTIONS.indexOf(names[j]);
        row.push({ text: (selected.includes(idx) ? "✅ " : "") + names[j], callback_data: `ADMIN_OPT:${orderId}:${idx}` });
      }
      rows.push(row);
    }
  };
  addGroup("🔧 Устройства", OPTIONS_DEVICES);
  addGroup("🔩 Аксессуары", OPTIONS_ACCESSORIES);
  addGroup("📦 Другое", OPTIONS_OTHER);
  if (selected.length > 0) rows.push([{ text: `✅ Подтвердить выбор (${selected.length})`, callback_data: `ADMIN_OPT_CONFIRM:${orderId}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function adminCommentKeyboard(orderId) {
  return { inline_keyboard: [[{ text: "✅ Отправить", callback_data: `ADMIN_SUBMIT_COMMENT:${orderId}` }, { text: "❌ Отмена", callback_data: "CANCEL" }]] };
}

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
  res.sendStatus(200);
  try {
    const update = req.body || {};
    cleanupDedupe();

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

      await onMessage(update.message);
    }
    if (update.callback_query) {
      const cq = update.callback_query;

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

  if (from && message.chat?.type === "private") {
    const cid = String(chatId);
    if (!userProfiles[cid]) userProfiles[cid] = {};
    userProfiles[cid].username = from.username ?? userProfiles[cid].username;
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
    if (fullName) userProfiles[cid].name = fullName;
  }

  // БАГ №8 И №9: ЖЕСТКАЯ МОДЕРАЦИЯ НОВИЧКОВ (Без паролей)
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

  if (isMasterChat(chatId) && !seenMasters.has(String(chatId))) {
    seenMasters.add(String(chatId));
    const masterName = getMasterLabel(chatId);
    const notifyMsg = `🟢 Мастер ${masterName} впервые подключился к боту.`;
    safeSend(SUPER_ADMIN_ID, notifyMsg);
    if (String(ADMIN_CHAT_ID) !== String(SUPER_ADMIN_ID)) safeSend(ADMIN_CHAT_ID, notifyMsg);
  }

  if (text === "/start") {
    const fromId = message.from?.id;
    const isSuperAdmin = fromId != null && String(fromId) === String(SUPER_ADMIN_ID);
    await setChatMenuButtonForChat(chatId, isSuperAdmin ? "commands" : "default");
    const keyboard = isSuperAdmin ? adminMenuReplyKeyboard(chatId) : menuKeyboardForChat(chatId);
    await sendMessage(chatId, "✅ Меню активировано.", { reply_markup: keyboard });
    return;
  }
  if (text === "/getmyid") {
    await sendMessage(chatId, `Ваш Telegram ID: ${message.from?.id}\nChat ID: ${chatId}`, { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }
  if (text === "❌ Отмена" || text === "/cancel") {
    clearState(chatId);
    await sendMessage(chatId, "❌ Отменено.", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  if (text === "📊 Отчёт" || text === "📊 Мой отчёт") {
    const isMaster = isMasterChat(chatId);
    const scope = isMaster ? "MASTER" : "ADMIN";
    const masterTgId = isMaster ? chatId : null;
    setState(chatId, "REPORT_WAIT_PERIOD", { scope, masterTgId });
    await sendMessage(chatId, "📊 Выберите период отчёта:", { reply_markup: reportPeriodKeyboard() });
    return;
  }

  // БАГ №5: ИСПРАВЛЕН ПРИВАТНЫЙ ЧАТ РУКОВОДСТВА
  if (text === "🧑‍💼💬 Чат с супер-админом" || text === "🧑‍💼💬 Чат с админом") {
    if (!ADMIN_CHAT_ID || !SUPER_ADMIN_ID) {
      await sendMessage(chatId, "⚠️ Не настроены ADMIN_CHAT_ID / SUPER_ADMIN_ID.");
      return;
    }
    const peerId = String(chatId) === String(SUPER_ADMIN_ID) ? String(ADMIN_CHAT_ID) : String(SUPER_ADMIN_ID);
    setState(chatId, "ADMIN_SUPER_CHAT", { peerId });
    await sendMessage(chatId, `✅ Режим чата включён. Сообщения будут отправляться напрямую.\nЧтобы выйти — отправьте: ❌ Отмена`);
    return;
  }

  if (text === "💬 Написать админу" || text === "💬 Продолжить чат" || text === "💬 Чат с мастером") {
    if (isMasterChat(chatId)) {
      setState(chatId, "MASTER_CHAT_WITH_ADMIN", {});
      await sendMessage(chatId, "💬 Чат с админом. Напишите сообщение. Для выхода нажмите «❌ Отмена».", { reply_markup: masterMenuReplyKeyboard() });
      return;
    } else {
      if (String(chatId) !== String(ADMIN_CHAT_ID) && String(chatId) !== String(SUPER_ADMIN_ID)) {
        await sendMessage(chatId, "⚠️ У вас нет прав для общения с мастерами.", { reply_markup: menuKeyboardForChat(chatId) });
        return;
      }
      setState(chatId, "ADMIN_CHAT_PICK_MASTER", {});
      await sendMessage(chatId, "💬 Выберите мастера:", { reply_markup: mastersChatKeyboard() });
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

  // Обработка ручного ввода (Approve, Edit Name, City)
  if (String(chatId) === String(SUPER_ADMIN_ID) || String(chatId) === String(ADMIN_CHAT_ID)) {
    const stApp = getState(chatId);
    // ADD USER BY ID (SUPER_ADMIN)
    if (stApp && stApp.step === "ADD_USER_WAIT_ID") {
      const rawId = text.replace(/\D/g, "");
      if (!rawId || rawId.length < 5 || rawId.length > 12) { await sendMessage(chatId, "Введите корректный Telegram ID (5–12 цифр):"); return; }
      clearState(chatId);
      setState(chatId, "ADD_USER_PICK_ROLE", { applicantChatId: rawId });
      const kb = { inline_keyboard: [
        [{ text: "✅ Назначить MASTER", callback_data: `ADD_USER_ROLE:${rawId}:MASTER` }, { text: "✅ Назначить ADMIN", callback_data: `ADD_USER_ROLE:${rawId}:ADMIN` }],
        [{ text: "❌ Отмена", callback_data: "CANCEL" }]
      ]};
      await sendMessage(chatId, `ID: ${rawId}\nВыберите роль:`, { reply_markup: kb });
      return;
    }
    if (stApp && stApp.step === "ADD_USER_WAIT_NAME") {
      const applicantChatId = stApp.data.applicantChatId;
      const role = stApp.data.role;
      const name = text.trim();
      if (!name || name.length > 80) { await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:"); return; }
      setState(chatId, "ADD_USER_WAIT_CITY", { applicantChatId, role, name });
      await sendMessage(chatId, "🏙 Введите город:");
      return;
    }
    if (stApp && stApp.step === "ADD_USER_WAIT_CITY") {
      const applicantChatId = stApp.data.applicantChatId;
      const role = stApp.data.role;
      const name = stApp.data.name;
      const city = text.trim();
      if (city.length < 2 || city.length > 40) { await sendMessage(chatId, "Город должен быть от 2 до 40 символов. Введите снова:"); return; }
      clearState(chatId);
      const sid = String(applicantChatId);
      authorizedChatIds.add(sid);
      authorizedRoles.set(sid, role);
      userProfiles[sid] = { name, city, role, username: userProfiles[sid]?.username ?? null };
      if (role === "MASTER") {
        activeMasterIds.add(sid);
        inactiveMasterIds.delete(sid);
        authorizedMasterCity.set(sid, city);
        dynamicMasters.set(sid, { name, city });
      }
      saveData();
      await safeSend(applicantChatId, `✅ Доступ выдан. Роль: ${role}. Город: ${city}. Нажмите /start`, { reply_markup: role === "MASTER" ? masterMenuReplyKeyboard() : adminMenuReplyKeyboard(applicantChatId) });
      await sendMessage(chatId, `✅ Пользователь добавлен: ${name} (${role}), ${city}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    if (stApp && stApp.step === "APPROVE_MASTER_NAME") {
      const applicantChatId = stApp.data.applicantChatId;
      const name = text.trim();
      if (!name || name.length > 80) { await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:"); return; }
      setState(chatId, "APPROVE_MASTER_CITY", { applicantChatId, name });
      await sendMessage(chatId, "🏙 Введите город для мастера (текстом). Например: Душанбе");
      return;
    }
    if (stApp && stApp.step === "APPROVE_MASTER_CITY") {
      const applicantChatId = stApp.data.applicantChatId;
      const name = stApp.data.name;
      const city = text.trim();
      if (city.length < 2 || city.length > 40) { await sendMessage(chatId, "Город должен быть от 2 до 40 символов. Введите снова:"); return; }
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

      await sendMessage(applicantChatId, `✅ Доступ выдан. Роль: MASTER. Город: ${city}. Меню активировано.`, { reply_markup: masterMenuReplyKeyboard() });
      await sendMessage(chatId, `✅ Мастер активирован: ${name}, ${city}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    if (stApp && stApp.step === "APPROVE_ADMIN_NAME") {
      const applicantChatId = stApp.data.applicantChatId;
      const name = text.trim();
      if (!name || name.length > 80) { await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:"); return; }
      clearState(chatId);
      const username = pendingApprovalInfo.get(String(applicantChatId))?.username ?? userProfiles[String(applicantChatId)]?.username;
      pendingApprovalInfo.delete(String(applicantChatId));
      authorizedChatIds.add(String(applicantChatId));
      authorizedRoles.set(String(applicantChatId), "ADMIN");
      userProfiles[String(applicantChatId)] = { name, city: null, role: "ADMIN", username: username ?? null };
      saveData();

      await sendMessage(applicantChatId, "✅ Доступ выдан. Роль: ADMIN. Меню активировано.", { reply_markup: adminMenuReplyKeyboard(applicantChatId) });
      await sendMessage(chatId, `✅ Пользователь одобрен как ADMIN: ${name}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    if (stApp && stApp.step === "MASTER_EDIT_NAME") {
      const targetTgId = stApp.data.targetTgId;
      const name = text.trim();
      if (!name || name.length > 80) { await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:"); return; }
      setState(chatId, "MASTER_EDIT_CITY", { targetTgId, name });
      await sendMessage(chatId, "🏙 Введите город для мастера:");
      return;
    }
    if (stApp && stApp.step === "MASTER_EDIT_CITY") {
      const targetTgId = stApp.data.targetTgId;
      const name = stApp.data.name;
      const city = text.trim();
      if (city.length < 2 || city.length > 40) { await sendMessage(chatId, "Город от 2 до 40 символов. Введите снова:"); return; }
      clearState(chatId);
      const sid = String(targetTgId);
      if (userProfiles[sid]) { userProfiles[sid].name = name; userProfiles[sid].city = city; }
      else userProfiles[sid] = { name, city, role: "MASTER", username: null };
      dynamicMasters.set(sid, { name, city });
      authorizedMasterCity.set(sid, city);
      saveData();

      await sendMessage(chatId, `✅ Мастер обновлён: ${name}, ${city}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    if (stApp && stApp.step === "ROLE_SET_MASTER_CITY") {
      const targetTgId = stApp.data.targetTgId;
      const city = text.trim();
      if (city.length < 2 || city.length > 40) { await sendMessage(chatId, "Город от 2 до 40 символов. Введите снова:"); return; }
      clearState(chatId);
      const sid = String(targetTgId);
      authorizedRoles.set(sid, "MASTER");
      activeMasterIds.add(sid);
      if (userProfiles[sid]) { userProfiles[sid].role = "MASTER"; userProfiles[sid].city = city; }
      else userProfiles[sid] = { name: sid, city, role: "MASTER", username: null };
      authorizedMasterCity.set(sid, city);
      dynamicMasters.set(sid, { name: userProfiles[sid].name || sid, city });
      saveData();

      await sendMessage(chatId, `✅ Роль установлена: MASTER, город ${city}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
  }
  if (text === "📇 Контакты (Excel)" && String(chatId) === String(SUPER_ADMIN_ID)) { await sendContactsExcel(chatId); return; }

  // SUPER_ADMIN: Добавить пользователя по Telegram ID
  if (text === "➕ Добавить юзера (ID)" && String(chatId) === String(SUPER_ADMIN_ID)) {
    setState(chatId, "ADD_USER_WAIT_ID", {});
    await sendMessage(chatId, "Введите Telegram ID пользователя (только цифры):", { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }


  // БАГ №1: ИСПРАВЛЕНА ФИЛЬТРАЦИЯ ДЛЯ КНОПКИ РОЛЕЙ
  if (text === "🔁 Роли" && String(chatId) === String(SUPER_ADMIN_ID)) {
    const allIds = new Set([...authorizedChatIds, ...activeMasterIds, ...Object.keys(userProfiles)]);
    if (ADMIN_CHAT_ID && String(ADMIN_CHAT_ID) !== String(SUPER_ADMIN_ID)) allIds.add(String(ADMIN_CHAT_ID));

    const rows = [...allIds].slice(0, 50).map((cid) => {
      const p = userProfiles[cid];
      let role = authorizedRoles.get(cid);
      if (!role) {
        if (activeMasterIds.has(cid)) role = "MASTER";
        else if (String(cid) === String(ADMIN_CHAT_ID)) role = "ADMIN";
        else role = "БЕЗ РОЛИ";
      }
      const nameLabel = (p && p.name) ? p.name : (p && p.username ? `@${p.username}` : cid);
      return [{ text: `${nameLabel} (${role})`, callback_data: `ROLE_EDIT:${cid}` }];
    });

    if (rows.length === 0) rows.push([{ text: "Пользователей пока нет", callback_data: "NOOP" }]);
    rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);

    await sendMessage(chatId, "🔁 Смена ролей. Выберите пользователя для управления:", { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (text === "👷 Мастера") {
    await sendMessage(chatId, "👷 Мастера:", { reply_markup: { inline_keyboard: [[{ text: "✅ Активные", callback_data: "MLIST:ACTIVE" }, { text: "🗃 Неактивные", callback_data: "MLIST:INACTIVE" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] } });
    return;
  }

  // FSM Processing
  const st = getState(chatId);
  if (!st) {
    await sendMessage(chatId, "Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  if (st.step === "ADMIN_CHAT_WITH_MASTER") {
    const masterTgId = st.data.masterTgId;
    const masterName = getMasterInfo(masterTgId).name;
    const hasContent = text || message.photo || message.document || message.video || message.voice || message.audio || message.video_note || message.sticker || message.contact || message.location;
    if (hasContent) {
      await forwardChatMessage(message, masterTgId, "💬 Сообщение от админа");
      if (String(chatId) === String(ADMIN_CHAT_ID)) await forwardChatMessage(message, SUPER_ADMIN_ID, `📡 Чат админа с мастером ${masterName}`);
      await sendMessage(chatId, `✅ Отправлено ${masterName}.`, { reply_markup: adminMenuReplyKeyboard(chatId) });
    }
    return;
  }

  // БАГ №10: ЗАЩИТА ОТ СООБЩЕНИЙ НЕАКТИВНЫХ МАСТЕРОВ
  if (st.step === "MASTER_CHAT_WITH_ADMIN") {
    if (!activeMasterIds.has(String(chatId))) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Ваш аккаунт деактивирован. Чат недоступен.", { reply_markup: menuKeyboardForChat(chatId) });
      return;
    }
    const masterName = getMasterInfo(chatId).name;
    const hasContent = text || message.photo || message.document || message.video || message.voice || message.audio || message.video_note || message.sticker || message.contact || message.location;
    if (hasContent) {
      await forwardChatMessage(message, ADMIN_CHAT_ID, `💬 Мастер ${masterName}`);
      if (String(SUPER_ADMIN_ID) !== String(ADMIN_CHAT_ID)) await forwardChatMessage(message, SUPER_ADMIN_ID, `📡 Мастер ${masterName} → админу`);
      await sendMessage(chatId, "✅ Отправлено админу.", { reply_markup: masterMenuReplyKeyboard() });
    }
    return;
  }

  if (st.step === "ADMIN_SUPER_CHAT") {
    const peerId = st.data.peerId;
    const hasContent = text || message.photo || message.document || message.video || message.voice || message.audio || message.video_note || message.sticker || message.contact || message.location;
    if (hasContent && peerId) {
      const senderName = String(chatId) === String(SUPER_ADMIN_ID) ? "Супер-админ" : "Админ";
      await forwardChatMessage(message, peerId, `💬 ${senderName}`);
      await sendMessage(chatId, "✅ Отправлено.", { reply_markup: adminMenuReplyKeyboard(chatId) });
    }
    return;
  }

  if (st.step === "ADMIN_WAIT_PHONE") {
    const phoneDigits = text.replace(/\D/g, "");
    if (phoneDigits.length !== 9) {
      const hint = phoneDigits.length < 9 ? `не хватает ${9 - phoneDigits.length}` : `лишние ${phoneDigits.length - 9}`;
      await sendMessage(chatId, `⚠️ Номер должен содержать строго 9 цифр (${hint}). Попробуйте ещё раз.`, { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    st.data.phone = phoneDigits;
    setState(chatId, "ADMIN_WAIT_MASTER", st.data);
    await sendMessage(chatId, "Выберите мастера:", { reply_markup: mastersKeyboard() });
    return;
  }

  if (st.step === "ADMIN_WAIT_ADDRESS") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) { clearState(chatId); await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) }); return; }
    order.address = text;
    if (order.type === "REPAIR") {
      setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
      await sendMessage(chatId, `🧰 Ремонт / другое\n🚗 Выезд к клиенту\n📍 Адрес: ${order.address}\n\n✍️ Напишите комментарий:`, { reply_markup: adminCommentKeyboard(orderId) });
      return;
    }
    setState(chatId, "ADMIN_WAIT_OPTION", { orderId });
    await sendMessage(chatId, `🛠 Монтаж\n🚗 Выезд\n📍 Адрес: ${order.address}\n\nВыберите опцию:`, { reply_markup: optionsKeyboard(orderId) });
    return;
  }

  if (st.step === "ADMIN_WAIT_QTY_CUSTOM") {
    const { orderId, qtyIdx, quantities } = st.data;
    const order = orders.get(orderId);
    if (!order) { clearState(chatId); await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) }); return; }
    const qty = parseInt(text, 10);
    if (!qty || qty < 1 || qty > 999) { await sendMessage(chatId, "⚠️ Введите число от 1 до 999:"); return; }
    const deviceName = order.options[qtyIdx];
    quantities[deviceName] = qty;
    const nextIdx = qtyIdx + 1;
    if (nextIdx < order.options.length) {
      setState(chatId, "ADMIN_WAIT_QTY", { orderId, qtyIdx: nextIdx, quantities });
      await sendMessage(chatId, `✅ ${deviceName}: ${qty} шт.\n\n🔢 Сколько ${order.options[nextIdx]}?`, { reply_markup: qtyKeyboard(orderId) });
      return;
    }
    order.deviceQuantities = { ...quantities };
    order.totalDevices = Object.values(quantities).reduce((a, b) => a + b, 0);
    const qtyText = order.options.map(o => `${o} × ${quantities[o]}`).join(", ");
    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
    await sendMessage(chatId, `✅ Устройства: ${qtyText}\n\n✍️ Напишите комментарий:`, { reply_markup: adminCommentKeyboard(orderId) });
    return;
  }

  if (st.step === "ADMIN_WAIT_COMMENT") {
    const orderId = st.data.orderId;
    const order = orders.get(orderId);
    if (!order) { clearState(chatId); await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) }); return; }
    order.adminComment = text;
    order.status = "SENT_TO_MASTER";

    clearState(chatId);
    await sendOrderToMaster(order);
    await sendMessage(chatId, formatAdminConfirm(order), { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  // БАГ №7: ИСПРАВЛЕН ПРИЕМ ФОТО "ФАЙЛОМ" (message.document)
  if (st.step === "MASTER_WAIT_PHOTO") {
    const orderId = st.data.orderId;
    const photoType = st.data.photoType;
    const origMsgId = st.data.messageId;
    const frMsgId = st.data.frMsgId;
    const order = orders.get(orderId);

    if (!order || String(order.masterTgId) !== String(chatId)) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: masterMenuReplyKeyboard() });
      return;
    }

    const photos = message.photo || [];
    let fileId = null;

    if (photos.length > 0) {
      fileId = photos[photos.length - 1].file_id;
    } else if (message.document && message.document.mime_type?.startsWith("image/")) {
      fileId = message.document.file_id;
    }

    if (!fileId) {
      await sendMessage(chatId, "⚠️ Пожалуйста, отправьте именно фото (можно как файл, но формат должен быть картинкой).");
      return;
    }

    if (frMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: frMsgId }).catch(() => {});
    await tg("deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => {});

    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;
    if (!order.devicePhotos) order.devicePhotos = {};
    order.devicePhotos[photoType] = fileId;

    const slot = getPhotoSlots(order).find(s => s.key === photoType);
    const photoLabel = slot ? slot.label : photoType;
    const photoDate = order.createdAt ? formatDate(new Date(order.createdAt)) : "—";
    const photoCaption = `📷 ${photoLabel}\n📋 Заявка #${order.id}\n📅 Дата: ${photoDate}\n📞 Клиент: ${order.phone || "—"}`;

    await sendPhoto(adminChatIdImm, fileId, photoCaption).catch(() => {});
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) {
      sendPhoto(SUPER_ADMIN_ID, fileId, photoCaption).catch(() => {});
    }

    clearState(chatId);
    const kb = masterArrivalPhotoKeyboard(orderId, order);

    if (kb) {
      if (origMsgId) {
        await tg("editMessageText", { chat_id: chatId, message_id: origMsgId, text: `✅ ${photoLabel} — принято (заявка #${order.id})`, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      await sendMessage(chatId, `📷 Заявка #${order.id} — выберите следующее:`, { reply_markup: kb });
      return;
    }

    setState(chatId, "MASTER_WAIT_DONE", { orderId });
    const warnMsg = getMissingPhotoWarning(order);
    const adminChatIdW = order.adminChatId || SUPER_ADMIN_ID;
    if (warnMsg) {
      safeSend(adminChatIdW, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnMsg}`);
      if (String(adminChatIdW) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnMsg}`);
    }
    const doneText = `✅ Заявка #${order.id} — все фото сохранены.` + (warnMsg ? `\n\n${warnMsg}` : "") + `\n\n<b>По завершению работ нажмите «✅ Выполнено».</b>`;

    if (origMsgId) {
      await tg("editMessageText", { chat_id: chatId, message_id: origMsgId, text: doneText, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] } }).catch(() => {});
    } else {
      if (warnMsg) await sendMessage(chatId, warnMsg);
      await sendMessage(chatId, doneText, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] } });
    }
    return;
  }

  if (st.step === "MASTER_WAIT_DONE") {
    await sendMessage(chatId, "Нажмите кнопку «✅ Выполнено» в сообщении выше.", { reply_markup: masterMenuReplyKeyboard() });
    return;
  }

  clearState(chatId);
  await sendMessage(chatId, "⚠️ Сессия сброшена. Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
}

async function onCallback(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data;
  const from = callbackQuery.from;

  if (data === "NOOP") { await answerCb(callbackQuery.id); return; }
  if (data === "CANCEL") {
    clearState(chatId);
    await answerCb(callbackQuery.id, "Отменено");
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    await sendMessage(chatId, "❌ Действие отменено.", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  // БАГ №8/9: Модерация доступа новых пользователей
  if (data.startsWith("APPROVE_MASTER:")) {
    const applicantChatId = data.split(":")[1];
    if (authorizedChatIds.has(String(applicantChatId))) {
      await answerCb(callbackQuery.id, "Уже обработано", true);
      await editMessage(chatId, messageId, `✅ Пользователь ${applicantChatId} уже был обработан.`);
      return;
    }
    setState(chatId, "APPROVE_MASTER_NAME", { applicantChatId });
    await answerCb(callbackQuery.id);
    await editMessage(chatId, messageId, `✅ Вы выбрали MASTER для ${applicantChatId}.\n\nВведите Имя мастера (например, Иван):`);
    return;
  }
  if (data.startsWith("APPROVE_ADMIN:")) {
    const applicantChatId = data.split(":")[1];
    if (authorizedChatIds.has(String(applicantChatId))) {
      await answerCb(callbackQuery.id, "Уже обработано", true);
      await editMessage(chatId, messageId, `✅ Пользователь ${applicantChatId} уже был обработан.`);
      return;
    }
    setState(chatId, "APPROVE_ADMIN_NAME", { applicantChatId });
    await answerCb(callbackQuery.id);
    await editMessage(chatId, messageId, `✅ Вы выбрали ADMIN для ${applicantChatId}.\n\nВведите Имя администратора:`);
    return;
  }
  if (data.startsWith("DECLINE:")) {
    const applicantChatId = data.split(":")[1];
    pendingApprovalInfo.delete(String(applicantChatId));
    await answerCb(callbackQuery.id, "Отклонено");
    await editMessage(chatId, messageId, `❌ Заявка от ${applicantChatId} отклонена.`);
    await safeSend(applicantChatId, "⛔ Ваша заявка на доступ отклонена.");
    return;
  }

  
  // SUPER_ADMIN: Add user by ID -> pick role
  if (data.startsWith("ADD_USER_ROLE:")) {
    const [, applicantChatId, role] = data.split(":");
    if (String(chatId) !== String(SUPER_ADMIN_ID)) { await answerCb(callbackQuery.id, "Нет прав", true); return; }
    clearState(chatId);
    setState(chatId, "ADD_USER_WAIT_NAME", { applicantChatId, role });
    await answerCb(callbackQuery.id);
    await editMessage(chatId, messageId, `✅ Роль: ${role} для ${applicantChatId}.\nВведите имя:`);
    return;
  }
if (data.startsWith("ROLE_EDIT:")) {
    const cid = data.split(":")[1];
    const p = userProfiles[cid];
    let role = authorizedRoles.get(cid) || "БЕЗ РОЛИ";
    if (activeMasterIds.has(cid)) role = "MASTER";
    const nameStr = p?.name ? p.name : (p?.username ? `@${p.username}` : cid);
    const kb = {
      inline_keyboard: [
        [{ text: "👑 Set ADMIN", callback_data: `ROLE_SET:${cid}:ADMIN` }, { text: "👷 Set MASTER", callback_data: `ROLE_SET:${cid}:MASTER` }],
        [{ text: "🗑 Удалить доступ", callback_data: `ROLE_REVOKE:${cid}` }],
        [{ text: "❌ Отмена", callback_data: "CANCEL" }]
      ]
    };
    await editMessage(chatId, messageId, `Управление: ${nameStr}\nТекущая роль: ${role}`, { reply_markup: kb });
    return;
  }

  if (data.startsWith("ROLE_REVOKE:")) {
    const cid = data.split(":")[1];
    authorizedChatIds.delete(cid);
    authorizedRoles.delete(cid);
    activeMasterIds.delete(cid);
    inactiveMasterIds.delete(cid);
    dynamicMasters.delete(cid);
    authorizedMasterCity.delete(cid);
    clearState(cid);
    saveData();

    await answerCb(callbackQuery.id, "Доступ аннулирован");
    await editMessage(chatId, messageId, `❌ Доступ пользователя ${cid} полностью удалён.`);
    await safeSend(cid, "⛔ Ваш доступ к системе аннулирован администратором.", { reply_markup: { remove_keyboard: true } });
    return;
  }

  if (data.startsWith("ROLE_SET:")) {
    const [, cid, newRole] = data.split(":");
    if (newRole === "ADMIN") {
      authorizedRoles.set(cid, "ADMIN");
      activeMasterIds.delete(cid);
      inactiveMasterIds.delete(cid);
      authorizedMasterCity.delete(cid);
      dynamicMasters.delete(cid);
      if (userProfiles[cid]) { userProfiles[cid].role = "ADMIN"; userProfiles[cid].city = null; }
      saveData();

      await answerCb(callbackQuery.id, "Роль ADMIN установлена");
      await editMessage(chatId, messageId, `✅ Пользователь ${cid} теперь ADMIN.`);
      return;
    }
    if (newRole === "MASTER") {
      setState(chatId, "ROLE_SET_MASTER_CITY", { targetTgId: cid });
      await answerCb(callbackQuery.id);
      await editMessage(chatId, messageId, `🏙 Введите город для нового мастера (ID ${cid}):`);
      return;
    }
  }

  if (data.startsWith("MLIST:")) {
    const type = data.split(":")[1];
    const isAct = type === "ACTIVE";
    const list = isAct ? activeMasterIds : inactiveMasterIds;
    if (list.size === 0) {
      await answerCb(callbackQuery.id, "Список пуст", true);
      return;
    }
    const rows = [...list].map(tid => [{ text: getMasterLabel(tid), callback_data: `M_EDIT:${tid}` }]);
    rows.push([{ text: "⬅ Назад", callback_data: "MLIST_BACK" }]);
    await editMessage(chatId, messageId, isAct ? "✅ Активные мастера:" : "🗃 Неактивные мастера:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data === "MLIST_BACK") {
    await editMessage(chatId, messageId, "👷 Мастера:", { reply_markup: { inline_keyboard: [[{ text: "✅ Активные", callback_data: "MLIST:ACTIVE" }, { text: "🗃 Неактивные", callback_data: "MLIST:INACTIVE" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] } });
    return;
  }

  if (data.startsWith("M_EDIT:")) {
    const tid = data.split(":")[1];
    const act = activeMasterIds.has(tid);
    const kb = {
      inline_keyboard: [
        [{ text: "✏️ Изменить Имя/Город", callback_data: `M_RENAME:${tid}` }],
        [act ? { text: "⛔ Деактивировать", callback_data: `M_DEACT:${tid}` } : { text: "✅ Активировать", callback_data: `M_ACT:${tid}` }],
        [{ text: "⬅ Назад", callback_data: "MLIST_BACK" }]
      ]
    };
    await editMessage(chatId, messageId, `Управление мастером: ${getMasterLabel(tid)}`, { reply_markup: kb });
    return;
  }

  if (data.startsWith("M_RENAME:")) {
    const tid = data.split(":")[1];
    setState(chatId, "MASTER_EDIT_NAME", { targetTgId: tid });
    await editMessage(chatId, messageId, "Введите новое имя мастера:");
    return;
  }
  if (data.startsWith("M_DEACT:")) {
    const tid = data.split(":")[1];
    activeMasterIds.delete(tid);
    inactiveMasterIds.add(tid);
    clearState(tid);
    saveData();

    await answerCb(callbackQuery.id, "Мастер деактивирован");
    await editMessage(chatId, messageId, `⛔ Мастер ${getMasterLabel(tid)} деактивирован.`);
    return;
  }
  if (data.startsWith("M_ACT:")) {
    const tid = data.split(":")[1];
    inactiveMasterIds.delete(tid);
    activeMasterIds.add(tid);
    saveData();

    await answerCb(callbackQuery.id, "Мастер активирован");
    await editMessage(chatId, messageId, `✅ Мастер ${getMasterLabel(tid)} активирован.`);
    return;
  }

  if (data.startsWith("REPORT_PERIOD:")) {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_WAIT_PERIOD") { await answerCb(callbackQuery.id, "Устарело", true); return; }
    const p = data.split(":")[1];
    const { scope, masterTgId } = st.data;

    if (p === "PERIOD") {
      st.data.reportPeriod = "PERIOD";
      st.step = "REPORT_WAIT_START_DATE";
      const now = new Date();
      await editMessage(chatId, messageId, "Свой период. Выберите дату НАЧАЛА:", { reply_markup: reportCalendarKeyboard("START", formatYyyymm(now.getFullYear(), now.getMonth() + 1)) });
      return;
    }

    if (p === "PENDING") {
      st.data.reportPeriod = "PENDING";
      st.data.pending = true;
    } else {
      st.data.reportPeriod = p;
      const now = new Date();
      let fromTs, toTs;
      if (p === "TODAY") { fromTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); toTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime(); }
      else if (p === "YESTERDAY") { const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); fromTs = y.getTime(); toTs = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999).getTime(); }
      else if (p === "THIS_MONTH") { fromTs = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); toTs = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime(); }
      else if (p === "LAST_MONTH") { fromTs = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(); toTs = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).getTime(); }
      else if (p === "LAST_7") { fromTs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime(); toTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime(); }
      st.data.fromTs = fromTs; st.data.toTs = toTs;
    }

    st.step = "REPORT_READY";
    const title = p === "PENDING" ? "⏳ Ожидающие заявки" : `Отчёт: ${p}`;
    const formatKb = { inline_keyboard: [[{ text: "В сообщении (текст)", callback_data: "REPORT_TEXT" }, { text: "Файл Excel (.xlsx)", callback_data: "REPORT_EXCEL" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] };

    await editMessage(chatId, messageId, `✅ Выбрано: ${title}\nВ каком виде выгрузить?`, { reply_markup: formatKb });
    return;
  }

  if (data.startsWith("RP_START_MN:") || data.startsWith("RP_END_MN:")) {
    const isStart = data.startsWith("RP_START_MN:");
    const yyyymm = data.split(":")[1];
    await editMessage(chatId, messageId, isStart ? "Выберите дату НАЧАЛА:" : "Выберите дату ОКОНЧАНИЯ:", { reply_markup: reportCalendarKeyboard(isStart ? "START" : "END", yyyymm) });
    return;
  }

  if (data.startsWith("RP_START_MD:")) {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_WAIT_START_DATE") { await answerCb(callbackQuery.id, "Устарело", true); return; }
    const parsed = parseYyyymmdd(data.split(":")[1]);
    st.data.fromTs = new Date(parsed.y, parsed.mo - 1, parsed.d).getTime();
    st.step = "REPORT_WAIT_END_DATE";
    const now = new Date();
    await editMessage(chatId, messageId, "Свой период. Выберите дату ОКОНЧАНИЯ:", { reply_markup: reportCalendarKeyboard("END", formatYyyymm(now.getFullYear(), now.getMonth() + 1)) });
    return;
  }

  if (data.startsWith("RP_END_MD:")) {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_WAIT_END_DATE") { await answerCb(callbackQuery.id, "Устарело", true); return; }
    const parsed = parseYyyymmdd(data.split(":")[1]);
    st.data.toTs = new Date(parsed.y, parsed.mo - 1, parsed.d, 23, 59, 59, 999).getTime();
    if (st.data.fromTs > st.data.toTs) {
      const t = st.data.fromTs; st.data.fromTs = st.data.toTs; st.data.toTs = t;
    }
    st.step = "REPORT_READY";
    await editMessage(chatId, messageId, `✅ Выбран период.\nВ каком виде выгрузить?`, { reply_markup: { inline_keyboard: [[{ text: "В сообщении (текст)", callback_data: "REPORT_TEXT" }, { text: "Файл Excel (.xlsx)", callback_data: "REPORT_EXCEL" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] } });
    return;
  }

  if (data === "REPORT_TEXT" || data === "REPORT_EXCEL") {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_READY") {
      await answerCb(callbackQuery.id);
      await sendMessage(chatId, "⚠️ Сессия отчёта устарела. Нажмите «📊 Отчёт» и выберите период заново.");
      return;
    }

    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    const { scope, masterTgId } = st.data;

    if (data === "REPORT_TEXT") {
      await sendTextReport(chatId, st.data);
    } else {
      let filePath;
      try {
        if (st.data.pending) {
          filePath = buildExcelReportPending({ scope, masterTgId });
          await sendDocument(chatId, filePath, "📋 Ожидающие заявки");
        } else {
          const fromD = new Date(st.data.fromTs);
          const toD = new Date(st.data.toTs);
          filePath = buildExcelReport(fromD, toD, { scope, masterTgId });
          await sendDocument(chatId, filePath, `📊 Отчёт ${formatDate(fromD)}–${formatDate(toD)}`);
        }
      } catch (err) {
        console.error("Excel report error:", err);
        await sendMessage(chatId, "⚠️ Не удалось сформировать Excel. Попробуйте позже.");
      } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
      }
    }
    clearState(chatId);
    return;
  }

  // --- ADMIN СЦЕНАРИИ ---
  if (data.startsWith("ADMIN_PICK_MASTER:")) {
    const masterTgId = data.split(":")[1];
    const st = getState(chatId);
    if (!st) return;
    st.data.masterTgId = masterTgId;
    st.data.masterName = getMasterInfo(masterTgId).name;
    const isRepair = st.data.presetType === "REPAIR";
    st.data.type = isRepair ? "REPAIR" : "INSTALL";
    if (isRepair) {
      setState(chatId, "ADMIN_WAIT_LOGISTICS", st.data);
      await editMessage(chatId, messageId, `👷 Мастер: ${st.data.masterName}\n\nЛогистика клиента:`, { reply_markup: logisticsKeyboard() });
    } else {
      setState(chatId, "ADMIN_WAIT_LOGISTICS", st.data);
      await editMessage(chatId, messageId, `👷 Мастер: ${st.data.masterName}\n\nЛогистика:`, { reply_markup: logisticsKeyboard() });
    }
    return;
  }

  if (data.startsWith("ADMIN_CHAT_MASTER:")) {
    const masterTgId = data.split(":")[1];
    clearState(chatId);
    setState(chatId, "ADMIN_CHAT_WITH_MASTER", { masterTgId });
    await editMessage(chatId, messageId, `💬 Чат с мастером ${getMasterInfo(masterTgId).name}. Напишите сообщение. Для выхода — ❌ Отмена.`);
    return;
  }

  if (data.startsWith("ADMIN_LOG:")) {
    const logistics = data.split(":")[1];
    const st = getState(chatId);
    if (!st) return;
    lastOrderId++;
    const newOrder = {
      id: lastOrderId,
      createdAt: nowTjIso(),
      phone: st.data.phone,
      masterTgId: st.data.masterTgId,
      masterName: st.data.masterName,
      type: st.data.type,
      logistics,
      status: "DRAFT",
      adminChatId: chatId,
    };
    orders.set(String(lastOrderId), newOrder);
    saveData();

    if (logistics === "COME") {
      newOrder.address = "Сам приедет";
      if (newOrder.type === "REPAIR") {
        setState(chatId, "ADMIN_WAIT_COMMENT", { orderId: lastOrderId });
        await editMessage(chatId, messageId, `🧰 Ремонт\n🏢 Сам приедет\n\n✍️ Комментарий:`, { reply_markup: adminCommentKeyboard(lastOrderId) });
      } else {
        setState(chatId, "ADMIN_WAIT_OPTION", { orderId: lastOrderId });
        await editMessage(chatId, messageId, `🛠 Монтаж\n🏢 Сам приедет\n\nУстройства:`, { reply_markup: optionsKeyboard(lastOrderId) });
      }
    } else {
      setState(chatId, "ADMIN_WAIT_ADDRESS", { orderId: lastOrderId });
      await editMessage(chatId, messageId, "📍 Напишите адрес клиента:");
    }
    return;
  }

  if (data.startsWith("ADMIN_OPT:")) {
    const [, orderIdStr, optIdxStr] = data.split(":");
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_OPTION") return;
    const order = orders.get(orderIdStr);
    if (!order) return;
    if (!order.options) order.options = [];
    const name = OPTIONS[Number(optIdxStr)];
    if (order.options.includes(name)) order.options = order.options.filter((o) => o !== name);
    else order.options.push(name);
    const selectedIdx = order.options.map((o) => OPTIONS.indexOf(o));
    await editMessage(chatId, messageId, `🛠 Монтаж\n📍 ${order.address}\n\nУстройства:`, { reply_markup: optionsKeyboard(orderIdStr, selectedIdx) });
    return;
  }

  if (data.startsWith("ADMIN_OPT_CONFIRM:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) return;
    if (!order.options || order.options.length === 0) { await answerCb(callbackQuery.id, "Выберите хотя бы одно устройство!", true); return; }
    setState(chatId, "ADMIN_WAIT_QTY", { orderId, qtyIdx: 0, quantities: {} });
    await editMessage(chatId, messageId, `🔢 Сколько ${order.options[0]}?`, { reply_markup: qtyKeyboard(orderId) });
    return;
  }

  if (data.startsWith("ADMIN_QTY:")) {
    const [, orderId, qtyStr] = data.split(":");
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_QTY") return;
    const order = orders.get(orderId);
    if (!order) return;
    const deviceName = order.options[st.data.qtyIdx];
    st.data.quantities[deviceName] = parseInt(qtyStr, 10);
    const nextIdx = st.data.qtyIdx + 1;
    if (nextIdx < order.options.length) {
      st.data.qtyIdx = nextIdx;
      await editMessage(chatId, messageId, `✅ ${deviceName}: ${qtyStr} шт.\n\n🔢 Сколько ${order.options[nextIdx]}?`, { reply_markup: qtyKeyboard(orderId) });
      return;
    }
    order.deviceQuantities = { ...st.data.quantities };
    order.totalDevices = Object.values(st.data.quantities).reduce((a, b) => a + b, 0);
    const qtyText = order.options.map(o => `${o} × ${order.deviceQuantities[o]}`).join(", ");
    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
    await editMessage(chatId, messageId, `✅ Устройства: ${qtyText}\n\n✍️ Комментарий:`, { reply_markup: adminCommentKeyboard(orderId) });
    return;
  }

  if (data.startsWith("ADMIN_QTY_CUSTOM:")) {
    const orderId = data.split(":")[1];
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_QTY") return;
    const order = orders.get(orderId);
    if (!order) return;
    setState(chatId, "ADMIN_WAIT_QTY_CUSTOM", st.data);
    const deviceName = order.options[st.data.qtyIdx];
    await editMessage(chatId, messageId, `Введите количество для ${deviceName} цифрами:`);
    return;
  }

  if (data.startsWith("ADMIN_SUBMIT_COMMENT:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) return;
    order.adminComment = "—";
    order.status = "SENT_TO_MASTER";

    clearState(chatId);
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    await sendOrderToMaster(order);
    await sendMessage(chatId, formatAdminConfirm(order), { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  // --- МАСТЕР СЦЕНАРИИ ---
  if (data.startsWith("MASTER_ACCEPT:")) {
    const [, orderIdStr, dType] = data.split(":");
    const order = orders.get(orderIdStr);
    if (!order) return;
    if (order.status !== "SENT_TO_MASTER" && order.status !== "PROPOSED_BY_ADMIN") { await answerCb(callbackQuery.id, "Заявка уже в другом статусе", true); return; }

    if (dType === "CAL") {
      const now = new Date();
      await editMessage(chatId, messageId, `Заявка #${order.id}. Выберите месяц:`, { reply_markup: masterCalendarKeyboard(orderIdStr, formatYyyymm(now.getFullYear(), now.getMonth() + 1)) });
      return;
    }
    const today = new Date();
    const isToday = dType === "TODAY";
    if (!isToday) today.setDate(today.getDate() + 1);
    const yyyymmdd = `${today.getFullYear()}${pad2(today.getMonth() + 1)}${pad2(today.getDate())}`;
    await editMessage(chatId, messageId, `Выбрано: ${isToday ? "Сегодня" : "Завтра"}. Выберите время:`, { reply_markup: masterHourKeyboard(orderIdStr, yyyymmdd) });
    return;
  }

  if (data.startsWith("MN:")) {
    const [, orderIdStr, yyyymm] = data.split(":");
    await editMessage(chatId, messageId, `Заявка #${orderIdStr}. Выберите дату:`, { reply_markup: masterCalendarKeyboard(orderIdStr, yyyymm) });
    return;
  }
  if (data.startsWith("MD:")) {
    const [, orderIdStr, yyyymmdd] = data.split(":");
    await editMessage(chatId, messageId, `Заявка #${orderIdStr}. Выберите время:`, { reply_markup: masterHourKeyboard(orderIdStr, yyyymmdd) });
    return;
  }
  if (data.startsWith("MB:")) {
    const [, orderIdStr, yyyymm] = data.split(":");
    await editMessage(chatId, messageId, `Заявка #${orderIdStr}. Выберите месяц:`, { reply_markup: masterCalendarKeyboard(orderIdStr, yyyymm) });
    return;
  }

  if (data.startsWith("MH:")) {
    const [, orderIdStr, yyyymmdd, hh] = data.split(":");
    const order = orders.get(orderIdStr);
    if (!order) return;
    const y = parseInt(yyyymmdd.slice(0, 4), 10);
    const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
    const d = parseInt(yyyymmdd.slice(6, 8), 10);
    const selectedDate = new Date(y, m, d, parseInt(hh, 10), 0, 0);
    order.appointedDate = selectedDate.toISOString();
    order.status = "ACCEPTED_BY_MASTER";

    saveData();
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    const isCome = order.logistics === "COME";
    const arrivedText = isCome ? "🚪 Клиент приехал" : "📍 Я на месте";
    const arrivedMsg = isCome
      ? `✅ Вы приняли заявку #${order.id} на ${formatDate(selectedDate)}.\nКогда клиент приедет — нажмите «🚪 Клиент приехал».`
      : `✅ Вы приняли заявку #${order.id} на ${formatDate(selectedDate)}.\nКогда приедете — нажмите «📍 Я на месте».`;
    await sendMessage(chatId, arrivedMsg, { reply_markup: { inline_keyboard: [[{ text: arrivedText, callback_data: `MASTER_ARRIVED:${order.id}` }]] } });
    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;
    const notifMsg = `✅ Мастер ${order.masterName} принял заявку #${order.id} на ${formatDate(selectedDate)}`;
    await safeSend(adminChatIdImm, notifMsg);
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, notifMsg);
    return;
  }

  if (data.startsWith("MASTER_ARRIVED:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) return;
    order.status = "ARRIVED";
    order.arrivedAt = nowTjIso();

    saveData();
    const kb = masterArrivalPhotoKeyboard(orderId, order);
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;
    const isCome = order.logistics === "COME";
    const notifMsg = isCome
      ? `🚪 Клиент приехал: заявка #${order.id} (${order.masterName})`
      : `📍 Мастер прибыл: заявка #${order.id} (${order.masterName})`;
    safeSend(adminChatIdImm, notifMsg);
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, notifMsg);

    if (kb) {
      const arrivedSelfMsg = isCome
        ? `🚪 Клиент приехал (Заявка #${order.id}).\n\nСделайте фото:`
        : `📍 Вы прибыли (Заявка #${order.id}).\n\nСделайте фото:`;
      await sendMessage(chatId, arrivedSelfMsg, { reply_markup: kb });
    } else {
      setState(chatId, "MASTER_WAIT_DONE", { orderId });
      const isCome2 = order.logistics === "COME";
      const noPhotoMsg = isCome2
        ? `🚪 Клиент приехал (Заявка #${order.id}).\nФото не требуются. Жмите "Выполнено" по завершению.`
        : `📍 Вы прибыли (Заявка #${order.id}).\nФото не требуются. Жмите "Выполнено" по завершению.`;
      await sendMessage(chatId, noPhotoMsg, { reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderId}` }]] } });
    }
    return;
  }

  if (data.startsWith("MASTER_PHOTO:")) {
    const [, orderIdStr, photoType] = data.split(":");
    setState(chatId, "MASTER_WAIT_PHOTO", { orderId: orderIdStr, photoType, messageId });
    const order = orders.get(orderIdStr);
    const slot = getPhotoSlots(order).find(s => s.key === photoType);
    const label = slot ? slot.label : photoType;
    await answerCb(callbackQuery.id);
    const pReq = await sendMessage(chatId, `📷 Жду фото для: ${label} (заявка #${orderIdStr})`);
    const st2 = getState(chatId);
    if (st2) st2.data.frMsgId = pReq.data.message_id;
    return;
  }

  if (data.startsWith("MASTER_SKIP:")) {
    const [, orderIdStr, photoType] = data.split(":");
    const order = orders.get(orderIdStr);
    if (!order) return;
    if (!order.devicePhotos) order.devicePhotos = {};
    order.devicePhotos[photoType] = "SKIPPED";
    await answerCb(callbackQuery.id, "Пропущено");
    const kb = masterArrivalPhotoKeyboard(orderIdStr, order);
    if (kb) {
      await editMessage(chatId, messageId, `📷 Заявка #${orderIdStr} — выберите следующее:`, { reply_markup: kb });
    } else {
      setState(chatId, "MASTER_WAIT_DONE", { orderId: orderIdStr });
      const warnMsg = getMissingPhotoWarning(order);
      const adminChatIdW = order.adminChatId || SUPER_ADMIN_ID;
      if (warnMsg) {
        safeSend(adminChatIdW, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnMsg}`);
        if (String(adminChatIdW) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, `⚠️ Заявка #${order.id} (${order.masterName}):\n${warnMsg}`);
      }
      const doneText = `✅ Заявка #${order.id} — все фото сохранены.` + (warnMsg ? `\n\n${warnMsg}` : "") + `\n\n<b>По завершению работ нажмите «✅ Выполнено».</b>`;
      await editMessage(chatId, messageId, doneText, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Выполнено", callback_data: `MASTER_DONE:${orderIdStr}` }]] } });
    }
    return;
  }

  if (data.startsWith("MASTER_DONE:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(orderId);
    if (!order) return;
    order.status = "COMPLETED_BY_MASTER";
    order.completedAt = nowTjIso();

    saveData();
    clearState(chatId);
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    await sendMessage(chatId, `🎉 Отлично! Заявка #${order.id} выполнена. Ожидайте подтверждения админа.`);
    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;
    const kb = { inline_keyboard: [[{ text: "👍 Подтвердить время", callback_data: `ADMIN_CONFIRM_TIME:${order.id}` }], [{ text: "❌ Возврат (недоделка)", callback_data: `ADMIN_RETURN:${order.id}` }]] };
    const notifMsg = `🎉 Мастер ${order.masterName} завершил заявку #${order.id}.\n` + formatOrderDetails(order) + `\nСколько времени занял монтаж?`;
    await safeSend(adminChatIdImm, notifMsg, { reply_markup: kb });
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, notifMsg, { reply_markup: kb });
    return;
  }

  // --- ПОДТВЕРЖДЕНИЕ ВРЕМЕНИ И ЗАКРЫТИЕ АДМИНОМ ---
  if (data.startsWith("ADMIN_CONFIRM_TIME:")) {
    const orderId = data.split(":")[1];
    await editMessage(chatId, messageId, `⏳ Заявка #${orderId}. Укажите затраченное время:`, { reply_markup: installTimeKeyboard(orderId) });
    return;
  }

  if (data.startsWith("INST_TIME:")) {
    const [, orderIdStr, hoursStr] = data.split(":");
    const order = orders.get(orderIdStr);
    if (!order) return;
    order.installHours = parseInt(hoursStr, 10);
    order.status = "CLOSED";
    order.closedAt = nowTjIso();

    saveData();
    await editMessage(chatId, messageId, `✅ Заявка #${order.id} полностью ЗАКРЫТА.\nУчтено: ${order.installHours} ч.`);
    await safeSend(order.masterTgId, `✅ Ваша заявка #${order.id} закрыта администратором. Спасибо!`);
    return;
  }
}

// =============================
// Helper Functions
// =============================
async function sendOrderToMaster(order) {
  const kb = masterOrderKeyboard(order.id);
  await safeSend(order.masterTgId, formatMasterOrder(order), { reply_markup: kb });
}

function statusLabel(st) {
  const map = {
    DRAFT: "Черновик",
    SENT_TO_MASTER: "Отправлено мастеру",
    ACCEPTED_BY_MASTER: "Принято (назначена дата)",
    PROPOSED_BY_ADMIN: "Перенесено админом",
    ARRIVED: "Мастер на месте",
    COMPLETED_BY_MASTER: "Выполнено мастером",
    DECLINED_BY_MASTER: "Отказ мастера",
    CLOSED: "Закрыта (Оплачено)",
  };
  return map[st] || st;
}

function formatAdminConfirm(o) {
  return `✅ Заявка #${o.id} отправлена мастеру.\n\n` + formatOrderDetails(o);
}

function formatMasterOrder(o) {
  return `🔔 <b>НОВАЯ ЗАЯВКА #${o.id}</b>\n\n` + formatOrderDetails(o) + `\n\nУкажите, когда сможете выполнить:`;
}

function formatOrderDetails(o) {
  let res = `Тип: ${o.type === "REPAIR" ? "🔧 Ремонт" : "🛠 Монтаж"}\n` + `📞 Клиент: ${o.phone}\n` + `📍 Логистика: ${o.logistics === "COME" ? "🏢 Сам приедет" : "🚗 Выезд"}\n` + `🏠 Адрес: ${o.address || "—"}\n`;
  if (o.type === "INSTALL" && o.options) {
    res += `📦 Устройства: ${o.options.map(opt => `${opt} × ${o.deviceQuantities?.[opt] || 1}`).join(", ")}\n`;
  }
  res += `💬 Коммент: ${o.adminComment || "—"}\n` + `📊 Статус: ${statusLabel(o.status)}`;
  if (o.appointedDate) res += `\n⏰ Дата: ${formatDate(new Date(o.appointedDate))}`;
  return res;
}

function timeAgo(dateIso) {
  if (!dateIso) return "—";
  const diffMs = Date.now() - new Date(dateIso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}

function formatDate(d) {
  if (!d || isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Dushanbe", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

// БАГ №12: ИСПРАВЛЕНА ДАТА В ОТЧЕТЕ АУДИТА

async function sendContactsExcel(chatId) {
  let filePath;
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Contacts");
    sheet.columns = [
      { header: "Role", key: "role", width: 15 },
      { header: "ID", key: "id", width: 15 },
      { header: "Имя", key: "name", width: 25 },
      { header: "Username", key: "username", width: 15 },
      { header: "Город", key: "city", width: 15 },
      { header: "Статус", key: "status", width: 15 },
    ];
    for (const cid of authorizedChatIds) {
      const p = userProfiles[cid] || {};
      const r = authorizedRoles.get(cid) || "NO_ROLE";
      const st = r === "MASTER" ? (activeMasterIds.has(cid) ? "Активен" : "Неактивен") : "—";
      sheet.addRow([r, cid, p.name || "", p.username || "", p.city || "", st]);
    }
    filePath = path.join(os.tmpdir(), `contacts_${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(filePath);
    await sendDocument(chatId, filePath, "📇 Контакты пользователей");
  } catch (e) {
    console.error("sendContactsExcel error:", e);
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }
}

// БАГ №13: ИСПРАВЛЕНА ФИЛЬТРАЦИЯ ОТЧЕТОВ ПО completedAt
function getReportItems(from, to, opts) {
  const result = [];
  const startTs = from ? from.getTime() : 0;
  const endTs = to ? to.getTime() : 0;
  for (const [, o] of orders.entries()) {
    if (opts.pending) {
      if (["DRAFT", "SENT_TO_MASTER", "ACCEPTED_BY_MASTER", "PROPOSED_BY_ADMIN", "ARRIVED", "COMPLETED_BY_MASTER"].includes(o.status)) {
        if (!opts.masterTgId || String(o.masterTgId) === String(opts.masterTgId)) result.push(o);
      }
      continue;
    }

    const realDate = o.completedAt || o.closedAt || o.createdAt;
    const t = new Date(realDate).getTime();

    if (t < startTs || t > endTs) continue;
    if (opts.masterTgId && String(o.masterTgId) !== String(opts.masterTgId)) continue;
    result.push(o);
  }
  return result;
}

async function sendTextReport(chatId, data) {
  const items = getReportItems(data.fromTs ? new Date(data.fromTs) : null, data.toTs ? new Date(data.toTs) : null, { pending: data.pending, masterTgId: data.masterTgId });
  if (items.length === 0) { await sendMessage(chatId, "📭 За этот период нет данных."); return; }
  let totalHours = 0; let totalDevs = 0;
  items.forEach(o => { totalHours += (o.installHours || 0); totalDevs += (o.totalDevices || 0); });
  let txt = data.pending ? "⏳ <b>Ожидающие заявки:</b>\n\n" : `📊 <b>Отчёт (${formatDate(new Date(data.fromTs))} – ${formatDate(new Date(data.toTs))}):</b>\n\n`;
  txt += `Всего заявок: ${items.length}\nУстройств: ${totalDevs}\nЧасов: ${totalHours}\n\n`;
  items.slice(0, 30).forEach(o => { txt += `🔹 <b>#${o.id}</b> | ${statusLabel(o.status)}\nМастер: ${o.masterName}\nКлиент: ${o.phone}\n\n`; });
  if (items.length > 30) txt += `\n...и ещё ${items.length - 30} заявок. Выгрузите в Excel.`;
  await sendMessage(chatId, txt, { parse_mode: "HTML" });
}

// БАГ №4: ИСПРАВЛЕН ReferenceError (from/to вместо fromDate/toDate)
function buildExcelReport(from, to, opts) {
  const items = getReportItems(from, to, opts);
  const wb = XLSX.utils.book_new();
  const wsData = [
    [`Период отчёта: ${formatDate(from)}–${formatDate(to)} (Asia/Dushanbe)`],
    [],
    ["ID", "Создана", "Завершена", "Статус", "Телефон", "Мастер", "Тип", "Логистика", "Адрес", "Опции", "Устройств", "Затрачено часов", "Комментарий"]
  ];
  items.forEach(o => {
    wsData.push([
      o.id,
      formatDate(new Date(o.createdAt)),
      o.completedAt ? formatDate(new Date(o.completedAt)) : (o.closedAt ? formatDate(new Date(o.closedAt)) : "—"),
      statusLabel(o.status),
      o.phone,
      o.masterName,
      o.type === "REPAIR" ? "Ремонт" : "Монтаж",
      o.logistics === "COME" ? "Сам приедет" : "Выезд",
      o.address || "",
      (o.options || []).map(opt => `${opt}×${o.deviceQuantities?.[opt] || 1}`).join(", "),
      o.totalDevices || 0,
      o.installHours || 0,
      o.adminComment || ""
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, "Отчёт");
  const filePath = path.join(os.tmpdir(), `report_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

function buildExcelReportPending(opts) {
  const items = getReportItems(null, null, { pending: true, masterTgId: opts.masterTgId });
  const wb = XLSX.utils.book_new();
  const wsData = [
    ["ОЖИДАЮЩИЕ ЗАЯВКИ (PENDING)"],
    [],
    ["ID", "Создана", "Статус", "Прошло времени", "Телефон", "Мастер", "Тип", "Логистика", "Адрес", "Опции", "Комментарий"]
  ];
  items.forEach(o => {
    wsData.push([
      o.id,
      formatDate(new Date(o.createdAt)),
      statusLabel(o.status),
      timeAgo(o.createdAt),
      o.phone,
      o.masterName,
      o.type === "REPAIR" ? "Ремонт" : "Монтаж",
      o.logistics === "COME" ? "Сам приедет" : "Выезд",
      o.address || "",
      (o.options || []).map(opt => `${opt}×${o.deviceQuantities?.[opt] || 1}`).join(", "),
      o.adminComment || ""
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, "Pending");
  const filePath = path.join(os.tmpdir(), `report_pending_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

function checkOrderReminders() {
  const t = Date.now();
  for (const [, order] of orders.entries()) {
    if (order.status !== "ACCEPTED_BY_MASTER") continue;
    if (!order.appointedDate) continue;
    const est = new Date(order.appointedDate).getTime();
    if (t < est) continue;

    if (!order.remindersSent) order.remindersSent = [];
    const diffMs = t - est;
    const diffMin = Math.floor(diffMs / 60000);

    let reminder = 0;
    if (diffMin >= 120) reminder = 120;
    else if (diffMin >= 60) reminder = 60;
    else if (diffMin >= 30) reminder = 30;

    if (reminder === 0 || order.remindersSent.includes(reminder)) continue;
    order.remindersSent.push(reminder);
    saveData();

    const timeStr = reminder >= 60 ? `${reminder / 60} ч` : `${reminder} мин`;
    const adminId = order.adminChatId || SUPER_ADMIN_ID;
    const estNote = `\n(Назначено на: ${formatDate(new Date(order.appointedDate))})`;

    safeSend(order.masterTgId, `⏰ <b>Напоминание:</b> вы должны были начать заявку #${order.id} ${timeStr} назад!${estNote}\nПожалуйста, нажмите «📍 Я на месте»!`, { parse_mode: "HTML" });
    safeSend(adminId, `⏰ Напоминание #${reminder}: заявка #${order.id} не закрыта!\n👷 Мастер: ${order.masterName}\n📊 Статус: ${statusLabel(order.status)}\n📞 Клиент: ${order.phone}\n⏱ Прошло: ${timeStr} с момента принятия${estNote}`);

    if (String(adminId) !== String(SUPER_ADMIN_ID)) {
      safeSend(SUPER_ADMIN_ID, `⏰ Напоминание #${reminder}: заявка #${order.id} не закрыта!\n👷 Мастер: ${order.masterName}\n📊 Статус: ${statusLabel(order.status)}\n📞 Клиент: ${order.phone}\n⏱ Прошло: ${timeStr} с момента принятия${estNote}`);
    }

  }
}
setInterval(checkOrderReminders, 5 * 60 * 1000);

// =============================
// Start server
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server started on port ${PORT}`);
  try {
    await tg("setMyCommands", { commands: [{ command: "start", description: "Меню" }] });
    await tg("setWebhook", { url: process.env.WEBHOOK_URL });
    console.log(`✅ Webhook is set`);
  } catch (e) {
    console.error("❌ Startup error:", e?.message || e);
  }
});