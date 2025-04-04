// index.js
const express = require('express');
const dotenv = require('dotenv');
const webhookRoutes = require('./routes/webhook');
const { connectDB } = require('./utils/database');
const { initializeReminderProcessor } = require('./scheduler/reminderQueue');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use('/webhook', webhookRoutes);

app.get('/', (req, res) => {
  res.send('Azo0z v4 is starting up on Render! Webhook active. DB Connected. Reminder processor initializing... 🚀');
});

// جعل دالة الـ callback هنا async عشان نقدر نستخدم await
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Webhook endpoint ready at /webhook`);

  try {
    // 1. الاتصال بقاعدة البيانات أولاً
    await connectDB();

    // 2. لو الاتصال نجح، نشغل الـ processor بتاع التذكيرات
    initializeReminderProcessor();

  } catch (err) {
    console.error("Startup sequence failed:", err);
    // process.exit(1); // ممكن نوقف السيرفر لو الاتصال فشل
  }
});

console.log("index.js v4 loaded successfully."); // تغيير الرسالة لتتبع النسخة
