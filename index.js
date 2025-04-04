// index.js
const express = require('express');
const dotenv = require('dotenv');
const webhookRoutes = require('./routes/webhook');
// الخطوة دي: بنستدعي دالة الاتصال بقاعدة البيانات
const { connectDB } = require('./utils/database');
// const { initializeReminderProcessor } = require('./scheduler/reminderQueue'); // لسه شوية على دي

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use('/webhook', webhookRoutes);

app.get('/', (req, res) => {
  res.send('Azo0z v3 is starting up on Render! Webhook active. Trying DB connection... 🚀');
});

// جعل دالة الـ callback هنا async عشان نقدر نستخدم await
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Webhook endpoint ready at /webhook`);

  try {
    // الخطوة دي: بننادي على دالة الاتصال بقاعدة البيانات هنا
    await connectDB(); // بنستنى لحد ما الاتصال يتم أو يفشل
  } catch (err) {
    console.error("Database connection failed on startup, reminders might not work.", err);
    // ممكن هنا نوقف السيرفر لو الاتصال بالداتابيز ضروري جداً
    // process.exit(1);
  }

  // // Initialize Schedulers (لسه شوية)
  // initializeReminderProcessor();
});

console.log("index.js v3 loaded successfully.");
