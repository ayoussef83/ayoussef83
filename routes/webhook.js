// routes/webhook.js (Using Luxon, fixed logging)
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
const { DateTime } = require('luxon');

// No need for dotenv.config() here if called in index.js

const router = express.Router();

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = 'Africa/Cairo'; // IANA timezone name

// --- Verification Endpoint (GET /webhook) ---
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ Webhook verified');
            res.status(200).send(challenge);
        } else {
            console.log('❌ Webhook verification failed - Incorrect Token');
            res.sendStatus(403);
        }
    } else {
        console.log('❌ Webhook verification failed - Missing mode or token');
        res.sendStatus(400);
    }
});

// --- Message Handler Endpoint (POST /webhook) ---
router.post('/', async (req, res) => {
    // Log the entire incoming payload for debugging (can be removed later)
    console.log('\n--- Incoming Webhook Event ---');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('------------------------------');

    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Ensure it's a WhatsApp message event
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // Sender phone number

            // Process only text messages for now
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim();

                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // Reminder logic
                    const reminderPrefix = "ذكرني:";
                    const timePrefix = "في:";
                    let isReminder = false;

                    if (msg_body.startsWith(reminderPrefix)) {
                        const parts = msg_body.substring(reminderPrefix.length).split(timePrefix);
                        if (parts.length === 2) {
                            const reminderMessage = parts[0].trim();
                            const timeString = parts[1].trim(); // e.g., "2025-04-04 08:30"

                            if (reminderMessage && timeString) {
                                isReminder = true;
                                console.log(`⏳ Attempting to parse reminder: "${reminderMessage}" at "${timeString}" using Luxon`);
                                try {
                                    const formatString = 'yyyy-MM-dd HH:mm'; // Define expected format
                                    // Parse using Luxon, assuming input is in Egypt time
                                    const localDateTime = DateTime.fromFormat(timeString, formatString, { zone: TIME_ZONE });

                                    if (!localDateTime.isValid) {
                                        console.warn(`⚠️ Failed to parse date string "${timeString}" with format ${formatString}. Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                        await sendWhatsAppMessage(from, `معلش، مقدرتش أفهم صيغة الوقت والتاريخ دي: "${timeString}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة زي: YYYY-MM-DD HH:MM (مثال: 2025-04-05 14:30)`);
                                    } else {
                                        // Convert to UTC for storage/comparison
                                        const executeAtUtc = localDateTime.toUTC();
                                        const nowUtc = DateTime.utc();

                                        if (executeAtUtc <= nowUtc) {
                                            console.warn("⚠️ Reminder time is in the past.");
                                            await sendWhatsAppMessage(from, `الوقت اللي حددته (${timeString}) عدى خلاص! لو سمحت حدد وقت في المستقبل.`);
                                        } else {
                                            // Convert Luxon DateTime object to native JS Date for MongoDB
                                            const executeAtUtcDate = executeAtUtc.toJSDate();
                                            // Call the addReminder function (which handles DB insertion)
                                            await addReminder(from, reminderMessage, executeAtUtcDate);

                                            // Send confirmation using formatted local time
                                            const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a');
                                            await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminderMessage}" في الميعاد ده: ${formattedLocalTime}`);
                                            console.log(`✅ Reminder successfully parsed and scheduled for ${from}.`);
                                        }
                                    }
                                } catch (parseOrAddError) {
                                    console.error("❌ Error during reminder parsing or adding:", parseOrAddError);
                                    await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أحفظ التذكير ده. حاول تاني لو سمحت.");
                                }
                            } else {
                                 console.warn("⚠️ Reminder command format incorrect (missing 'في:').");
                                 // Send OpenAI response for malformed reminder for now, or a specific error
                                 // await sendWhatsAppMessage(from, "صيغة الأمر مش مظبوطة. لازم تكتب 'ذكرني: [الرسالة] في: [الوقت]'");
                                 isReminder = false; // Treat as normal message if format is wrong
                            }
                        }

                        // If it wasn't processed as a reminder, send to OpenAI
                        if (!isReminder) {
                            console.log("💬 Message is not a reminder command or failed parsing, sending to OpenAI...");
                            const aiReply = await getReplyFromOpenAI(msg_body);
                            if (aiReply) {
                                await sendWhatsAppMessage(from, aiReply);
                            } else {
                                console.warn("⚠️ No reply generated by OpenAI.");
                                // Optionally send a default message if OpenAI fails
                                // await sendWhatsAppMessage(from, "معلش، مش قادر أرد دلوقتي.");
                            }
                        }
                    } else {
                        console.warn("⚠️ Webhook received empty message body or missing sender number.");
                    }
                } else {
                    // Log non-text messages
                    console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
                    // Optionally send a default reply
                    // await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس.");
                }
            } else {
                // Log other events (like status updates) if needed, but ignore for processing
                console.log('✅ Received event is not an incoming WhatsApp message.');
            }

            // Acknowledge receipt to Meta quickly
            res.sendStatus(200);

        } catch (err) {
            // Catch unexpected errors in the main handler
            console.error("❌ Unexpected error in POST /webhook handler:", err);
            // Still send 200 OK to Meta to prevent retries for this specific event
            res.sendStatus(200);
        }
    });

    module.exports = router;

    ```
---

**9. `scheduler/reminderQueue.js` (جوه فولدر `scheduler`)**
```javascript
// scheduler/reminderQueue.js (Using Luxon for logging in addReminder, native Intl in job)
const schedule = require('node-schedule');
const { getRemindersCollection } = require('../utils/database');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { DateTime } = require('luxon'); // Use Luxon for formatting in addReminder

const TIME_ZONE = 'Africa/Cairo'; // IANA timezone name

/**
 * Adds a new reminder to the database.
 * @param {string} to - Recipient's WhatsApp ID
 * @param {string} message - Reminder message text
 * @param {Date} executeAt - Date object (in UTC) when the reminder should be sent
 */
async function addReminder(to, message, executeAt) {
    try {
        const collection = getRemindersCollection(); // Assumes DB is connected
        if (!collection) {
            console.error("❌ Cannot add reminder: Reminders collection is not available (DB not connected?).");
            return;
        }
        if (!(executeAt instanceof Date) || isNaN(executeAt.getTime())) {
             console.error("❌ Cannot add reminder: Invalid executeAt date provided to addReminder:", executeAt);
             return;
        }

        console.log(`➕ Adding reminder to DB: User=${to}, TimeUTC=${executeAt.toISOString()}`);
        const result = await collection.insertOne({
            to,
            message,
            executeAt, // Store as BSON Date (UTC)
            createdAt: new Date(),
            status: 'pending'
        });

        // Log the scheduled time in local timezone using Luxon
        let formattedLocalTime = 'N/A';
        try {
            formattedLocalTime = DateTime.fromJSDate(executeAt, { zone: 'utc' }) // Explicitly state input is UTC
                                      .setZone(TIME_ZONE) // Convert to target timezone
                                      .toFormat('yyyy-MM-dd hh:mm:ss a ZZZZ'); // Format
        } catch (formatError) {
             console.error("Error formatting reminder time for logging with Luxon:", formatError);
             formattedLocalTime = executeAt.toISOString() + ' (UTC)'; // Fallback
        }
        console.log(`📥 Reminder added successfully with DB ID: ${result.insertedId}. Scheduled for (Local): ${formattedLocalTime}`);

    } catch (error) {
        console.error(`❌ Error adding reminder to database for user ${to}:`, error);
    }
}

/**
 * Initializes the reminder processing job using node-schedule.
 */
function initializeReminderProcessor() {
    console.log('🕒 Initializing Reminder Processor...');

    // Schedule job to run every minute
    const job = schedule.scheduleJob('*/1 * * * *', async () => {
        const collection = getRemindersCollection(); // Assumes DB is connected
        if (!collection) {
            console.error("❌ Scheduler check skipped: DB collection not available.");
            return;
        }

        const now = new Date(); // Current time in UTC

        // Log check time using native Intl for reliability inside the job
        let formattedLocalNow = 'N/A';
         try {
             const options = { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
             formattedLocalNow = now.toLocaleString('en-CA', options).replace(',','');
         } catch (intlError) {
             console.error("Error formatting current time with Intl:", intlError);
             formattedLocalNow = now.toISOString() + ' (UTC fallback)';
         }
        console.log(`\n🕒 [Scheduler] Checking for due reminders at ${formattedLocalNow} (${TIME_ZONE})`);

        let dueReminders = [];
        try {
            // Find reminders that are due and still pending
            dueReminders = await collection.find({
                executeAt: { $lte: now }, // executeAt is stored as UTC Date
                status: 'pending'
            }).limit(20) // Add a limit to prevent processing too many at once
              .sort({ executeAt: 1 }) // Process older ones first
              .toArray();

             if (dueReminders.length > 0) {
                 console.log(`[Scheduler] ✅ Found ${dueReminders.length} due reminder(s).`);
             } else {
                 // Optional: Log when nothing is found
                 // console.log("[Scheduler]   No due reminders found.");
             }

             // Process each due reminder sequentially
             for (const reminder of dueReminders) {
                 console.log(`[Scheduler]   ➡️ Processing reminder ID: ${reminder._id} for user ${reminder.to}`);
                 try {
                     console.log(`[Scheduler]      💬 Attempting to send reminder message: "${reminder.message}"`);
                     await sendWhatsAppMessage(reminder.to, reminder.message);
                     console.log(`[Scheduler]      ✅ Successfully sent reminder message for ID: ${reminder._id}`);

                     // --- IMPORTANT: Delete *after* successful send ---
                     try {
                        console.log(`[Scheduler]      🗑️ Attempting to delete reminder ID: ${reminder._id}`);
                        const deleteResult = await collection.deleteOne({ _id: reminder._id });
                         if (deleteResult.deletedCount === 1) {
                             console.log(`[Scheduler]      ✅ Successfully deleted reminder ID: ${reminder._id}`);
                         } else {
                             // This case means the reminder was likely processed and deleted by another instance/run
                             // if the job runs faster than the processing takes, or if there are duplicates (shouldn't happen with _id).
                             console.warn(`[Scheduler]      ⚠️ Warning: Reminder ID ${reminder._id} was due but delete removed ${deleteResult.deletedCount} documents.`);
                         }
                     } catch(deleteError) {
                         console.error(`[Scheduler]      ❌❌ Critical: Failed to DELETE reminder ID ${reminder._id} after sending:`, deleteError);
                         // Consider logging this error more permanently or alerting
                     }
                     // ---------------------------------------------

                 } catch (sendError) {
                     console.error(`[Scheduler]      ❌ Error processing (sending/deleting) reminder ID ${reminder._id}:`, sendError);
                     // Update status to 'failed' instead of deleting, for potential retry/debugging
                     try {
                         console.log(`[Scheduler]      ❗ Attempting to mark reminder ID ${reminder._id} as failed.`);
                         await collection.updateOne(
                             { _id: reminder._id },
                             { $set: { status: 'failed', errorAt: new Date(), errorMessage: sendError.message } }
                         );
                         console.log(`[Scheduler]      ❗ Successfully marked reminder ID ${reminder._id} as failed.`);
                     } catch (updateError) {
                          console.error(`[Scheduler]      ❌❌ Critical: Failed to even mark reminder ID ${reminder._id} as failed after send error:`, updateError);
                     }
                 }
             } // end for loop

        } catch (dbError) {
            console.error("❌ [Scheduler] Error fetching or processing reminders from database:", dbError);
        }
    });

    console.log('✅ Reminder Processor scheduled to run every minute.');
}

module.exports = { addReminder, initializeReminderProcessor };
