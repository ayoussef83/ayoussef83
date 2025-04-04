// routes/webhook.js (Complete - Includes History Context for OpenAI Calls)

// --- Core Dependencies ---
const express = require('express');
const { DateTime } = require('luxon'); // Used for direct time query handling

// --- Utilities & Helpers ---
// *** تأكد إن المسارات دي صحيحة 100% بناءً على مكان الملفات عندك ***
// Assuming webhook.js is in 'routes/' and others are in 'utils/' or 'scheduler/' at the same level as 'routes/'
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai'); // Reads prompts & history now
const { sendWhatsAppMessage } = require('../utils/whatsapp'); // Logs outgoing messages now
const { getDb } = require('../utils/database'); // Exports getDb now
const { addReminder } = require('../scheduler/reminderQueue'); // Needs reminderQueue.js in scheduler (adjust path if needed)

// --- Initialize Express Router ---
const router = express.Router();

// --- Load configuration ---
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo'; // Default timezone

// --- GET /webhook (Verification) ---
// Handles the initial challenge from Meta/WhatsApp to verify the webhook URL
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Received GET /webhook verification request:');
    console.log(`Mode: ${mode}, Token: ${token ? '******' : 'Not provided'}, Challenge: ${challenge}`); // Avoid logging sensitive token

    if (mode && token) {
        // Check the mode and token sent are correct
        if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
            // Respond with the challenge token from the request
            console.log('✅ Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            console.log('❌ Webhook verification failed - Incorrect Token');
            res.sendStatus(403);
        }
    } else {
        // Responds with '400 Bad Request' if mode or token are missing
        console.log('❌ Webhook verification failed - Missing mode or token');
        res.sendStatus(400);
    }
});

// --- POST /webhook (Message Handler) ---
// Main endpoint to process incoming messages and events from WhatsApp
// Marked 'async' to allow using 'await' for DB operations and API calls
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    console.log(`Webhook received: Object='${req.body.object}', Entry Count=${req.body.entry?.length}`); // Log basic info
    console.log('------------------------------');

    try { // Main try block to catch any unexpected errors during the whole process
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Check if it's a valid incoming WhatsApp message event from a user
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // User's WhatsApp ID (Used as conversationId)

            // Process only text messages for now
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim(); // Get the message text

                // Ensure message body and sender ID exist
                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- Log incoming user message to DB ---
                    try {
                        const db = getDb(); // Get database instance (requires correct require at top)
                        if (db) {
                            const historyCollection = db.collection('message_history');
                            // Insert user message into history
                            await historyCollection.insertOne({
                                conversationId: from,
                                role: 'user',
                                content: msg_body,
                                timestamp: new Date() // Current server time
                            });
                            console.log("📝 User message saved to history.");
                        } else {
                            // Log warning if DB unavailable during logging attempt
                            console.warn("⚠️ DB instance not available when trying to save user message history.");
                        }
                    } catch (dbError) {
                        // Log error if DB saving fails, but continue processing the message
                        console.error("❌ Error saving user message to history:", dbError);
                    }
                    // --- End Logging Incoming Message ---

                    // --- Message Processing Logic ---
                    let reminderProcessed = false; // Flag: Was it handled as a reminder attempt?
                    let handledSpecifically = false; // Flag: Was it handled by specific logic (e.g., time query)?

                    // 1. Check for Reminder Keywords
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase(); // Convert message to lowercase once for checks
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        lowerMsgBody.startsWith(keyword.toLowerCase())
                    );

                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected reminder keyword. Parsing with OpenAI (including history)...`);
                        reminderProcessed = true; // Mark as attempted reminder processing

                        // --- Call OpenAI parser, now passing 'from' for history context ---
                        const parsedReminder = await parseReminderWithOpenAI(msg_body, from);

                        // Check if OpenAI returned valid structured data
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                           // --- Process Valid Parsed Reminder ---
                           const { reminder_text, local_datetime_iso } = parsedReminder;
                           console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);
                           try {
                               // Validate the parsed date string using Luxon
                               const formatString = 'yyyy-MM-dd HH:mm';
                               const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });

                               if (!localDateTime.isValid) {
                                   console.warn(`⚠️ Failed validation for date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                   // Inform user about the parsing/validation issue
                                   await sendWhatsAppMessage(from, `معلش، فهمت التذكير لكن معرفتش أظبط الوقت اللي رجع من التحليل: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة تانية أو الصيغة الدقيقة:<y_bin_46>-MM-DD HH:MM`);
                               } else {
                                   // Convert to UTC and check if it's in the past
                                   const executeAtUtc = localDateTime.toUTC();
                                   const nowUtc = DateTime.utc();
                                   // Add a small buffer (e.g., 1 minute) to avoid rejecting times that are exactly now or just slightly in the future
                                   if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                       console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                       await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                   } else {
                                       // Time is valid and in the future, save reminder
                                       const executeAtUtcDate = executeAtUtc.toJSDate(); // Convert to JS Date for MongoDB
                                       await addReminder(from, reminder_text, executeAtUtcDate); // Call function to save to DB
                                       // Send confirmation message
                                       const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a');
                                       await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                       console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                   }
                               }
                           } catch (validationError) {
                               // Catch errors during date validation (e.g., Luxon issues)
                               console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                               await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                           }
                           // --- End Process Valid Parsed Reminder ---
                        } else { // Handle case where OpenAI could not parse confidently
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي:<y_bin_46>-MM-DD HH:MM ؟");
                        }
                    } // End of reminder keyword check

                    // 2. Check for Specific Queries (like "What time is it?")
                    // Only check if it wasn't identified as a reminder attempt
                    if (!reminderProcessed) {
                        // Handle "What time is it?" directly using Luxon for accuracy
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                            console.log("ℹ️ Detected time query. Handling directly.");
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            // Format time with AM/PM in Arabic locale
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            // Send reply (this function call now also logs the bot's reply)
                            await sendWhatsAppMessage(from, replyMsg);
                            handledSpecifically = true; // Mark message as handled
                        }
                        // Add other 'else if' blocks here for different specific hardcoded queries if needed
                        // else if (lowerMsgBody === "التاريخ النهاردة ايه") { ... }
                    }

                    // 3. Fallback to General OpenAI Reply
                    // Only if it wasn't a reminder attempt AND wasn't handled by specific logic
                    if (!reminderProcessed && !handledSpecifically) {
                        console.log("💬 Message not handled above, sending to OpenAI for general reply (including history)...");
                        // --- Call general reply function, passing 'from' for history context ---
                        const aiReply = await getReplyFromOpenAI(msg_body, from);
                        if (aiReply) {
                            // Send the AI's reply (this function call now also logs the bot's reply)
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Optionally send a fallback message if OpenAI fails completely
                            // await sendWhatsAppMessage(from, "آسف، لم أتمكن من الرد الآن.");
                        }
                    }
                    // --- End of Message Processing Logic ---

                } else { console.warn("⚠️ Webhook received empty msg_body or missing sender 'from'."); }
            } else { console.log(`➡️ Received non-text message type: ${message.type} from ${from}`); }
        } else { console.log('✅ Received event is not a standard incoming WhatsApp message.'); }

        // IMPORTANT: Always acknowledge receipt to Meta quickly (within a few seconds)
        if (!res.headersSent) { // Avoid sending status if already sent (e.g., by 403 error)
            res.sendStatus(200); // Send HTTP 200 OK
        }

    } catch (err) { // Catch any unexpected errors in the main processing block
        console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
        // Still try to acknowledge receipt to prevent Meta from resending the same failed event
        if (!res.headersSent) {
             res.sendStatus(200);
        }
    }
}); // End of router.post('/')

// Export the router to be used by the main application file (index.js)
module.exports = router;
