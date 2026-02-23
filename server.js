import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;          // Render Env
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN is missing in environment variables!");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ✅ Healthcheck
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ✅ Webhook endpoint (под него будем ставить setWebhook)
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;

    // Быстро отвечаем Telegram, чтобы не было ретраев/спама
    res.sendStatus(200);

    // Обработка сообщений
    if (update.message?.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "👋 Привет! Главное меню активировано.",
          reply_markup: {
            keyboard: [[{ text: "📝 Новая заявка" }, { text: "❌ Отмена" }]],
            resize_keyboard: true,
          },
        });
        return;
      }

      if (text === "📝 Новая заявка") {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "📞 Введите номер телефона клиента:",
        });
        return;
      }

      if (text === "❌ Отмена") {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Отменено.",
        });
        return;
      }

      // тестовый ответ
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `✅ Получено: ${text}`,
      });
    }

    // Обработка inline-кнопок (на будущее)
    if (update.callback_query) {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: update.callback_query.id,
      });
    }
  } catch (e) {
    console.error("Webhook handler error:", e?.response?.data || e.message);
    // уже ответили 200, чтобы Telegram не ретраил
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
