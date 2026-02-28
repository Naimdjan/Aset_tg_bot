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
// ENV
// =============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN not found in environment variables");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// =============================
// Auth & state
// =============================
const authorizedChatIds = new Set(); // chatId строкой
const authorizedRoles = new Map(); // chatId -> "MASTER"|"ADMIN"
let userProfiles = {}; // chatId -> { name, city, role, username }
let auditLog = []; // события аудита (24 месяца)
const seenMasters = new Set();
const pendingApprovalInfo = new Map();

// Роли: супер-админ и админ
const SUPER_ADMIN_ID = 7862998301;
const ADMIN_CHAT_ID = 1987607156;

function isAllowedWithoutApproval(chatId) {
  return (
    String(chatId) === String(SUPER_ADMIN_ID) ||
    String(chatId) === String(ADMIN_CHAT_ID) ||
    isMasterChat(chatId)
  );
}
function isAuthorized(chatId) {
  return isAllowedWithoutApproval(chatId) || authorizedChatIds.has(String(chatId));
}

const MASTERS = [
  { tgId: 8095234574, name: "Иброхимчон", city: "Худжанд" },
  { tgId: 1039628701, name: "Акаи Шухрат", city: "Бохтар" },
  { tgId: 8026685490, name: "Тест", city: "Ашт" },
  { tgId: 1099184597, name: "Абдухалим", city: "Душанбе" },
];
const authorizedMasterCity = new Map();
const activeMasterIds = new Set();
const inactiveMasterIds = new Set();
const dynamicMasters = new Map();
MASTERS.forEach((m) => activeMasterIds.add(String(m.tgId)));

// In-memory storage
let lastOrderId = 0;
const orders = new Map();
const userState = new Map();
const dedupe = new Map();

// =============================
// Persistence
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
      auditLog,
      activeMasterIds: [...activeMasterIds],
      inactiveMasterIds: [...inactiveMasterIds],
      authorizedMasterCity: Object.fromEntries(authorizedMasterCity),
      dynamicMasters: Object.fromEntries(dynamicMasters),
      lastOrderId,
      orders: [...orders.entries()],
    };
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(j, null, 2), "utf8");
  } catch (e) {
    console.error("saveData error:", e?.message || e, e);
  }
}

// -----------------------------
// TIME helpers
// -----------------------------
function nowTjIso() {
  const tz = "Asia/Dushanbe";
  const d = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(d)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}+05:00`;
}
function nowTjDate() {
  return new Date();
}

function parseAnyTsToMs(ts) {
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
}

// =============================
// Audit log (24 months)
// =============================
function pruneAuditLog() {
  const now = Date.now();
  const maxAge = 24 * 30.4375 * 24 * 60 * 60 * 1000; // ~24 months
  auditLog = (auditLog || []).filter((e) => {
    const ms = parseAnyTsToMs(e?.ts);
    if (ms == null) return true;
    return now - ms <= maxAge;
  });
}

function logEvent(typeOrEv, details) {
  let entry;
  if (typeof typeOrEv === "string") {
    const d = details || {};
    entry = { ts: nowTjIso(), action: typeOrEv, actorId: d.actorId ?? null, targetId: d.targetId ?? null, meta: d.meta ?? null };
  } else {
    const ev = typeOrEv;
    entry = { ts: nowTjIso(), actorId: ev.actorId ?? null, action: ev.action, targetId: ev.targetId ?? null, meta: ev.meta ?? null };
  }

  try {
    const actorId = entry.actorId;
    const metaUser = entry?.meta?.user || null;
    const prof = actorId && typeof userProfiles === "object" ? userProfiles[String(actorId)] : null;
    entry.actorUsername = metaUser?.username || prof?.username || null;
    entry.actorName = metaUser?.name || metaUser?.fullName || prof?.name || null;
    entry.actorCity = prof?.city || null;
    entry.actorRole = prof?.role || authorizedRoles.get(String(actorId)) || null;
  } catch (e) {}

  auditLog.push(entry);
  pruneAuditLog();
  saveData();
}

setInterval(() => {
  try {
    pruneAuditLog();
    saveData();
  } catch (e) {}
}, 6 * 60 * 60 * 1000);

loadData();

// =============================
// Options
// =============================
const OPTIONS_DEVICES = ["FMB920", "FMB125", "FMB140", "DUT"];
const OPTIONS_ACCESSORIES = ["Реле", "Temp."];
const OPTIONS_OTHER = ["Video", "Другое"];
const OPTIONS = [...OPTIONS_DEVICES, ...OPTIONS_ACCESSORIES, ...OPTIONS_OTHER];
const ACCESSORIES = new Set(OPTIONS_ACCESSORIES);
const REPORT_KIND_COLUMNS = [...OPTIONS_DEVICES, ...OPTIONS_ACCESSORIES, ...OPTIONS_OTHER];

function cleanupDedupe() {
  const ttl = 60 * 1000;
  const t = Date.now();
  for (const [k, v] of dedupe.entries()) {
    if (t - v > ttl) dedupe.delete(k);
  }
}

// =============================
// Orders cleanup
// =============================
function cleanupOldOrders() {
  const maxAge = 365 * 24 * 60 * 60 * 1000;
  const t = Date.now();
  for (const [id, order] of orders.entries()) {
    const terminal = ["CLOSED", "DECLINED_BY_MASTER"].includes(order.status);
    const ts = order.closedAt || order.completedAt || order.createdAt;
    const tsMs = parseAnyTsToMs(ts);
    if (terminal && tsMs != null && t - tsMs > maxAge) {
      orders.delete(id);
    }
  }
}
setInterval(cleanupOldOrders, 60 * 60 * 1000);

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
// Telegram helpers (with auditing of outgoing)
// =============================
async function tg(method, payload) {
  return axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 20000 });
}

async function sendMessage(chatId, text, extra = {}) {
  const res = await tg("sendMessage", { chat_id: chatId, text, ...extra });
  logEvent({ actorId: null, action: "send_message", targetId: chatId, meta: { textPreview: String(text || "").slice(0, 200) } });
  return res;
}
async function editMessage(chatId, messageId, text, extra = {}) {
  const res = await tg("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
  logEvent({ actorId: null, action: "edit_message", targetId: chatId, meta: { messageId, textPreview: String(text || "").slice(0, 200) } });
  return res;
}
async function answerCb(callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }
  return tg("answerCallbackQuery", payload).catch(() => {});
}
async function sendPhoto(chatId, fileId, caption) {
  const res = await tg("sendPhoto", { chat_id: chatId, photo: fileId, caption });
  logEvent({ actorId: null, action: "send_photo", targetId: chatId, meta: { captionPreview: String(caption || "").slice(0, 200) } });
  return res;
}
async function safeSend(chatId, text, extra = {}) {
  return sendMessage(chatId, text, extra).catch((e) => console.warn(`safeSend to ${chatId} failed: ${e?.message || e}`));
}

async function forwardChatMessage(message, toChatId, fromLabel) {
  const cap = (extra) => (extra ? `${fromLabel}:\n${extra}` : fromLabel);
  const kind =
    message.text
      ? "text"
      : message.photo?.length
      ? "photo"
      : message.document
      ? "document"
      : message.video
      ? "video"
      : message.voice
      ? "voice"
      : message.audio
      ? "audio"
      : message.video_note
      ? "video_note"
      : message.sticker
      ? "sticker"
      : message.contact
      ? "contact"
      : message.location
      ? "location"
      : "unknown";

  logEvent({ actorId: message.chat?.id || null, action: "forward", targetId: toChatId, meta: { fromLabel, kind, preview: (message.text || message.caption || "").slice(0, 200) } });

  if (message.text) {
    await safeSend(toChatId, `${fromLabel}:\n${message.text}`);
  } else if (message.photo?.length) {
    await tg("sendPhoto", { chat_id: toChatId, photo: message.photo[message.photo.length - 1].file_id, caption: cap(message.caption) }).catch(() => {});
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
    await safeSend(toChatId, `${fromLabel}: 📱 Контакт`);
    await tg("sendContact", { chat_id: toChatId, phone_number: message.contact.phone_number, first_name: message.contact.first_name || "", last_name: message.contact.last_name || "" }).catch(() => {});
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
  const res = await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
    headers: form.getHeaders(),
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  logEvent({ actorId: null, action: "send_document", targetId: chatId, meta: { captionPreview: String(caption || "").slice(0, 200), file: path.basename(filePath) } });
  return res;
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
    rows.push([{ text: "📒 Журнал (Excel)" }, { text: "🔁 Роли" }]);
    rows.push([{ text: "➕ Добавить юзера (ID)" }]);
  }
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false, selective: false };
}

function masterMenuReplyKeyboard() {
  return {
    keyboard: [[{ text: "📊 Мой отчёт" }, { text: "💬 Написать админу" }], [{ text: "❌ Отмена" }]],
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
  const cid = String(chatId);
  if (activeMasterIds.has(cid)) return masterMenuReplyKeyboard();
  if (cid === String(SUPER_ADMIN_ID) || cid === String(ADMIN_CHAT_ID)) return adminMenuReplyKeyboard(chatId);
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

function logisticsKeyboard() {
  return { inline_keyboard: [[{ text: "🚗 Выезд", callback_data: "ADMIN_LOG:VISIT" }, { text: "🏢 Сам приедет", callback_data: "ADMIN_LOG:COME" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] };
}

function reportPeriodKeyboard() {
  return { inline_keyboard: [[{ text: "📆 Сегодня", callback_data: "REPORT_PERIOD:TODAY" }, { text: "📆 Вчера", callback_data: "REPORT_PERIOD:YESTERDAY" }], [{ text: "🗓 Этот месяц", callback_data: "REPORT_PERIOD:THIS_MONTH" }, { text: "🗓 Прошлый месяц", callback_data: "REPORT_PERIOD:LAST_MONTH" }], [{ text: "📅 7 дней", callback_data: "REPORT_PERIOD:LAST_7" }, { text: "📅 Свой период", callback_data: "REPORT_PERIOD:PERIOD" }], [{ text: "⏳ Ожидающие заявки", callback_data: "REPORT_PERIOD:PENDING" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] };
}

function reportCalendarKeyboard(mode, yyyymm) {
  const prefix = mode === "START" ? "RP_START" : "RP_END";
  const parsed = parseYyyymm(yyyymm);
  const now = nowTjDate();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const jsDow = new Date(year, month - 1, 1).getDay();
  const dow = (jsDow + 6) % 7;
  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const rows = [];
  rows.push([
    { text: "‹", callback_data: `${prefix}_MN:${formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1)}` },
    { text: monthLabelShort(year, month), callback_data: "NOOP" },
    { text: "›", callback_data: `${prefix}_MN:${formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1)}` },
  ]);
  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if ((week === 0 && i < dow) || day > daysInMonth) {
        row.push({ text: "·", callback_data: "NOOP" });
        continue;
      }
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

function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatYyyymm(y, m) {
  return `${y}${pad2(m)}`;
}
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
function monthLabelShort(y, mo) {
  return `${MONTH_SHORT[mo - 1]} ${y}`;
}

function isPastDay(y, m, d) {
  const now = nowTjDate();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayTs = new Date(y, m - 1, d).getTime();
  return dayTs < today;
}

function masterCalendarKeyboard(orderId, yyyymm) {
  const parsed = parseYyyymm(yyyymm);
  const now = nowTjDate();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dow = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const rows = [];
  rows.push([
    { text: "‹", callback_data: `MN:${orderId}:${formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1)}` },
    { text: monthLabelShort(year, month), callback_data: "NOOP" },
    { text: "›", callback_data: `MN:${orderId}:${formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1)}` },
  ]);
  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if ((week === 0 && i < dow) || day > daysInMonth) {
        row.push({ text: "·", callback_data: "NOOP" });
        continue;
      }
      const disabled = isPastDay(year, month, day);
      row.push({ text: String(day), callback_data: disabled ? "NOOP" : `MD:${orderId}:${year}${pad2(month)}${pad2(day)}` });
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
  const now = nowTjDate();
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const isToday = y === now.getFullYear() && m === now.getMonth() && d === now.getDate();
  const currentHour = now.getHours();
  for (let i = 0; i < hours.length; i += 4) {
    rows.push(
      hours.slice(i, i + 4).map((h) => {
        const disabled = isToday && h <= currentHour;
        return { text: `${pad2(h)}:00`, callback_data: disabled ? "NOOP" : `MH:${orderId}:${yyyymmdd}:${pad2(h)}` };
      })
    );
  }
  rows.push([{ text: "⬅ Дата", callback_data: `MB:${orderId}:${yyyymmdd.slice(0, 6)}` }]);
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function adminProposeCalendarKeyboard(orderId, yyyymm) {
  const parsed = parseYyyymm(yyyymm);
  const now = nowTjDate();
  const year = parsed?.y || now.getFullYear();
  const month = parsed?.mo || now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dow = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const rows = [];
  rows.push([
    { text: "‹", callback_data: `APROP_MN:${orderId}:${formatYyyymm(prevMonth.getFullYear(), prevMonth.getMonth() + 1)}` },
    { text: monthLabelShort(year, month), callback_data: "NOOP" },
    { text: "›", callback_data: `APROP_MN:${orderId}:${formatYyyymm(nextMonth.getFullYear(), nextMonth.getMonth() + 1)}` },
  ]);
  let day = 1;
  for (let week = 0; week < 6; week++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      if ((week === 0 && i < dow) || day > daysInMonth) {
        row.push({ text: "·", callback_data: "NOOP" });
        continue;
      }
      const disabled = isPastDay(year, month, day);
      row.push({ text: String(day), callback_data: disabled ? "NOOP" : `APROP_MD:${orderId}:${year}${pad2(month)}${pad2(day)}` });
      day++;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }
  rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);
  return { inline_keyboard: rows };
}

function adminProposeHourKeyboard(orderId, yyyymmdd) {
  const hours = [];
  for (let h = 5; h <= 24; h++) hours.push(h);
  const rows = [];
  const now = nowTjDate();
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const isToday = y === now.getFullYear() && m === now.getMonth() && d === now.getDate();
  const currentHour = now.getHours();
  for (let i = 0; i < hours.length; i += 4) {
    rows.push(
      hours.slice(i, i + 4).map((h) => {
        const disabled = isToday && h <= currentHour;
        return { text: `${pad2(h)}:00`, callback_data: disabled ? "NOOP" : `APROP_MH:${orderId}:${yyyymmdd}:${pad2(h)}` };
      })
    );
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
      [1, 2, 3, 4, 5].map((n) => ({ text: String(n), callback_data: `ADMIN_QTY:${orderId}:${n}` })),
      [6, 7, 8, 9, 10].map((n) => ({ text: String(n), callback_data: `ADMIN_QTY:${orderId}:${n}` })),
      [{ text: "✏️ Больше...", callback_data: `ADMIN_QTY_CUSTOM:${orderId}` }],
      [{ text: "❌ Отмена", callback_data: "CANCEL" }],
    ],
  };
}

function installTimeKeyboard(orderId) {
  return {
    inline_keyboard: [
      [1, 2, 3, 4].map((h) => ({ text: `${h} ч`, callback_data: `INST_TIME:${orderId}:${h}` })),
      [5, 6, 8, 10].map((h) => ({ text: `${h} ч`, callback_data: `INST_TIME:${orderId}:${h}` })),
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

      logEvent({
        actorId: msg.chat?.id,
        action: "message",
        targetId: null,
        meta: {
          type: msgType,
          preview: (msg.text || msg.caption || "").slice(0, 200),
          user: {
            id: msg.from?.id,
            username: msg.from?.username || null,
            fullName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || null,
          },
        },
      });

      await onMessage(update.message);
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      logEvent({
        actorId: cq.from?.id,
        action: "callback",
        targetId: null,
        meta: {
          data: (cq.data || "").slice(0, 200),
          user: {
            id: cq.from?.id,
            username: cq.from?.username || null,
            fullName: [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(" ") || null,
          },
        },
      });
      await onCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Webhook error:", e?.message || e);
    logEvent({ actorId: null, action: "webhook_error", targetId: null, meta: { message: e?.message || String(e) } });
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
    saveData();
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
    const approveKb = {
      inline_keyboard: [
        [
          { text: "✅ Approve MASTER", callback_data: `APPROVE_MASTER:${chatId}` },
          { text: "✅ Approve ADMIN", callback_data: `APPROVE_ADMIN:${chatId}` },
        ],
        [{ text: "❌ Decline", callback_data: `DECLINE:${chatId}` }],
      ],
    };
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

  if (text === "➕ Добавить юзера (ID)" && String(chatId) === String(SUPER_ADMIN_ID)) {
    setState(chatId, "ADD_USER_ID", {});
    await sendMessage(chatId, "Введите Telegram ID пользователя (цифрами):", { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  if (text === "📒 Журнал (Excel)" && String(chatId) === String(SUPER_ADMIN_ID)) {
    await sendAuditExcel(chatId);
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

  if (text === "🧑‍💼💬 Чат с супер-админом" || text === "🧑‍💼💬 Чат с админом") {
    if (!ADMIN_CHAT_ID || !SUPER_ADMIN_ID) {
      await sendMessage(chatId, "⚠️ Не настроены ADMIN_CHAT_ID / SUPER_ADMIN_ID.");
      return;
    }
    const peerId = String(chatId) === String(SUPER_ADMIN_ID) ? String(ADMIN_CHAT_ID) : String(SUPER_ADMIN_ID);
    setState(chatId, "ADMIN_SUPER_CHAT", { peerId });
    await sendMessage(chatId, `✅ Режим чата включён.\nЧтобы выйти — отправьте: ❌ Отмена`);
    return;
  }

  if (text === "💬 Написать админу" || text === "💬 Продолжить чат" || text === "💬 Чат с мастером") {
    if (isMasterChat(chatId)) {
      setState(chatId, "MASTER_CHAT_WITH_ADMIN", {});
      await sendMessage(chatId, "💬 Чат с админом. Напишите сообщение. Для выхода нажмите «❌ Отмена».", { reply_markup: masterMenuReplyKeyboard() });
      return;
    }
    if (String(chatId) !== String(ADMIN_CHAT_ID) && String(chatId) !== String(SUPER_ADMIN_ID)) {
      await sendMessage(chatId, "⚠️ У вас нет прав для общения с мастерами.", { reply_markup: menuKeyboardForChat(chatId) });
      return;
    }
    setState(chatId, "ADMIN_CHAT_PICK_MASTER", {});
    await sendMessage(chatId, "💬 Выберите мастера:", { reply_markup: mastersChatKeyboard() });
    return;
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

  if (text === "🔁 Роли" && String(chatId) === String(SUPER_ADMIN_ID)) {
    const allIds = new Set([...authorizedChatIds, ...activeMasterIds, ...Object.keys(userProfiles)]);
    if (ADMIN_CHAT_ID) allIds.add(String(ADMIN_CHAT_ID));

    const rows = [...allIds].slice(0, 50).map((cid) => {
      const p = userProfiles[cid];
      let role = authorizedRoles.get(cid);
      if (!role) {
        if (activeMasterIds.has(cid)) role = "MASTER";
        else if (String(cid) === String(ADMIN_CHAT_ID)) role = "ADMIN";
        else role = "БЕЗ РОЛИ";
      }
      const nameLabel = p?.name ? p.name : p?.username ? `@${p.username}` : cid;
      return [{ text: `${nameLabel} (${role})`, callback_data: `ROLE_EDIT:${cid}` }];
    });

    if (rows.length === 0) rows.push([{ text: "Пользователей пока нет", callback_data: "NOOP" }]);
    rows.push([{ text: "❌ Отмена", callback_data: "CANCEL" }]);

    await sendMessage(chatId, "🔁 Смена ролей. Выберите пользователя:", { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (text === "👷 Мастера") {
    await sendMessage(chatId, "👷 Мастера:", { reply_markup: { inline_keyboard: [[{ text: "✅ Активные", callback_data: "MLIST:ACTIVE" }, { text: "🗃 Неактивные", callback_data: "MLIST:INACTIVE" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] } });
    return;
  }

  const st = getState(chatId);
  if (!st) {
    await sendMessage(chatId, "Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
    return;
  }

  if (String(chatId) === String(SUPER_ADMIN_ID) && st.step === "ADD_USER_ID") {
    const tid = text.replace(/\D/g, "");
    if (!tid || tid.length < 6 || tid.length > 15) {
      await sendMessage(chatId, "Введите корректный Telegram ID (только цифры):");
      return;
    }
    st.data.targetId = tid;
    st.step = "ADD_USER_ROLE";
    const kb = {
      inline_keyboard: [
        [
          { text: "✅ Назначить MASTER", callback_data: `ADDUSR_ROLE:${tid}:MASTER` },
          { text: "✅ Назначить ADMIN", callback_data: `ADDUSR_ROLE:${tid}:ADMIN` },
        ],
        [{ text: "❌ Отмена", callback_data: "CANCEL" }],
      ],
    };
    await sendMessage(chatId, `ID ${tid}. Выберите роль:`, { reply_markup: kb });
    return;
  }

  if (String(chatId) === String(SUPER_ADMIN_ID) && st.step === "ADDUSR_NAME") {
    const name = text.trim();
    if (!name || name.length > 80) {
      await sendMessage(chatId, "Имя от 1 до 80 символов. Введите снова:");
      return;
    }
    st.data.name = name;
    st.step = "ADDUSR_CITY";
    await sendMessage(chatId, "🏙 Введите город:", { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  if (String(chatId) === String(SUPER_ADMIN_ID) && st.step === "ADDUSR_CITY") {
    const city = text.trim();
    if (city.length < 2 || city.length > 40) {
      await sendMessage(chatId, "Город должен быть от 2 до 40 символов. Введите снова:");
      return;
    }
    const { targetId, role, name } = st.data;
    const sid = String(targetId);

    authorizedChatIds.add(sid);
    authorizedRoles.set(sid, role);
    if (!userProfiles[sid]) userProfiles[sid] = {};
    userProfiles[sid] = { ...userProfiles[sid], name, city, role, username: userProfiles[sid].username ?? null };

    if (role === "MASTER") {
      authorizedMasterCity.set(sid, city);
      activeMasterIds.add(sid);
      inactiveMasterIds.delete(sid);
      dynamicMasters.set(sid, { name, city });
    } else {
      activeMasterIds.delete(sid);
      inactiveMasterIds.delete(sid);
      authorizedMasterCity.delete(sid);
      dynamicMasters.delete(sid);
    }

    saveData();
    logEvent({ actorId: chatId, action: "user_add_by_id", targetId: sid, meta: { role, name, city } });
    clearState(chatId);

    await sendMessage(chatId, `✅ Добавлено: ${name} (${role}) · ${city} · ID ${sid}`, { reply_markup: adminMenuReplyKeyboard(chatId) });
    safeSend(sid, `✅ Вам выдан доступ. Роль: ${role}. Город: ${city}.`, { reply_markup: role === "MASTER" ? masterMenuReplyKeyboard() : adminMenuReplyKeyboard(sid) });
    return;
  }

  if (st.step === "ADMIN_CHAT_WITH_MASTER") {
    const masterTgId = st.data.masterTgId;
    const masterName = getMasterInfo(masterTgId).name;
    const hasContent =
      text ||
      message.photo ||
      message.document ||
      message.video ||
      message.voice ||
      message.audio ||
      message.video_note ||
      message.sticker ||
      message.contact ||
      message.location;
    if (hasContent) {
      await forwardChatMessage(message, masterTgId, "💬 Сообщение от админа");
      if (String(chatId) === String(ADMIN_CHAT_ID)) await forwardChatMessage(message, SUPER_ADMIN_ID, `📡 Чат админа с мастером ${masterName}`);
      await sendMessage(chatId, `✅ Отправлено ${masterName}.`, { reply_markup: adminMenuReplyKeyboard(chatId) });
    }
    return;
  }

  if (st.step === "MASTER_CHAT_WITH_ADMIN") {
    if (!activeMasterIds.has(String(chatId))) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Ваш аккаунт деактивирован. Чат недоступен.", { reply_markup: menuKeyboardForChat(chatId) });
      return;
    }
    const masterName = getMasterInfo(chatId).name;
    const hasContent =
      text ||
      message.photo ||
      message.document ||
      message.video ||
      message.voice ||
      message.audio ||
      message.video_note ||
      message.sticker ||
      message.contact ||
      message.location;
    if (hasContent) {
      await forwardChatMessage(message, ADMIN_CHAT_ID, `💬 Мастер ${masterName}`);
      if (String(SUPER_ADMIN_ID) !== String(ADMIN_CHAT_ID)) await forwardChatMessage(message, SUPER_ADMIN_ID, `📡 Мастер ${masterName} → админу`);
      await sendMessage(chatId, "✅ Отправлено админу.", { reply_markup: masterMenuReplyKeyboard() });
    }
    return;
  }

  if (st.step === "ADMIN_SUPER_CHAT") {
    const peerId = st.data.peerId;
    const hasContent =
      text ||
      message.photo ||
      message.document ||
      message.video ||
      message.voice ||
      message.audio ||
      message.video_note ||
      message.sticker ||
      message.contact ||
      message.location;
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
    const orderId = String(st.data.orderId);
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
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
    const order = orders.get(String(orderId));
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) });
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
      await sendMessage(chatId, `✅ ${deviceName}: ${qty} шт.\n\n🔢 Сколько ${order.options[nextIdx]}?`, { reply_markup: qtyKeyboard(orderId) });
      return;
    }
    order.deviceQuantities = { ...quantities };
    order.totalDevices = Object.values(quantities).reduce((a, b) => a + b, 0);
    const qtyText = order.options.map((o) => `${o} × ${quantities[o]}`).join(", ");
    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId });
    await sendMessage(chatId, `✅ Устройства: ${qtyText}\n\n✍️ Напишите комментарий:`, { reply_markup: adminCommentKeyboard(orderId) });
    return;
  }

  if (st.step === "ADMIN_WAIT_COMMENT") {
    const orderId = String(st.data.orderId);
    const order = orders.get(orderId);
    if (!order) {
      clearState(chatId);
      await sendMessage(chatId, "⚠️ Заявка не найдена.", { reply_markup: adminMenuReplyKeyboard(chatId) });
      return;
    }
    order.adminComment = text;
    order.status = "SENT_TO_MASTER";
    logEvent({ actorId: chatId, action: "order_status_change", targetId: order.id, meta: { status: order.status } });
    clearState(chatId);
    await sendOrderToMaster(order);
    await sendMessage(chatId, formatAdminConfirm(order), { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  clearState(chatId);
  await sendMessage(chatId, "⚠️ Сессия сброшена. Выберите действие:", { reply_markup: menuKeyboardForChat(chatId) });
}

async function onCallback(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data;

  if (data === "NOOP") {
    await answerCb(callbackQuery.id);
    return;
  }
  if (data === "CANCEL") {
    clearState(chatId);
    await answerCb(callbackQuery.id, "Отменено");
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    await sendMessage(chatId, "❌ Действие отменено.", { reply_markup: menuKeyboardForChat(chatId) });
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

  if (data.startsWith("ADDUSR_ROLE:")) {
    if (String(chatId) !== String(SUPER_ADMIN_ID)) {
      await answerCb(callbackQuery.id, "Нет доступа", true);
      return;
    }
    const [, tid, role] = data.split(":");
    setState(chatId, "ADDUSR_NAME", { targetId: tid, role });
    await answerCb(callbackQuery.id);
    await editMessage(chatId, messageId, `Роль ${role} для ID ${tid}.\nВведите имя:`);
    return;
  }

  if (data.startsWith("ROLE_EDIT:")) {
    const cid = data.split(":")[1];
    const p = userProfiles[cid];
    let role = authorizedRoles.get(cid) || "БЕЗ РОЛИ";
    if (activeMasterIds.has(cid)) role = "MASTER";
    const nameStr = p?.name ? p.name : p?.username ? `@${p.username}` : cid;
    const kb = {
      inline_keyboard: [
        [{ text: "👑 Set ADMIN", callback_data: `ROLE_SET:${cid}:ADMIN` }, { text: "👷 Set MASTER", callback_data: `ROLE_SET:${cid}:MASTER` }],
        [{ text: "🧨 Удалить НАВСЕГДА", callback_data: `ROLE_DELETE_FOREVER:${cid}` }],
        [{ text: "❌ Отмена", callback_data: "CANCEL" }],
      ],
    };
    await editMessage(chatId, messageId, `Управление: ${nameStr}\nТекущая роль: ${role}`, { reply_markup: kb });
    return;
  }

  if (data.startsWith("ROLE_DELETE_FOREVER:")) {
    if (String(chatId) !== String(SUPER_ADMIN_ID)) {
      await answerCb(callbackQuery.id, "Нет доступа", true);
      return;
    }
    const cid = data.split(":")[1];
    if (String(cid) === String(SUPER_ADMIN_ID)) {
      await answerCb(callbackQuery.id, "Нельзя удалить супер-админа", true);
      return;
    }
    authorizedChatIds.delete(cid);
    authorizedRoles.delete(cid);
    activeMasterIds.delete(cid);
    inactiveMasterIds.delete(cid);
    dynamicMasters.delete(cid);
    authorizedMasterCity.delete(cid);
    userState.delete(cid);
    delete userProfiles[cid];
    saveData();
    logEvent({ actorId: chatId, action: "user_delete_forever", targetId: cid });

    await answerCb(callbackQuery.id, "Удалено");
    await editMessage(chatId, messageId, `🧨 Пользователь ${cid} удалён НАВСЕГДА. Логи сохранены.`);
    await safeSend(cid, "⛔ Ваш доступ к системе удалён.", { reply_markup: { remove_keyboard: true } });
    return;
  }

  if (data.startsWith("MLIST:")) {
    const type = data.split(":")[1];
    const isAct = type === "ACTIVE";
    const list = isAct ? activeMasterIds : inactiveMasterIds;
    if (list.size === 0) {
      await answerCb(callbackQuery.id, "Список пуст", true);
      return;
    }
    const rows = [...list].map((tid) => [{ text: getMasterLabel(tid), callback_data: `M_EDIT:${tid}` }]);
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
      inline_keyboard: [[act ? { text: "⛔ Деактивировать", callback_data: `M_DEACT:${tid}` } : { text: "✅ Активировать", callback_data: `M_ACT:${tid}` }], [{ text: "⬅ Назад", callback_data: "MLIST_BACK" }]],
    };
    await editMessage(chatId, messageId, `Управление мастером: ${getMasterLabel(tid)}`, { reply_markup: kb });
    return;
  }

  if (data.startsWith("M_DEACT:")) {
    const tid = data.split(":")[1];
    activeMasterIds.delete(tid);
    inactiveMasterIds.add(tid);
    userState.delete(tid);
    saveData();
    logEvent({ actorId: chatId, action: "master_deactivate", targetId: tid });
    await answerCb(callbackQuery.id, "Мастер деактивирован");
    await editMessage(chatId, messageId, `⛔ Мастер ${getMasterLabel(tid)} деактивирован.`);
    return;
  }

  if (data.startsWith("M_ACT:")) {
    const tid = data.split(":")[1];
    inactiveMasterIds.delete(tid);
    activeMasterIds.add(tid);
    saveData();
    logEvent({ actorId: chatId, action: "master_activate", targetId: tid });
    await answerCb(callbackQuery.id, "Мастер активирован");
    await editMessage(chatId, messageId, `✅ Мастер ${getMasterLabel(tid)} активирован.`);
    return;
  }

  if (data.startsWith("REPORT_PERIOD:")) {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_WAIT_PERIOD") {
      await answerCb(callbackQuery.id, "Устарело", true);
      return;
    }
    const p = data.split(":")[1];

    if (p === "PERIOD") {
      st.data.reportPeriod = "PERIOD";
      st.step = "REPORT_WAIT_START_DATE";
      const now = nowTjDate();
      await editMessage(chatId, messageId, "Свой период. Выберите дату НАЧАЛА:", { reply_markup: reportCalendarKeyboard("START", formatYyyymm(now.getFullYear(), now.getMonth() + 1)) });
      return;
    }

    if (p === "PENDING") {
      st.data.reportPeriod = "PENDING";
      st.data.pending = true;
    } else {
      st.data.reportPeriod = p;
      const now = nowTjDate();
      let fromTs, toTs;
      if (p === "TODAY") {
        fromTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        toTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
      } else if (p === "YESTERDAY") {
        const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        fromTs = y.getTime();
        toTs = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999).getTime();
      } else if (p === "THIS_MONTH") {
        fromTs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        toTs = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
      } else if (p === "LAST_MONTH") {
        fromTs = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        toTs = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).getTime();
      } else if (p === "LAST_7") {
        fromTs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
        toTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
      }
      st.data.fromTs = fromTs;
      st.data.toTs = toTs;
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
    if (!st || st.step !== "REPORT_WAIT_START_DATE") {
      await answerCb(callbackQuery.id, "Устарело", true);
      return;
    }
    const parsed = parseYyyymmdd(data.split(":")[1]);
    st.data.fromTs = new Date(parsed.y, parsed.mo - 1, parsed.d).getTime();
    st.step = "REPORT_WAIT_END_DATE";
    const now = nowTjDate();
    await editMessage(chatId, messageId, "Свой период. Выберите дату ОКОНЧАНИЯ:", { reply_markup: reportCalendarKeyboard("END", formatYyyymm(now.getFullYear(), now.getMonth() + 1)) });
    return;
  }

  if (data.startsWith("RP_END_MD:")) {
    const st = getState(chatId);
    if (!st || st.step !== "REPORT_WAIT_END_DATE") {
      await answerCb(callbackQuery.id, "Устарело", true);
      return;
    }
    const parsed = parseYyyymmdd(data.split(":")[1]);
    st.data.toTs = new Date(parsed.y, parsed.mo - 1, parsed.d, 23, 59, 59, 999).getTime();
    if (st.data.fromTs > st.data.toTs) {
      const t = st.data.fromTs;
      st.data.fromTs = st.data.toTs;
      st.data.toTs = t;
    }
    st.step = "REPORT_READY";
    await editMessage(chatId, messageId, "✅ Выбран период.\nВ каком виде выгрузить?", { reply_markup: { inline_keyboard: [[{ text: "В сообщении (текст)", callback_data: "REPORT_TEXT" }, { text: "Файл Excel (.xlsx)", callback_data: "REPORT_EXCEL" }], [{ text: "❌ Отмена", callback_data: "CANCEL" }]] } });
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

    if (data === "REPORT_TEXT") {
      await sendTextReport(chatId, st.data);
    } else {
      let filePath;
      try {
        if (st.data.pending) {
          filePath = buildExcelReportPending({ masterTgId: st.data.masterTgId });
          await sendDocument(chatId, filePath, "📋 Ожидающие заявки");
        } else {
          const fromD = new Date(st.data.fromTs);
          const toD = new Date(st.data.toTs);
          filePath = buildExcelReport(fromD, toD, { masterTgId: st.data.masterTgId });
          await sendDocument(chatId, filePath, `📊 Отчёт ${formatDate(fromD)}–${formatDate(toD)}`);
        }
      } catch (err) {
        console.error("Excel report error:", err);
        logEvent({ actorId: null, action: "excel_report_error", targetId: chatId, meta: { message: err?.message || String(err) } });
        await sendMessage(chatId, "⚠️ Не удалось сформировать Excel. Попробуйте позже.");
      } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
      }
    }

    clearState(chatId);
    return;
  }

  if (data.startsWith("ADMIN_PICK_MASTER:")) {
    const masterTgId = data.split(":")[1];
    const st = getState(chatId);
    if (!st) return;
    st.data.masterTgId = masterTgId;
    st.data.masterName = getMasterInfo(masterTgId).name;
    const isRepair = st.data.presetType === "REPAIR";
    st.data.type = isRepair ? "REPAIR" : "INSTALL";
    setState(chatId, "ADMIN_WAIT_LOGISTICS", st.data);
    await editMessage(chatId, messageId, `👷 Мастер: ${st.data.masterName}\n\nЛогистика:`, { reply_markup: logisticsKeyboard() });
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
    logEvent({ actorId: chatId, action: "order_create", targetId: lastOrderId });

    if (logistics === "COME") {
      newOrder.address = "Сам приедет";
      if (newOrder.type === "REPAIR") {
        setState(chatId, "ADMIN_WAIT_COMMENT", { orderId: String(lastOrderId) });
        await editMessage(chatId, messageId, "🧰 Ремонт\n🏢 Сам приедет\n\n✍️ Комментарий:", { reply_markup: adminCommentKeyboard(String(lastOrderId)) });
      } else {
        setState(chatId, "ADMIN_WAIT_OPTION", { orderId: String(lastOrderId) });
        await editMessage(chatId, messageId, "🛠 Монтаж\n🏢 Сам приедет\n\nУстройства:", { reply_markup: optionsKeyboard(String(lastOrderId)) });
      }
    } else {
      setState(chatId, "ADMIN_WAIT_ADDRESS", { orderId: String(lastOrderId) });
      await editMessage(chatId, messageId, "📍 Напишите адрес клиента:");
    }
    return;
  }

  if (data.startsWith("ADMIN_OPT:")) {
    const [, orderIdStr, optIdxStr] = data.split(":");
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_OPTION") return;
    const order = orders.get(String(orderIdStr));
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
    const order = orders.get(String(orderId));
    if (!order) return;
    if (!order.options || order.options.length === 0) {
      await answerCb(callbackQuery.id, "Выберите хотя бы одно устройство!", true);
      return;
    }
    setState(chatId, "ADMIN_WAIT_QTY", { orderId: String(orderId), qtyIdx: 0, quantities: {} });
    await editMessage(chatId, messageId, `🔢 Сколько ${order.options[0]}?`, { reply_markup: qtyKeyboard(orderId) });
    return;
  }

  if (data.startsWith("ADMIN_QTY:")) {
    const [, orderId, qtyStr] = data.split(":");
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_QTY") return;
    const order = orders.get(String(orderId));
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
    const qtyText = order.options.map((o) => `${o} × ${order.deviceQuantities[o]}`).join(", ");
    setState(chatId, "ADMIN_WAIT_COMMENT", { orderId: String(orderId) });
    await editMessage(chatId, messageId, `✅ Устройства: ${qtyText}\n\n✍️ Комментарий:`, { reply_markup: adminCommentKeyboard(orderId) });
    return;
  }

  if (data.startsWith("ADMIN_QTY_CUSTOM:")) {
    const orderId = data.split(":")[1];
    const st = getState(chatId);
    if (!st || st.step !== "ADMIN_WAIT_QTY") return;
    const order = orders.get(String(orderId));
    if (!order) return;
    setState(chatId, "ADMIN_WAIT_QTY_CUSTOM", st.data);
    const deviceName = order.options[st.data.qtyIdx];
    await editMessage(chatId, messageId, `Введите количество для ${deviceName} цифрами:`);
    return;
  }

  if (data.startsWith("ADMIN_SUBMIT_COMMENT:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (!order) return;
    order.adminComment = "—";
    order.status = "SENT_TO_MASTER";
    logEvent({ actorId: chatId, action: "order_status_change", targetId: order.id, meta: { status: order.status } });
    clearState(chatId);
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    await sendOrderToMaster(order);
    await sendMessage(chatId, formatAdminConfirm(order), { reply_markup: adminMenuReplyKeyboard(chatId) });
    return;
  }

  if (data.startsWith("MASTER_ACCEPT:")) {
    const [, orderIdStr, dType] = data.split(":");
    const order = orders.get(String(orderIdStr));
    if (!order) return;
    if (order.status !== "SENT_TO_MASTER" && order.status !== "PROPOSED_BY_ADMIN") {
      await answerCb(callbackQuery.id, "Заявка уже в другом статусе", true);
      return;
    }

    if (dType === "CAL") {
      const now = nowTjDate();
      await editMessage(chatId, messageId, `Заявка #${order.id}. Выберите месяц:`, { reply_markup: masterCalendarKeyboard(orderIdStr, formatYyyymm(now.getFullYear(), now.getMonth() + 1)) });
      return;
    }

    const today = nowTjDate();
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
    const parsed = parseYyyymmdd(yyyymmdd);
    if (parsed && isPastDay(parsed.y, parsed.mo, parsed.d)) {
      await answerCb(callbackQuery.id, "Нельзя выбрать прошедшую дату", true);
      return;
    }
    await editMessage(chatId, messageId, `Заявка #${orderIdStr}. Выберите время:`, { reply_markup: masterHourKeyboard(orderIdStr, yyyymmdd) });
    return;
  }

  if (data.startsWith("MB:")) {
    const [, orderIdStr, yyyymm] = data.split(":");
    await editMessage(chatId, messageId, `Заявка #${orderIdStr}. Выберите месяц:`, { reply_markup: masterCalendarKeyboard(orderIdStr, yyyymm) });
    return;
  }

  if (data.startsWith("ADMIN_PROPOSE_TIME:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (!order) return;
    const now = nowTjDate();
    await editMessage(chatId, messageId, `🗓 Предложить другое время для заявки #${orderId}\nВыберите дату:`, { reply_markup: adminProposeCalendarKeyboard(orderId, formatYyyymm(now.getFullYear(), now.getMonth() + 1)) });
    return;
  }

  if (data.startsWith("APROP_MN:")) {
    const [, orderId, yyyymm] = data.split(":");
    await editMessage(chatId, messageId, `🗓 Предложить другое время #${orderId}\nВыберите дату:`, { reply_markup: adminProposeCalendarKeyboard(orderId, yyyymm) });
    return;
  }

  if (data.startsWith("APROP_MD:")) {
    const [, orderId, yyyymmdd] = data.split(":");
    const parsed = parseYyyymmdd(yyyymmdd);
    if (parsed && isPastDay(parsed.y, parsed.mo, parsed.d)) {
      await answerCb(callbackQuery.id, "Нельзя выбрать прошедшую дату", true);
      return;
    }
    await editMessage(chatId, messageId, `🗓 Заявка #${orderId}. Выберите время:`, { reply_markup: adminProposeHourKeyboard(orderId, yyyymmdd) });
    return;
  }

  if (data.startsWith("APROP_MB:")) {
    const [, orderId, yyyymm] = data.split(":");
    await editMessage(chatId, messageId, `🗓 Заявка #${orderId}. Выберите месяц:`, { reply_markup: adminProposeCalendarKeyboard(orderId, yyyymm) });
    return;
  }

  if (data.startsWith("APROP_MH:")) {
    const [, orderIdStr, yyyymmdd, hh] = data.split(":");
    const order = orders.get(String(orderIdStr));
    if (!order) return;

    const y = parseInt(yyyymmdd.slice(0, 4), 10);
    const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
    const d = parseInt(yyyymmdd.slice(6, 8), 10);
    const selectedDate = new Date(y, m, d, parseInt(hh, 10), 0, 0);
    if (selectedDate.getTime() < nowTjDate().getTime()) {
      await answerCb(callbackQuery.id, "Нельзя выбрать прошедшее время", true);
      return;
    }

    order.proposedDate = selectedDate.toISOString();
    order.status = "PROPOSED_BY_ADMIN";
    saveData();
    logEvent({ actorId: chatId, action: "order_proposed_time", targetId: order.id, meta: { proposedDate: order.proposedDate } });

    await editMessage(chatId, messageId, `✅ Предложено другое время для заявки #${order.id}: ${formatDate(selectedDate)}\nОжидаем подтверждения мастера.`);

    const kb = { inline_keyboard: [[{ text: "✅ Принять время", callback_data: `MASTER_ACCEPT_PROPOSED:${order.id}` }, { text: "📅 Выбрать другое", callback_data: `MASTER_ACCEPT:${order.id}:CAL` }]] };
    await safeSend(order.masterTgId, `🕒 Админ предлагает другое время для заявки #${order.id}: ${formatDate(selectedDate)}\nПринять?`, { reply_markup: kb });
    return;
  }

  if (data.startsWith("MASTER_ACCEPT_PROPOSED:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (!order) return;
    if (!order.proposedDate) {
      await answerCb(callbackQuery.id, "Нет предложенного времени", true);
      return;
    }
    const proposed = new Date(order.proposedDate);
    if (proposed.getTime() < nowTjDate().getTime()) {
      await answerCb(callbackQuery.id, "Предложение уже в прошлом", true);
      return;
    }

    order.appointedDate = order.proposedDate;
    order.status = "ACCEPTED_BY_MASTER";
    saveData();
    logEvent({ actorId: chatId, action: "order_accept_proposed", targetId: order.id, meta: { appointedDate: order.appointedDate } });

    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});

    const isCome = order.logistics === "COME";
    const arrivedText = isCome ? "🚪 Клиент приехал" : "📍 Я на месте";
    const arrivedMsg = isCome
      ? `✅ Вы приняли заявку #${order.id} на ${formatDate(proposed)}.\nКогда клиент приедет — нажмите «🚪 Клиент приехал».`
      : `✅ Вы приняли заявку #${order.id} на ${formatDate(proposed)}.\nКогда приедете — нажмите «📍 Я на месте».`;
    await sendMessage(chatId, arrivedMsg, { reply_markup: { inline_keyboard: [[{ text: arrivedText, callback_data: `MASTER_ARRIVED:${order.id}` }]] } });

    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;
    const notifMsg = `✅ Мастер ${order.masterName} принял предложенное время по заявке #${order.id} на ${formatDate(proposed)}`;
    await safeSend(adminChatIdImm, notifMsg);
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, notifMsg);
    return;
  }

  if (data.startsWith("MH:")) {
    const [, orderIdStr, yyyymmdd, hh] = data.split(":");
    const order = orders.get(String(orderIdStr));
    if (!order) return;

    const y = parseInt(yyyymmdd.slice(0, 4), 10);
    const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
    const d = parseInt(yyyymmdd.slice(6, 8), 10);
    const selectedDate = new Date(y, m, d, parseInt(hh, 10), 0, 0);

    if (selectedDate.getTime() < nowTjDate().getTime()) {
      await answerCb(callbackQuery.id, "Нельзя выбрать прошедшее время", true);
      return;
    }

    order.appointedDate = selectedDate.toISOString();
    order.status = "ACCEPTED_BY_MASTER";
    logEvent({ actorId: chatId, action: "order_status_change", targetId: order.id, meta: { status: order.status } });
    saveData();

    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});

    const isCome = order.logistics === "COME";
    const arrivedText = isCome ? "🚪 Клиент приехал" : "📍 Я на месте";
    const arrivedMsg = isCome
      ? `✅ Вы приняли заявку #${order.id} на ${formatDate(selectedDate)}.\nКогда клиент приедет — нажмите «🚪 Клиент приехал».`
      : `✅ Вы приняли заявку #${order.id} на ${formatDate(selectedDate)}.\nКогда приедете — нажмите «📍 Я на месте».`;
    await sendMessage(chatId, arrivedMsg, { reply_markup: { inline_keyboard: [[{ text: arrivedText, callback_data: `MASTER_ARRIVED:${order.id}` }]] } });

    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;
    const notifKb = { inline_keyboard: [[{ text: "🗓 Предложить другое время", callback_data: `ADMIN_PROPOSE_TIME:${order.id}` }]] };
    const notifMsg = `✅ Мастер ${order.masterName} принял заявку #${order.id} на ${formatDate(selectedDate)}`;
    await safeSend(adminChatIdImm, notifMsg, { reply_markup: notifKb });
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, notifMsg, { reply_markup: notifKb });
    return;
  }

  if (data.startsWith("MASTER_ARRIVED:")) {
    const orderId = data.split(":")[1];
    const order = orders.get(String(orderId));
    if (!order) return;
    order.status = "ARRIVED";
    order.arrivedAt = nowTjIso();
    logEvent({ actorId: chatId, action: "order_status_change", targetId: order.id, meta: { status: order.status } });
    saveData();

    await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});

    const adminChatIdImm = order.adminChatId || SUPER_ADMIN_ID;
    const isCome = order.logistics === "COME";
    const notifMsg = isCome ? `🚪 Клиент приехал: заявка #${order.id} (${order.masterName})` : `📍 Мастер прибыл: заявка #${order.id} (${order.masterName})`;
    safeSend(adminChatIdImm, notifMsg);
    if (String(adminChatIdImm) !== String(SUPER_ADMIN_ID)) safeSend(SUPER_ADMIN_ID, notifMsg);

    await sendMessage(chatId, isCome ? `🚪 Клиент приехал (Заявка #${order.id}).\n\nФото не включены в этом укороченном файле.` : `📍 Вы прибыли (Заявка #${order.id}).\n\nФото не включены в этом укороченном файле.`);
    return;
  }

  if (data.startsWith("ADMIN_CONFIRM_TIME:")) {
    const orderId = data.split(":")[1];
    await editMessage(chatId, messageId, `⏳ Заявка #${orderId}. Укажите затраченное время:`, { reply_markup: installTimeKeyboard(orderId) });
    return;
  }

  if (data.startsWith("INST_TIME:")) {
    const [, orderIdStr, hoursStr] = data.split(":");
    const order = orders.get(String(orderIdStr));
    if (!order) return;
    order.installHours = parseInt(hoursStr, 10);
    order.status = "CLOSED";
    order.closedAt = nowTjIso();
    logEvent({ actorId: chatId, action: "order_status_change", targetId: order.id, meta: { status: order.status } });
    saveData();
    await editMessage(chatId, messageId, `✅ Заявка #${order.id} полностью ЗАКРЫТА.\nУчтено: ${order.installHours} ч.`);
    await safeSend(order.masterTgId, `✅ Ваша заявка #${order.id} закрыта администратором. Спасибо!`);
    return;
  }

  await answerCb(callbackQuery.id);
}

// =============================
// Helper Functions
// =============================
async function sendOrderToMaster(order) {
  const kb = masterOrderKeyboard(order.id);
  await safeSend(order.masterTgId, formatMasterOrder(order), { reply_markup: kb, parse_mode: "HTML" });
}

function statusLabel(st) {
  const map = {
    DRAFT: "Черновик",
    SENT_TO_MASTER: "Отправлено мастеру",
    ACCEPTED_BY_MASTER: "Принято (назначена дата)",
    PROPOSED_BY_ADMIN: "Перенесено админом",
    ARRIVED: "Мастер на месте",
    COMPLETED_BY_MASTER: "Выполнено мастером",
    RETURNED_BY_ADMIN: "Возврат админом",
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
  let res =
    `Тип: ${o.type === "REPAIR" ? "🔧 Ремонт" : "🛠 Монтаж"}\n` +
    `📞 Клиент: ${o.phone}\n` +
    `📍 Логистика: ${o.logistics === "COME" ? "🏢 Сам приедет" : "🚗 Выезд"}\n` +
    `🏠 Адрес: ${o.address || "—"}\n`;
  if (o.type === "INSTALL" && o.options) {
    res += `📦 Устройства: ${o.options.map((opt) => `${opt} × ${o.deviceQuantities?.[opt] || 1}`).join(", ")}\n`;
  }
  res += `💬 Коммент: ${o.adminComment || "—"}\n` + `📊 Статус: ${statusLabel(o.status)}`;
  if (o.appointedDate) res += `\n⏰ Дата: ${formatDate(new Date(o.appointedDate))}`;
  if (o.arrivedAt) res += `\n🟢 Начало: ${formatDate(new Date(o.arrivedAt))}`;
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
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Dushanbe",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// =============================
// Audit Excel
// =============================
async function sendAuditExcel(chatId) {
  let filePath;
  try {
    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet("Audit");
    sheet.columns = [
      { header: "Дата/Время", key: "ts", width: 22 },
      { header: "Событие", key: "action", width: 22 },
      { header: "Actor ID", key: "actorId", width: 15 },
      { header: "Actor Username", key: "actorUsername", width: 18 },
      { header: "Actor Name", key: "actorName", width: 22 },
      { header: "Actor City", key: "actorCity", width: 14 },
      { header: "Actor Role", key: "actorRole", width: 12 },
      { header: "Target ID", key: "targetId", width: 15 },
      { header: "Мета", key: "meta", width: 60 },
    ];

    for (const entry of auditLog) {
      sheet.addRow([
        formatDate(new Date(entry.ts)),
        entry.action,
        entry.actorId ?? "",
        entry.actorUsername ?? "",
        entry.actorName ?? "",
        entry.actorCity ?? "",
        entry.actorRole ?? "",
        entry.targetId ?? "",
        entry.meta ? JSON.stringify(entry.meta) : "",
      ]);
    }

    const chatSheet = workbook.addWorksheet("Переписка");
    chatSheet.columns = [
      { header: "Дата/Время", key: "ts", width: 22 },
      { header: "Тип", key: "type", width: 14 },
      { header: "От (ID)", key: "fromId", width: 14 },
      { header: "От (Имя)", key: "fromName", width: 22 },
      { header: "Кому (ID)", key: "toId", width: 14 },
      { header: "Кому (Имя)", key: "toName", width: 22 },
      { header: "Контент", key: "content", width: 60 },
    ];

    const nameOf = (id) => {
      const p = userProfiles[String(id)] || {};
      return p.name || (p.username ? `@${p.username}` : "");
    };

    for (const entry of auditLog) {
      if (!["message", "send_message", "send_photo", "send_document", "forward"].includes(entry.action)) continue;
      const fromId = entry.action === "message" ? entry.actorId ?? "" : entry.action === "forward" ? entry.actorId ?? "" : "BOT";
      const toId = entry.action === "message" ? "BOT" : entry.targetId ?? "";
      const content =
        entry.action === "message"
          ? entry.meta?.preview || ""
          : entry.action === "forward"
          ? entry.meta?.preview || ""
          : entry.meta?.textPreview || entry.meta?.captionPreview || entry.meta?.file || "";

      chatSheet.addRow([
        formatDate(new Date(entry.ts)),
        entry.action,
        fromId,
        fromId === "BOT" ? "BOT" : nameOf(fromId),
        toId,
        toId === "BOT" ? "BOT" : nameOf(toId),
        String(content || "").slice(0, 500),
      ]);
    }

    filePath = path.join(os.tmpdir(), `audit_${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(filePath);
    await sendDocument(chatId, filePath, "📒 Журнал аудита");
  } catch (e) {
    console.error("sendAuditExcel error:", e);
    logEvent({ actorId: null, action: "audit_excel_error", targetId: chatId, meta: { message: e?.message || String(e) } });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }
}

// =============================
// Reporting
// =============================
function getReportItems(from, to, opts) {
  const result = [];
  const startTs = from ? from.getTime() : 0;
  const endTs = to ? to.getTime() : 0;
  for (const [, o] of orders.entries()) {
    if (opts.pending) {
      if (["DRAFT", "SENT_TO_MASTER", "ACCEPTED_BY_MASTER", "PROPOSED_BY_ADMIN", "ARRIVED", "COMPLETED_BY_MASTER", "RETURNED_BY_ADMIN"].includes(o.status)) {
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

function sumByKinds(items) {
  const sums = {};
  REPORT_KIND_COLUMNS.forEach((k) => (sums[k] = 0));
  let totalDevices = 0;
  let totalHours = 0;
  for (const o of items) {
    const q = o.deviceQuantities || {};
    for (const k of REPORT_KIND_COLUMNS) sums[k] += Number(q[k] || 0);
    totalDevices += Number(o.totalDevices || 0);
    totalHours += Number(o.installHours || 0);
  }
  return { sums, totalDevices, totalHours };
}

async function sendTextReport(chatId, data) {
  const items = getReportItems(data.fromTs ? new Date(data.fromTs) : null, data.toTs ? new Date(data.toTs) : null, { pending: data.pending, masterTgId: data.masterTgId });
  if (items.length === 0) {
    await sendMessage(chatId, "📭 За этот период нет данных.");
    return;
  }

  const { sums, totalDevices, totalHours } = sumByKinds(items);
  const periodLine = data.pending ? "⏳ <b>Ожидающие заявки</b>" : `📊 <b>Итоги (${formatDate(new Date(data.fromTs))} – ${formatDate(new Date(data.toTs))})</b>`;

  let txt = `${periodLine}\n\n`;
  txt += `Заявок: ${items.length}\nУстройств: ${totalDevices}\nЧасов: ${totalHours}\n\n`;
  txt += `<b>Установки по видам:</b>\n`;
  for (const k of REPORT_KIND_COLUMNS) txt += `• ${k}: ${sums[k]}\n`;
  await sendMessage(chatId, txt, { parse_mode: "HTML" });
}

function buildExcelReport(from, to, opts) {
  const items = getReportItems(from, to, opts);
  const wb = XLSX.utils.book_new();

  const header = [
    "ID",
    "Создана",
    "Назначено",
    "Начало работ",
    "Завершена",
    "Статус",
    "Телефон",
    "Мастер",
    "Тип",
    "Логистика",
    "Адрес",
    "Опции",
    ...REPORT_KIND_COLUMNS,
    "Устройств",
    "Затрачено часов",
    "Комментарий",
  ];

  const wsData = [[`Период отчёта: ${formatDate(from)}–${formatDate(to)} (Asia/Dushanbe)`], [], header];

  items.forEach((o) => {
    const q = o.deviceQuantities || {};
    wsData.push([
      o.id,
      formatDate(new Date(o.createdAt)),
      o.appointedDate ? formatDate(new Date(o.appointedDate)) : "—",
      o.arrivedAt ? formatDate(new Date(o.arrivedAt)) : "—",
      o.completedAt ? formatDate(new Date(o.completedAt)) : o.closedAt ? formatDate(new Date(o.closedAt)) : "—",
      statusLabel(o.status),
      o.phone,
      o.masterName,
      o.type === "REPAIR" ? "Ремонт" : "Монтаж",
      o.logistics === "COME" ? "Сам приедет" : "Выезд",
      o.address || "",
      (o.options || []).map((opt) => `${opt}×${o.deviceQuantities?.[opt] || 1}`).join(", "),
      ...REPORT_KIND_COLUMNS.map((k) => Number(q[k] || 0)),
      Number(o.totalDevices || 0),
      Number(o.installHours || 0),
      o.adminComment || "",
    ]);
  });

  const totals = sumByKinds(items);
  const totalsRow = new Array(header.length).fill("");
  totalsRow[0] = "ИТОГО";
  const kindStart = header.indexOf(REPORT_KIND_COLUMNS[0]);
  for (let i = 0; i < REPORT_KIND_COLUMNS.length; i++) totalsRow[kindStart + i] = totals.sums[REPORT_KIND_COLUMNS[i]];
  totalsRow[header.indexOf("Устройств")] = totals.totalDevices;
  totalsRow[header.indexOf("Затрачено часов")] = totals.totalHours;
  wsData.push([]);
  wsData.push(totalsRow);

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wsData), "Отчёт");

  // Сводка_мастера
  const masterMap = new Map();
  for (const o of items) {
    const key = String(o.masterTgId || o.masterName || "—");
    if (!masterMap.has(key)) masterMap.set(key, { master: o.masterName || key, count: 0, devices: 0, hours: 0, kinds: Object.fromEntries(REPORT_KIND_COLUMNS.map((k) => [k, 0])) });
    const row = masterMap.get(key);
    row.count += 1;
    row.devices += Number(o.totalDevices || 0);
    row.hours += Number(o.installHours || 0);
    const q = o.deviceQuantities || {};
    for (const k of REPORT_KIND_COLUMNS) row.kinds[k] += Number(q[k] || 0);
  }
  const masterHeader = ["Мастер", "Заявок", "Устройств", "Часов", ...REPORT_KIND_COLUMNS];
  const masterData = [masterHeader];
  let totalCount = 0,
    totalDev = 0,
    totalH = 0;
  const totalKinds = Object.fromEntries(REPORT_KIND_COLUMNS.map((k) => [k, 0]));
  for (const r of masterMap.values()) {
    masterData.push([r.master, r.count, r.devices, r.hours, ...REPORT_KIND_COLUMNS.map((k) => r.kinds[k])]);
    totalCount += r.count;
    totalDev += r.devices;
    totalH += r.hours;
    for (const k of REPORT_KIND_COLUMNS) totalKinds[k] += r.kinds[k];
  }
  masterData.push([]);
  masterData.push(["ИТОГО", totalCount, totalDev, totalH, ...REPORT_KIND_COLUMNS.map((k) => totalKinds[k])]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(masterData), "Сводка_мастера");

  // Сводка_устройства
  const kindData = [["Вид", "Количество"]];
  for (const k of REPORT_KIND_COLUMNS) kindData.push([k, totals.sums[k]]);
  kindData.push([]);
  kindData.push(["ИТОГО", Object.values(totals.sums).reduce((a, b) => a + b, 0)]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kindData), "Сводка_устройства");

  const filePath = path.join(os.tmpdir(), `report_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

function buildExcelReportPending(opts) {
  const items = getReportItems(null, null, { pending: true, masterTgId: opts.masterTgId });
  const wb = XLSX.utils.book_new();
  const wsData = [["ОЖИДАЮЩИЕ ЗАЯВКИ (PENDING)"], [], ["ID", "Создана", "Статус", "Прошло времени", "Телефон", "Мастер", "Тип", "Логистика", "Адрес", "Опции", "Устройств", "Комментарий"]];
  let totalDevs = 0;
  items.forEach((o) => {
    totalDevs += Number(o.totalDevices || 0);
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
      (o.options || []).map((opt) => `${opt}×${o.deviceQuantities?.[opt] || 1}`).join(", "),
      Number(o.totalDevices || 0),
      o.adminComment || "",
    ]);
  });
  wsData.push([]);
  wsData.push(["ИТОГО", "", "", "", "", "", "", "", "", "", totalDevs, ""]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wsData), "Pending");
  const filePath = path.join(os.tmpdir(), `report_pending_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

// =============================
// Start server
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server started on port ${PORT}`);
  logEvent({ actorId: null, action: "startup", targetId: null, meta: { port: PORT } });
  try {
    // setMyCommands removed: do not show the blue /start command button in the input field
    if (process.env.WEBHOOK_URL) {
      await tg("setWebhook", { url: process.env.WEBHOOK_URL });
      console.log("✅ Webhook is set");
      logEvent({ actorId: null, action: "webhook_set", targetId: null, meta: { url: process.env.WEBHOOK_URL } });
    } else {
      console.warn("⚠️ WEBHOOK_URL not set");
      logEvent({ actorId: null, action: "webhook_missing", targetId: null, meta: {} });
    }
  } catch (e) {
    console.error("❌ Startup error:", e?.message || e);
    logEvent({ actorId: null, action: "startup_error", targetId: null, meta: { message: e?.message || String(e) } });
  }
});
