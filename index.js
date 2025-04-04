// index.js (Temporary Test)
const express = require('express');
const dotenv = require('dotenv');

// --- Test require ---
try {
    const pkg = require('./package.json'); // بنحاول نعمل require للملف ده
    console.log('✅ SUCCESS: Loaded package.json version:', pkg.version);
} catch (err) {
    console.error('❌ FAILED to require ./package.json:', err);
}
// --- End Test ---

// Comment out other requires for now
// const { connectDB } = require('./utils/database');
// const webhookRoutes = require('./routes/webhook');
// const { initializeReminderProcessor } = require('./scheduler/reminderQueue');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
// app.use('/webhook', webhookRoutes);
app.get('/', (req, res) => {
  res.send('Azo0z v5 TEST is starting up on Render!');
});
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // try {
  //   await connectDB();
  //   initializeReminderProcessor();
  // } catch (err) {
  //   console.error("Startup sequence failed:", err);
  // }
});
console.log("index.js v5 TEST loaded successfully.");
