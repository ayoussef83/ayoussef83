// scheduler/reminderQueue.js (Workaround: Use native Date formatting in job)
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
// هنخلي ال require ده فوق عشان addReminder بتستخدمه
const dateFnsTz = require('date-fns-tz');

const TIME_ZONE = 'Africa/Cairo'; // مهم للتنسيق والتحويل في addReminder

// دالة addReminder زي ما هي
async function addReminder(to, message, executeAt) {
    try {
        const collection = getRemindersCollection();
        if (!collection) { /*...*/ return; }
        if (!(executeAt instanceof Date) || isNaN(executeAt.getTime())) { /*...*/ return; }
        const result = await collection.insertOne({
            to, message, executeAt, createdAt: new Date(), status: 'pending'
        });
        // الاستخدام هنا للوج سليم ومفيهوش مشاكل
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
        // **** بداية التغيير: استخدام طريقة Node.js الأصلية لتنسيق الوقت للوج ****
        // لا نحاول استدعاء require('date-fns-tz') هنا بعد الآن

        const collection = getRemindersCollection();
        if (!collection) {
            return;
        }

        const now = new Date(); // الوقت الحالي (UTC)

        // طريقة بديلة لتنسيق الوقت باستخدام Intl المدمجة في Node.js
        let formattedLocalNow = 'N/A';
        try {
             // 'en-CA' بتدي صيغة YYYY-MM-DD كويسة، ممكن نستخدمها مع الوقت
            const options = { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
            formattedLocalNow = now.toLocaleString('en-CA', options).replace(',',''); // استبدال الفاصلة لو ظهرت
        } catch (intlError) {
             console.error("Error formatting date with Intl:", intlError);
             // لو فشل نستخدم صيغة أبسط
             formattedLocalNow = now.toISOString() + ' (UTC fallback)';
        }
        console.log(`Checking for due reminders at <span class="math-inline">\{formattedLocalNow\} \(</span>{TIME_ZONE})`);
        // **** نهاية التغيير ****

        try {
            // باقي الكود زي ما هو: البحث عن التذكيرات وإرسالها وحذفها
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
