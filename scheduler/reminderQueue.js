// scheduler/reminderQueue.js (Workaround: Require date-fns-tz inside job)
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
// ممكن نسيب الـ require ده هنا أو نشيله، مش هتفرق كتير طالما هنعمله جوه الجوب
// const dateFnsTz = require('date-fns-tz');

const TIME_ZONE = 'Africa/Cairo';

// دالة addReminder زي ما هي وممكن تستخدم date-fns-tz عادي هنا
async function addReminder(to, message, executeAt) {
    const dateFnsTzForAdd = require('date-fns-tz'); // ممكن نعمل require هنا لو محتاجينها برضه
    try {
        const collection = getRemindersCollection();
        if (!collection) { /*...*/ return; }
        if (!(executeAt instanceof Date) || isNaN(executeAt.getTime())) { /*...*/ return; }

        const result = await collection.insertOne({
            to, message, executeAt, createdAt: new Date(), status: 'pending'
        });
        const localTime = dateFnsTzForAdd.utcToZonedTime(executeAt, TIME_ZONE);
        const formattedLocalTime = dateFnsTzForAdd.format(localTime, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE });
        console.log(`📥 Reminder added with ID: ${result.insertedId}. Scheduled for: ${formattedLocalTime}`);
    } catch (error) {
        console.error('❌ Error adding reminder to database:', error);
    }
}

function initializeReminderProcessor() {
    console.log('🕒 Initializing Reminder Processor...');

    schedule.scheduleJob('*/1 * * * *', async () => { // شغل كل دقيقة
         // **** بداية التغيير: نعمل require للمكتبة هنا ****
         let dateFnsTz;
         try {
             dateFnsTz = require('date-fns-tz');
         } catch(requireErr) {
             console.error("❌ Failed to require date-fns-tz inside schedule job:", requireErr);
             // لو معرفناش نعمل require يبقى نوقف الجوب ده
             return;
         }
         // **** نهاية التغيير ****

        const collection = getRemindersCollection();
        if (!collection) {
            return;
        }

        const now = new Date(); // UTC time

        // --- نرجع نستخدم الدوال تاني ---
        const localNow = dateFnsTz.utcToZonedTime(now, TIME_ZONE); // للعرض فقط
        const formattedLocalNow = dateFnsTz.format(localNow, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE });
        console.log(`Checking for due reminders at ${formattedLocalNow} (UTC: ${now.toISOString()})`);
        // --- نهاية الرجوع ---

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
                }
            }
        } catch (dbError) {
            console.error("❌ Error fetching or processing reminders from database:", dbError);
        }
    });

    console.log('✅ Reminder Processor scheduled to run every minute.');
}

module.exports = { addReminder, initializeReminderProcessor };
