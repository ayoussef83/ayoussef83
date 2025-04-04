// routes/webhook.js (Complete - Cleaned Requires & Includes History Logging)

// --- Core Dependencies ---
const express = require('express');
const { DateTime } = require('luxon'); // Used for direct time query handling

// --- Utilities & Helpers ---
// Assuming utils & scheduler directories are one level up from routes
// Ensure these paths are correct based on your actual project structure
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { getDb } = require('../utils/database'); // <--- Required for DB connection (make sure path is correct)
const { addReminder } = require('../scheduler/reminderQueue'); // Make sure path is correct

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
                        // Decide if you want to stop processing or just log the error
                        // Currently continues processing
                    }
                    // --- End Logging Incoming Message ---

                    // --- Message Processing Logic ---
                    let reminderProcessed = false; // Flag: Was it handled as a reminder attempt?
                    let handledSpecifically = false; // Flag: Was it handled by specific logic?

                    // 1. Check for Reminder Keywords
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase(); // Convert once for efficiency
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        lowerMsgBody.startsWith(keyword.toLowerCase())
                    );

                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected potential reminder command. Parsing with OpenAI...`);
                        reminderProcessed = true;
                        const parsedReminder = await parseReminderWithOpenAI(msg_body);

                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                            // --- Process Valid Parsed Reminder ---
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
                                    if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) { // Check if time is past or too soon
                                        console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                        await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                    } else { // Time is valid and in the future
                                        const executeAtUtcDate = executeAtUtc.toJSDate();
                                        await addReminder(from, reminder_text, executeAtUtcDate); // Save to DB
                                        const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a');
                                        await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                        console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                    }
                                }
                            } catch (validationError) {
                                console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                                await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                            }
                            // --- End Process Valid Parsed Reminder ---
                        } else { // Handle failed OpenAI parsing
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي:<y_bin_46>-MM-DD HH:MM ؟");
                        }
                    } // End of reminder keyword check

                    // 2. Check for Specific Queries (like "What time is it?")
                    // Only check if it wasn't identified as a reminder attempt
                    if (!reminderProcessed) {
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                            console.log("ℹ️ Detected time query. Handling directly.");
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            await sendWhatsAppMessage(from, replyMsg); // This call will also log the bot reply
                            handledSpecifically = true; // Mark as handled
                        }
                        // Add other 'else if' blocks here for different specific queries if needed
                    }

                    // 3. Fallback to General OpenAI Reply
                    // Only if it wasn't a reminder attempt AND wasn't handled by specific logic
                    if (!reminderProcessed && !handledSpecifically) {
                        console.log("💬 Message not a reminder command nor handled specifically, sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply); // This call will also log the bot reply
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Optionally send a fallback message if OpenAI fails completely
                            // await sendWhatsAppMessage(from, "آسف، لم أتمكن من معالجة طلبك الآن.");
                        }
                    }
                    // --- End of Message Processing Logic ---

                } else { // Handle case where msg_body or from is missing
                    console.warn("⚠️ Webhook received empty message body or missing sender number.");
                }
            } else { // Handle non-text messages
                console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
                // Optionally send a reply for non-text messages
                // await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس.");
            }
        } else { // Handle other webhook events (like status updates, which don't need processing here)
            console.log('✅ Received event is not an incoming WhatsApp message or has an unexpected structure.');
        }

        // IMPORTANT: Acknowledge receipt to Meta quickly (within seconds)
        if (!res.headersSent) { // Check if a response hasn't already been sent
            res.sendStatus(200); // Send HTTP 200 OK
        }

    } catch (err) { // Catch any unexpected errors in the main processing block
        console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
        // Attempt to acknowledge receipt even if there was an error to prevent Meta retries
        if (!res.headersSent) {
             res.sendStatus(200);
        }
    }
}); // End of router.post('/')

// Export the router to be used in the main application file (e.g., index.js)
module.exports = router;
