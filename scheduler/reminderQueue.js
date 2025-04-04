// scheduler/reminderQueue.js (Using Luxon in addReminder logging)
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
// --- استدعاء Luxon هنا أيضاً ---
const { DateTime } = require('luxon');

const TIME_ZONE = 'Africa/Cairo';

async function addReminder(to, message, executeAt /* هذا كائن Date بتوقيت UTC */) {
    try {
        const collection = getRemindersCollection();
        if (!collection) { /*...*/ return; }
        if (!(executeAt instanceof Date) || isNaN(executeAt.getTime())) { /*...*/ return; }
        const result = await collection.insertOne({
            to, message, executeAt, createdAt: new Date(), status: 'pending'
        });

        // --- تغيير طريقة طباعة الوقت هنا باستخدام Luxon ---
        let formattedLocalTime = 'N/A';
        try {
            // حول كائن Date (UTC) إلى كائن Luxon (UTC) ثم حوله لمنطقة القاهرة الزمنية واطبعه
            formattedLocalTime = DateTime.fromJSDate(executeAt).setZone(TIME_ZONE).toFormat('yyyy-MM-dd hh:mm:ss a ZZZZ');
        } catch (formatError) {
             console.error("Error formatting reminder time for logging with Luxon:", formatError);
             formattedLocalTime = executeAt.toISOString() + ' (UTC)'; // Fallback
        }
        console.log(`📥 Reminder added with ID: ${result.insertedId}. Scheduled for: ${formattedLocalTime}`);
        // --------------------------------------------------
    } catch (error) {
        console.error('❌ Error adding reminder to database:', error);
    }
}

function initializeReminderProcessor() {
    console.log('🕒 Initializing Reminder Processor...');

    schedule.scheduleJob('*/1 * * * *', async () => { // Run every minute
        // --- هذا الجزء يستخدم التنسيق الأصلي لأنه يعمل بشكل جيد هنا ---
        const collection = getRemindersCollection();
        if (!collection) { return; }
        const now = new Date(); // Current time (UTC)
        let formattedLocalNow = 'N/A';
        try {
            const options = { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
            formattedLocalNow = now.toLocaleString('en-CA', options).replace(',','');
        } catch (intlError) {
            console.error("Error formatting date with Intl:", intlError);
            formattedLocalNow = now.toISOString() + ' (UTC fallback)';
        }
        console.log(`Checking for due reminders at <span class="math-inline">\{formattedLocalNow\} \(</span>{TIME_ZONE})`);
        // ---------------------------------------------------------

        try {
            // ... (Rest of the scheduler logic remains the same) ...
            const dueReminders = await collection.find({
                executeAt: { $lte: now },
                status: 'pending'
            }).toArray();
             if (dueReminders.length > 0) { console.log(`Found ${dueReminders.length} due reminder(s).`); }
             for (const reminder of dueReminders) { /* ... process reminder ... */ }
        } catch (dbError) {
            console.error("❌ Error fetching or processing reminders from database:", dbError);
        }
    });
    console.log('✅ Reminder Processor scheduled to run every minute.');
}

module.exports = { addReminder, initializeReminderProcessor };
