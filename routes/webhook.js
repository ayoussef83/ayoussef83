// routes/webhook.js (Complete - With Incoming Message Logging)
const express = require('express');
// --- تأكد من استدعاء الدوال دي ---
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
const { getDb } = require('../utils/database'); // <--- مهم للداتا بيز
const { DateTime } = require('luxon');
const { getDb } = require('../utils/database.js');
const router = express.Router();

// --- Load configuration from environment variables ---
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo'; // Set your target timezone

// --- Verification Endpoint (GET /webhook) ---
// Handles the initial challenge from Meta/WhatsApp to verify the webhook
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Received GET /webhook verification request:');
    console.log(`Mode: ${mode}, Token: ${token}, Challenge: ${challenge}`);

    if (mode && token) {
        if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            console.log('❌ Webhook verification failed - Incorrect Token');
            res.sendStatus(403); // Forbidden
        }
    } else {
        console.log('❌ Webhook verification failed - Missing mode or token');
        res.sendStatus(400); // Bad Request
    }
});

// --- Message Handler Endpoint (POST /webhook) ---
// Processes incoming messages and events from WhatsApp
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('------------------------------');

    try { // Outer try block
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Check if it's a valid WhatsApp message event
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // Sender's WhatsApp ID

            // Process only incoming text messages
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim();

                // Ensure we have message content and sender ID
                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- <<< NEW: Log incoming user message to DB >>> ---
                    try {
                        const db = getDb(); // Get database instance
                        if (db) {
                            const historyCollection = db.collection('message_history');
                            // Insert the user's message into the history
                            await historyCollection.insertOne({
                                conversationId: from, // Use sender's number as conversation ID
                                role: 'user',         // Role is 'user'
                                content: msg_body,    // The message text
                                timestamp: new Date() // Current timestamp
                            });
                            console.log("📝 User message saved to history.");
                        } else {
                            // Log a warning if DB connection isn't available
                            console.warn("⚠️ Could not get DB instance to save user message history.");
                        }
                    } catch (dbError) {
                        // Log error if saving fails, but continue processing the message
                        console.error("❌ Error saving user message to history:", dbError);
                    }
                    // --- <<< END NEW SECTION >>> ---


                    // --- Logic to handle reminders, time queries, or general chat ---
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    let reminderProcessed = false; // Flag: Was it handled as a reminder attempt?
                    let handledSpecifically = false; // Flag: Was it handled by specific logic?

                    // 1. CHECK FOR REMINDER KEYWORDS
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        msg_body.toLowerCase().startsWith(keyword.toLowerCase())
                    );

                    if (startsWithReminderKeyword) {
                        // ... (Reminder parsing logic using parseReminderWithOpenAI - NO CHANGES HERE) ...
                        console.log(`ℹ️ Detected potential reminder command (using '${msg_body.split(' ')[0]}'). Attempting parsing with OpenAI...`);
                        reminderProcessed = true;
                        const parsedReminder = await parseReminderWithOpenAI(msg_body);
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                           const { reminder_text, local_datetime_iso } = parsedReminder;
                           console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);
                           try {
                               const formatString = 'yyyy-MM-dd HH:mm';
                               const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });
                               if (!localDateTime.isValid) {
                                   console.warn(`⚠️ Failed to validate date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                   await sendWhatsAppMessage(from, `معلش، فهمت التذكير لكن معرفتش أظبط الوقت اللي رجع من التحليل: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة تانية أو الصيغة الدقيقة:<y_bin_46>-MM-DD HH:MM`);
                               } else {
                                   const executeAtUtc = localDateTime.toUTC();
                                   const nowUtc = DateTime.utc();
                                   if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                       console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                       await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                   } else {
                                       const executeAtUtcDate = executeAtUtc.toJSDate();
                                       await addReminder(from, reminder_text, executeAtUtcDate);
                                       const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a');
                                       await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                       console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                   }
                               }
                           } catch (validationError) {
                               console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                               await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                           }
                        } else {
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي:<y_bin_46>-MM-DD HH:MM ؟");
                        }
                    } // End if (startsWithReminderKeyword)

                    // 2. CHECK FOR SPECIFIC QUERIES (like "What time is it?")
                    // Only check if it wasn't processed as a reminder attempt
                    if (!reminderProcessed) {
                        const lowerMsg = msg_body.toLowerCase();
                        if (lowerMsg.includes("الساعة كام") || lowerMsg.includes("الوقت ايه") || lowerMsg === "الوقت") {
                            // ... (Direct time handling logic - NO CHANGES HERE) ...
                            console.log("ℹ️ Detected time query. Handling directly.");
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            await sendWhatsAppMessage(from, replyMsg); // This call will log the reply via the modified function below
                            handledSpecifically = true;
                        }
                        // Add other specific checks here if needed
                    }

                    // 3. FALLBACK TO GENERAL OPENAI REPLY
                    // If it wasn't a reminder AND wasn't handled specifically
                    if (!reminderProcessed && !handledSpecifically) {
                        console.log("💬 Message not a reminder command nor handled specifically, sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            // This call will log the reply via the modified function below
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Handle cases where OpenAI might fail or return nothing
                            // await sendWhatsAppMessage(from, "معلش، مقدرتش أرد على رسالتك دلوقتي.");
                        }
                    }
                    // --- End of message processing logic ---

                } else {
                    console.warn("⚠️ Webhook received empty message body or missing sender number.");
                }
            } else {
                console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
                // Optionally handle non-text messages if needed in the future
            }
        } else {
            console.log('✅ Received event is not an incoming WhatsApp message or has an unexpected structure.');
        }

        // IMPORTANT: Acknowledge receipt to Meta quickly
        if (!res.headersSent) {
            res.sendStatus(200);
        }

    } catch (err) { // Outer Catch block for unexpected errors
        console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
        if (!res.headersSent) {
             res.sendStatus(200); // Still acknowledge if possible
        }
    }
}); // End of router.post('/')

module.exports = router;
