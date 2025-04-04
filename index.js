// index.js
const express = require('express');
const dotenv = require('dotenv');
// الخطوة دي: بنشيل الكومنت من السطر الجاي عشان نستدعي ملف الرووتس
const webhookRoutes = require('./routes/webhook');
// const { initializeReminderProcessor } = require('./scheduler/reminderQueue'); // لسه شوية على دي

// التأكد من تحميل متغيرات البيئة أول حاجة
dotenv.config();

const app = express();
// Render بيوفر متغير البيئة PORT تلقائياً
const PORT = process.env.PORT || 10000;

// Middleware لتحليل JSON
app.use(express.json());

// الخطوة دي: بنشيل الكومنت من السطر الجاي عشان نستخدم الرووتس فعلاً
// أي طلب ييجي على /webhook هيتم توجيهه لملف webhookRoutes
app.use('/webhook', webhookRoutes);

// Root Route للتأكد إن السيرفر شغال
app.get('/', (req, res) => {
  // ممكن نغير الرسالة عشان نعرف إن التحديث وصل
  res.send('Azo0z v2 is starting up on Render! Webhook route active. 🚀');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Webhook endpoint ready at /webhook`);
  // // Initialize Schedulers (لسه شوية)
  // initializeReminderProcessor();
});

console.log("index.js v2 loaded successfully.");
