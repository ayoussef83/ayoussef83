// scheduler/reminderQueue.js (Enhanced Logging & Fixes)
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { DateTime } = require('luxon');

const TIME_ZONE = 'Africa/Cairo';

async function addReminder(to, message, executeAt /* Date object in UTC */) {
    try {
        const collection = getRemindersCollection();
        if (!collection) {
            console.error("DB collection is not available in addReminder.");
            return;
        }
        if (!(executeAt instanceof Date) || isNaN(executeAt.getTime())) {
             console.error("Invalid Date object passed to addReminder:", executeAt);
             return;
        }
        const result = await collection.insertOne({
            to, message, executeAt, createdAt: new Date(), status: 'pending'
        });

        // --- Fix logging format here ---
        let formattedLocalTime = 'N/A';
        try {
            formattedLocalTime = DateTime.fromJSDate(executeAt).setZone(TIME_ZONE).toFormat('yyyy-MM-dd hh:mm:ss a ZZZZ');
        } catch (formatError) {
             console.error("Error formatting reminder time for logging with Luxon:", formatError);
             formattedLocalTime = executeAt.toISOString() + ' (UTC)'; // Fallback
        }
        // --- Use backticks for interpolation ---
        console.log(`📥 Reminder added with ID: ${result.insertedId}. Scheduled for: ${formattedLocalTime}`);
        // -------------------------------------
    } catch (error) {
        console.error('❌ Error adding reminder to database:', error);
    }
}

function initializeReminderProcessor() {
    console.log('🕒 Initializing Reminder Processor...');

    schedule.scheduleJob('*/1 * * * *', async () => { // Run every minute
        const collection = getRemindersCollection();
        if (!collection) {
             console.error("DB collection not available in scheduled job.");
             return;
        }
        const now = new Date(); // Current time (UTC)

        // --- Fix logging format here ---
        let formattedLocalNow = 'N/A';
         try {
            // Use Luxon for consistency if preferred, or keep Intl
             formattedLocalNow = DateTime.now().setZone(TIME_ZONE).toFormat('yyyy-MM-dd HH:mm:ss');
         } catch (formatError) {
             console.error("Error formatting current time with Luxon:", formatError);
             formattedLocalNow = now.toISOString() + ' (UTC fallback)';
         }
         // --- Use backticks for interpolation ---
        console.log(`\n🕒 Checking for due reminders at <span class="math-inline">\{formattedLocalNow\} \(</span>{TIME_ZONE})`);
        // -------------------------------------

        let dueReminders = [];
        try {
             dueReminders = await collection.find({
                executeAt: { $lte: now },
                status: 'pending'
            }).toArray();

             if (dueReminders.length > 0) {
                 console.log(`✅ Found ${dueReminders.length} due reminder(s).`);
             } else {
                // Optional: Log when no reminders are found
                // console.log("   No due reminders found this minute.");
             }

             // --- Enhanced Logging inside the loop ---
             for (const reminder of dueReminders) {
                 console.log(`   ➡️ Processing reminder ID: ${reminder._id} for user ${reminder.to}`);
                 try {
                     console.log(`      💬 Attempting to send reminder message: "${reminder.message}"`);
                     // Make sure sendWhatsAppMessage is robust or add its own internal logging
                     await sendWhatsAppMessage(reminder.to, reminder.message);
                     console.log(`      ✅ Successfully sent reminder message for ID: ${reminder._id}`);

                     // Option 1: Delete after sending
                     console.log(`      🗑️ Attempting to delete reminder ID: ${reminder._id}`);
                     const deleteResult = await collection.deleteOne({ _id: reminder._id });
                      if (deleteResult.deletedCount === 1) {
                          console.log(`      ✅ Successfully deleted reminder ID: ${reminder._id}`);
                      } else {
                          console.warn(`      ⚠️ Warning: Reminder ID ${reminder._id} was found but delete operation removed ${deleteResult.deletedCount} documents.`);
                      }

                     // Option 2: Update status instead of deleting (alternative approach)
                     /*
                     console.log(`      🔄 Attempting to update status for reminder ID: ${reminder._id}`);
                     const updateResult = await collection.updateOne(
                         { _id: reminder._id },
                         { $set: { status: 'sent', sentAt: new Date() } }
                     );
                     if (updateResult.modifiedCount === 1) {
                         console.log(`      ✅ Successfully updated status for reminder ID: ${reminder._id}`);
                     } else {
                          console.warn(`      ⚠️ Warning: Reminder ID ${reminder._id} was found but update operation modified ${updateResult.modifiedCount} documents.`);
                     }
                     */

                 } catch (processingError) {
                     // Log errors specific to processing this single reminder
                     console.error(`      ❌ Error processing reminder ID ${reminder._id}:`, processingError);
                     // Decide if you want to update status to 'failed' here
                     /*
                     try {
                         await collection.updateOne(
                             { _id: reminder._id },
                             { $set: { status: 'failed', errorAt: new Date(), errorMessage: processingError.message } }
                         );
                         console.log(`      ❗ Marked reminder ID ${reminder._id} as failed.`);
                     } catch (updateError) {
                          console.error(`      ❌❌ Critical: Failed to even mark reminder ID ${reminder._id} as failed:`, updateError);
                     }
                     */
                 }
             }
             // ------------------------------------------

        } catch (dbError) {
            console.error("❌ Error fetching or processing reminders from database:", dbError);
        }
    });
    console.log('✅ Reminder Processor scheduled to run every minute.');
}

module.exports = { addReminder, initializeReminderProcessor };
