// scheduler/reminderQueue.js
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database');
const { sendWhatsAppMessage } = require('../utils/whatsapp');

// --- التغيير هنا: استدعاء المكتبة كلها بدل أجزاء منها ---
const dateFnsTz = require('date-fns-tz');
// -------------------------------------------------------

const TIME_ZONE = 'Africa/Cairo';

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
            to,
            message,
            executeAt,
            createdAt: new Date(),
            status: 'pending'
        });

        // --- التغيير هنا: استخدام dateFnsTz.اسم_الدالة ---
        const localTime = dateFnsTz.utcToZonedTime(executeAt, TIME_ZONE);
        const formattedLocalTime = dateFnsTz.format(localTime, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE });
        // ---------------------------------------------
        console.log(`📥 Reminder added with ID: ${result.insertedId}. Scheduled for: ${formattedLocalTime}`);

    } catch (error) {
        console.error('❌ Error adding reminder to database:', error);
    }
}

function initializeReminderProcessor() {
    console.log('🕒 Initializing Reminder Processor...');

    schedule.scheduleJob('*/1 * * * *', async () => {
        const collection = getRemindersCollection();
        if (!collection) {
            return;
        }

        const now = new Date(); // UTC time

        // --- التغيير هنا: استخدام dateFnsTz.اسم_الدالة ---
        const localNow = dateFnsTz.utcToZonedTime(now, TIME_ZONE); // للعرض فقط
        const formattedLocalNow = dateFnsTz.format(localNow, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE });
        // ---------------------------------------------
        console.log(`Checking for due reminders at ${formattedLocalNow} (UTC: ${now.toISOString()})`);

        try {
            const dueReminders = await collection.find({
                executeAt: { $lte: now },
                status: 'pending'
            }).toArray();

            if (dueReminders.length > 0) {
                console.log(`Found ${dueReminders.length} due reminder(s).`);
            }

            for (const reminder of dueReminders) {
                console.log(`Processing reminder ${reminder._id} for ${reminder.to}`);
                try {
                    await sendWhatsAppMessage(reminder.to, reminder.message);
                    console.log(`✅ Successfully sent reminder ${reminder._id}.`);
                    await collection.deleteOne({ _id: reminder._id });
                    console.log(`🗑️ Deleted reminder ${reminder._id} from database.`);
                } catch (sendError) {
                    console.error(`❌ Failed processing reminder ${reminder._id}:`, sendError);
                    // await collection.updateOne({ _id: reminder._id }, { $set: { status: 'failed', error: sendError.message } });
                }
            }
        } catch (dbError) {
            console.error("❌ Error fetching or processing reminders from database:", dbError);
        }
    });

    console.log('✅ Reminder Processor scheduled to run every minute.');
}

// --- لازم نعدل دالة addReminder في routes/webhook.js عشان تستخدم dateFnsTz.parse و dateFnsTz.zonedTimeToUtc ---
// الكود ده مفيهوش تعديل على addReminder نفسها، بس محتاجين نعدل طريقة استدعائها في webhook.js بعدين

module.exports = { addReminder, initializeReminderProcessor };
