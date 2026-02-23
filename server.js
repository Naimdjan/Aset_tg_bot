const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "20mb" }));

// Render использует PORT из переменных окружения
const PORT = process.env.PORT || 3000;

// === ENV переменные (Render -> Environment) ===
const BOT_TOKEN = process.env.BOT_TOKEN;          // токен телеграм бота
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;  // твой id (не обязательно)
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

// ---------- helpers ----------
async function tg(method, payload) {
  if (!TELEGRAM_API) throw new Error("BOT_TOKEN not set");
  return axios.post(`${TELEGRAM_API}/${method}`, payload);
}

// ---------- health ----------
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "aset_tg_bot" });
});

// ---------- webhook endpoint ----------
app.post("/telegram/webhook", async (req, res) => {
  // ВАЖНО: отвечаем Telegram сразу, чтобы не было повторов/спама
  res.sendStatus(200);

  try {
    const update = req.body;

    // 1) Обычные сообщения
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = (update.message.text || "").trim();

      if (text === "/start") {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "✅ Render + Node работает.\n\nКоманды:\n/start\n/getmyid"
        });
        return;
      }

      if (text === "/getmyid") {
        const userId = update.message.from?.id;
        await tg("sendMessage", {
          chat_id: chatId,
          text: `Ваш Telegram ID: ${userId}\nChat ID: ${chatId}`
        });
        return;
      }

      // НЕ отвечаем на всё подряд, чтобы не было ощущения “спама”
      // Можно включить только для отладки:
      // await tg("sendMessage", { chat_id: chatId, text: `Получено: ${text}` });
      return;
    }

    // 2) callback_query (на будущее кнопки)
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;

      await tg("answerCallbackQuery", { callback_query_id: cb.id });

      // пример реакции на кнопку:
      if (cb.data === "ping") {
        await tg("sendMessage", { chat_id: chatId, text: "pong ✅" });
      }
      return;
    }
  } catch (err) {
    // если задан ADMIN_CHAT_ID — шлём туда ошибки
    try {
      if (ADMIN_CHAT_ID && TELEGRAM_API) {
        await tg("sendMessage", {
          chat_id: ADMIN_CHAT_ID,
          text: `🚨 Ошибка: ${err.message}`
        });
      }
    } catch (_) {}
  }
});

// ---------- start server ----------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
