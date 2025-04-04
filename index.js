// index.js
const express = require('express');
const dotenv = require('dotenv');
// const webhookRoutes = require('./routes/webhook'); // هنشيل الكومنت لما نعمل الملف ده
// const { initializeReminderProcessor } = require('./scheduler/reminderQueue'); // هنشيل الكومنت لما نعمل الملف ده

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000; // Render بيستخدم متغير PORT أو 10000 كافتراضي

// Middleware لتحليل JSON (مهم للـ webhooks)
app.use(express.json());

// // Webhook Route (هنشيل الكومنت لما نعمل الملف بتاعه)
// app.use('/webhook', webhookRoutes);

// Root Route للتأكد إن السيرفر شغال
app.get('/', (req, res) => {
  res.send('Azo0z is starting up on Render! 🚀');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // // Initialize Schedulers (هنشيل الكومنت لما نعمل الملفات بتاعتهم)
  // initializeReminderProcessor();
  // ممكن نضيف هنا أي مهام تانية بتشتغل مع بداية السيرفر لو فيه
});

// سطر احتياطي عشان نتأكد إن الملف اتعمل صح
console.log("index.js loaded successfully.");
