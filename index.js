// index.js
const express = require('express');
const dotenv = require('dotenv');

// --- تحميل متغيرات البيئة أولاً ---
dotenv.config();

// --- استدعاء الوحدات بعد تحميل dotenv ---
const webhookRoutes = require('./routes/webhook');
const { connectDB } = require('./utils/database');
const { initializeReminderProcessor } = require('./scheduler/reminderQueue');

const app = express();
const PORT = process.env.PORT || 10000; // Port provided by Render

// --- Middlewares ---
app.use(express.json()); // Parse JSON bodies

// --- Routes ---
app.use('/webhook', webhookRoutes);

app.get('/', (req, res) => {
  // Simple health check endpoint
  res.send('Azo0z vFINAL is running on Render! DB connected, Scheduler initialized. 🚀');
});

// --- Start Server and Initialize ---
// Using an Immediately Invoked Async Function Expression (IIAFE) for top-level await
(async () => {
  try {
    // 1. Connect to Database first
    await connectDB();

    // 2. If DB connection succeeds, initialize the reminder processor
    initializeReminderProcessor();

    // 3. Start listening for HTTP requests
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`Webhook endpoint ready at /webhook`);
      console.log(`Reminder processor is running and checking every minute.`);
    });

    console.log("index.js vFINAL loaded successfully.");

  } catch (err) {
    console.error("❌ CRITICAL STARTUP ERROR:", err);
    // Exit process if critical setup fails (like DB connection)
    process.exit(1);
  }
})(); // Execute the async function immediately
