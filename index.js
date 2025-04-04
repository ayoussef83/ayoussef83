// scheduler/reminderQueue.js
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database'); // لاستدعاء collection التذكيرات
const { sendWhatsAppMessage } = require('../utils/whatsapp'); // لإرسال الرسائل
const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz'); // للتعامل مع التوقيت صح

const TIME_ZONE = 'Africa/Cairo'; // تحديد المنطقة الزمنية لمصر

/**
 * إضافة تذكير جديد لقاعدة البيانات
 * @param {string} to - رقم المستلم
 * @param {string} message - نص التذكير
 * @param {Date} executeAt - توقيت التنفيذ (يجب أن يكون كائن Date بتوقيت UTC)
 */
async function addReminder(to, message, executeAt) {
    try {
        const collection = getRemindersCollection();
        if (!collection) {
            console.error("❌ Cannot add reminder: Reminders collection is not available.");
            return;
        }
        // تأكد أن executeAt هو كائن Date
        if (!(executeAt instanceof Date) || isNaN(executeAt.getTime())) {
             console.error("❌ Cannot add reminder: Invalid executeAt date provided.");
             return;
        }

        const result = await collection.insertOne({
            to,
            message,
            executeAt, // MongoDB يخزن التواريخ بتوقيت UTC افتراضياً
            createdAt: new Date(),
            status: 'pending' // حالة المهمة
        });
        // عرض الوقت بتوقيت القاهرة للتوضيح في اللوج
        const localTime = utcToZonedTime(executeAt, TIME_ZONE);
        const formattedLocalTime = format(localTime, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE });
        console.log(`📥 Reminder added with ID: ${result.insertedId}. Scheduled for: ${formattedLocalTime}`);

    } catch (error) {
        console.error('❌ Error adding reminder to database:', error);
    }
}

/**
 * بدء معالج قائمة التذكيرات للبحث عن المهام المستحقة وتنفيذها
 */
function initializeReminderProcessor() {
    console.log('🕒 Initializing Reminder Processor...');

    // جدولة مهمة تعمل كل دقيقة
    schedule.scheduleJob('*/1 * * * *', async () => {
        const collection = getRemindersCollection();
        if (!collection) {
            // لا تفعل شيئاً إذا لم يتم الاتصال بقاعدة البيانات بعد
            // الدالة connectDB في index.js هي المسؤولة عن الاتصال الأولي
            // console.log("Reminder check skipped: DB not ready.");
            return;
        }

        const now = new Date(); // الوقت الحالي (UTC)
        const localNow = utcToZonedTime(now, TIME_ZONE); // للعرض فقط
        console.log(`Checking for due reminders at ${format(localNow, 'yyyy-MM-dd HH:mm:ss zzzz', { timeZone: TIME_ZONE })} (UTC: ${now.toISOString()})`);

        try {
            // البحث عن المهام المستحقة التي لم يتم تنفيذها بعد
            const dueReminders = await collection.find({
                executeAt: { $lte: now }, // وقت التنفيذ حان أو فات
                status: 'pending'         // والحالة لسه pending
            }).toArray();

            if (dueReminders.length > 0) {
                console.log(`Found ${dueReminders.length} due reminder(s).`);
            }

            for (const reminder of dueReminders) {
                console.log(`Processing reminder ${reminder._id} for ${reminder.to}`);
                try {
                    // 1. محاولة إرسال الرسالة
                    await sendWhatsAppMessage(reminder.to, reminder.message);
                    console.log(`✅ Successfully sent reminder ${reminder._id}.`);

                    // 2. لو الإرسال نجح، احذف المهمة من قاعدة البيانات
                    await collection.deleteOne({ _id: reminder._id });
                    console.log(`🗑️ Deleted reminder ${reminder._id} from database.`);

                } catch (sendError) {
                    // لو حصل خطأ أثناء الإرسال أو الحذف
                    console.error(`❌ Failed processing reminder ${reminder._id}:`, sendError);
                    // ممكن نغير الحالة لـ 'failed' بدل الحذف عشان نحاول تاني أو نحللها
                    // await collection.updateOne({ _id: reminder._id }, { $set: { status: 'failed', error: sendError.message } });
                }
            }
        } catch (dbError) {
            console.error("❌ Error fetching or processing reminders from database:", dbError);
        }
    });

    console.log('✅ Reminder Processor scheduled to run every minute.');
}

module.exports = { addReminder, initializeReminderProcessor };
