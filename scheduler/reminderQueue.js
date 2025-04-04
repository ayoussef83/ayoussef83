// scheduler/reminderQueue.js (Temporary Test - Removed date-fns-tz from job)
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
// المكتبة لسه موجودة بس مش هنستخدمها جوه الجوب مؤقتاً
const dateFnsTz = require('date-fns-tz');

const TIME_ZONE = 'Africa/Cairo';

// دالة addReminder زي ما هي
async function addReminder(to, message, executeAt) {
    try {
        const collection = getRemindersCollection();
        if (!collection) {
            console.error("❌ Cannot add reminder: Reminders collection is not available.");
            return;
        }
        if (!(executeAt instanceof Date) || isNaN(executeAt.getTime())) {
             console.error("❌ Cannot add reminder: Invalid executeAt date provided.");
             return;
        }
        const result = await collection.insertOne({
            to, message, executeAt, createdAt: new Date(), status: 'pending'
        });
        // استخدام الدوال هنا عادي لأن ده مش جوه الـ job
        const localTime = dateFnsTz.utcToZonedTime(executeAt, TIME_ZONE);
        const formattedLocalTime = dateFnsTz.format(localTime, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE });
        console.log(`📥 Reminder added with ID: ${result.insertedId}. Scheduled for: ${formattedLocalTime}`);
    } catch (error) {
        console.error('❌ Error adding reminder to database:', error);
    }
}

function initializeReminderProcessor() {
    console.log('🕒 Initializing Reminder Processor...');

    schedule.scheduleJob('*/1 * * * *', async () => { // شغل كل دقيقة
        const collection = getRemindersCollection();
        if (!collection) {
            return;
        }
        const now = new Date(); // UTC time

        // --- السطور دي تم عمل كومنت عليها للاختبار ---
        // const localNow = dateFnsTz.utcToZonedTime(now, TIME_ZONE); // للعرض فقط
        // const formattedLocalNow = dateFnsTz.format(localNow, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE });
        // console.log(`Checking for due reminders at ${formattedLocalNow} (UTC: ${now.toISOString()})`);
        // --- نهاية الكومنت ---

        // Log مبسط للاختبار
        console.log(`[TEST] Checking for due reminders at (UTC): ${now.toISOString()}`);

        try {
            const dueReminders = await collection.find({
                executeAt: { $lte: now },
                status: 'pending'
            }).toArray();

            if (dueReminders.length > 0) {
                console.log(`[TEST] Found ${dueReminders.length} due reminder(s).`);
            }

            for (const reminder of dueReminders) {
                console.log(`[TEST] Processing reminder ${reminder._id} for ${reminder.to}`);
                try {
                    await sendWhatsAppMessage(reminder.to, reminder.message);
                    console.log(`[TEST] ✅ Successfully sent reminder ${reminder._id}.`);
                    await collection.deleteOne({ _id: reminder._id });
                    console.log(`[TEST] 🗑️ Deleted reminder ${reminder._id} from database.`);
                } catch (sendError) {
                    console.error(`[TEST] ❌ Failed processing reminder ${reminder._id}:`, sendError);
                }
            }
        } catch (dbError) {
            console.error("[TEST] ❌ Error fetching or processing reminders from database:", dbError);
        }
    });
    console.log('✅ Reminder Processor scheduled to run every minute.');
}
module.exports = { addReminder, initializeReminderProcessor };
