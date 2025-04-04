// routes/webhook.js (Complete - Cleaned Requires & Includes History Logging)

// --- Core Dependencies ---
const express = require('express');
const { DateTime } = require('luxon'); // Used for direct time query handling

// --- Utilities & Helpers ---
// *** تأكد إن المسارات دي صحيحة بالنسبة لمكان ملف webhook.js عندك ***
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
// السطر التالي هو المهم لحل مشكلة getDb is not a function هنا
const { getDb } = require('../utils/database'); // <--- تأكد إن ده المسار الصح لملف database.js
const { addReminder } = require('../scheduler/reminderQueue'); // تأكد من مسار هذا الملف أيضاً

// --- Initialize Express Router ---
const router = express.Router();

// --- Load configuration from Environment Variables ---
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo'; // Default timezone

// --- Verification Endpoint (GET /webhook) ---
// Handles the initial challenge from Meta/WhatsApp to verify the webhook URL
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Received GET /webhook verification request:');
    console.log(`Mode: ${mode}, Token: ${token ? '******' : 'Not provided'}, Challenge: ${challenge}`); // Avoid logging token

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
// Main endpoint to process incoming messages and events from WhatsApp
// Marked 'async' to allow using 'await' inside
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    // Log only the essential parts or use structured logging in production to avoid excessive log size
    // console.log(JSON.stringify(req.body, null, 2));
    console.log(`Webhook received: Object='${req.body.object}', Entry Count=${req.body.entry?.length}`);
    console.log('------------------------------');

    try { // Main try block for the entire request processing
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Check if it's a valid incoming WhatsApp message event
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // Sender's WhatsApp ID (phone number)

            // Process only text messages
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim(); // Get message text

                // Ensure message body and sender ID exist
                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- Log incoming user message to DB ---
                    // Make sure getDb was required correctly above
                    try {
                        const db = getDb(); // Get database instance
                        if (db) {
                            const historyCollection = db.collection('message_history');
                            await historyCollection.insertOne({
                                conversationId: from,
                                role: 'user',
                                content: msg_body,
                                timestamp: new Date() // Use current server time
                            });
                            console.log("📝 User message saved to history.");
                        } else {
                            console.warn("⚠️ DB instance not available, cannot save user message history.");
                        }
                    } catch (dbError) {
                        console.error("❌ Error saving user message to history:", dbError);
                        // Currently continues processing even if logging fails
                    }
                    // --- End Logging Incoming Message ---

                    // --- Message Processing Logic ---
                    let reminderProcessed = false;
                    let handledSpecifically = false;
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase();
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        lowerMsgBody.startsWith(keyword.toLowerCase())
                    );

                    // 1. Check Reminders
                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected potential reminder command. Parsing with OpenAI...`);
                        reminderProcessed = true;
                        const parsedReminder = await parseReminderWithOpenAI(msg_body);
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                           const { reminder_text, local_datetime_iso } = parsedReminder;
                           console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);
                           try {
                               const formatString = 'yyyy-MM-dd HH:mm';
                               const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });
                               if (!localDateTime.isValid) {
                                   console.warn(`⚠️ Failed validation for date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
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
                    } // End reminder check

                    // 2. Check Specific Queries (Time)
                    if (!reminderProcessed) {
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                            console.log("ℹ️ Detected time query. Handling directly.");
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            await sendWhatsAppMessage(from, replyMsg); // This will log the reply
                            handledSpecifically = true;
                        }
                        // Add other 'else if' here if needed
                    }

                    // 3. Fallback General Reply
                    if (!reminderProcessed && !handledSpecifically) {
                        console.log("💬 Message not handled above, sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply); // This will log the reply
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Optionally send fallback
                        }
                    }
                    // --- End Message Processing Logic ---

                } else {
                    console.warn("⚠️ Webhook received empty message body or missing sender number.");
                }
            } else {
                console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
            }
        } else {
            console.log('✅ Received event is not an incoming WhatsApp message or has an unexpected structure.');
        }

        // IMPORTANT: Acknowledge receipt to Meta quickly
        if (!res.headersSent) {
            res.sendStatus(200);
        }

    } catch (err) { // Outer Catch block
        console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
        if (!res.headersSent) {
             res.sendStatus(200);
        }
    }
}); // End of router.post('/')

// Export the router
module.exports = router;
