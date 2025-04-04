// routes/webhook.js (Complete - Handles Time Query Directly)
const express = require('express');
// Import functions from utils/openai
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
const { DateTime } = require('luxon');

const router = express.Router();

// Load configuration from environment variables
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = 'Africa/Cairo'; // Set your target timezone

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
// This is the main endpoint that receives incoming messages and events from WhatsApp
// It needs to be async to allow using 'await' for API calls and DB operations
router.post('/', async (req, res) => {
    // Log the incoming request body for debugging purposes
    console.log('\n--- Incoming Webhook Event ---');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('------------------------------');

    try { // Start main try block to catch errors during processing
        // Safely access nested properties using optional chaining (?.)
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Check if it's a valid WhatsApp message event
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // Sender's WhatsApp ID (phone number)

            // Process only incoming text messages for now
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim(); // Get message text and remove extra whitespace

                // Ensure we have both the message content and the sender ID
                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- Logic to determine message type (Reminder, Time Query, General) ---
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"]; // Keywords to trigger reminder parsing
                    let reminderProcessed = false; // Flag: Did we attempt to handle this as a reminder?
                    let handledSpecifically = false; // Flag: Did we handle this with specific non-reminder logic?

                    // 1. CHECK FOR REMINDER KEYWORDS
                    // Check if the message starts with any reminder keyword (case-insensitive)
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        msg_body.toLowerCase().startsWith(keyword.toLowerCase())
                    );

                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected potential reminder command (using '${msg_body.split(' ')[0]}'). Attempting parsing with OpenAI...`);
                        reminderProcessed = true; // Mark that we are attempting reminder logic

                        // Call OpenAI to parse the reminder text and time
                        const parsedReminder = await parseReminderWithOpenAI(msg_body);

                        // Check if OpenAI successfully parsed the details
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                            const { reminder_text, local_datetime_iso } = parsedReminder;
                            console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);

                            // Validate the time string using Luxon
                            try {
                                const formatString = 'yyyy-MM-dd HH:mm'; // Expected format from OpenAI
                                const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });

                                if (!localDateTime.isValid) {
                                    // Handle invalid date format from OpenAI
                                    console.warn(`⚠️ Failed to validate date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                    await sendWhatsAppMessage(from, `معلش، فهمت التذكير لكن معرفتش أظبط الوقت اللي رجع من التحليل: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة تانية أو الصيغة الدقيقة: YYYY-MM-DD HH:MM`);
                                } else {
                                    // Convert valid local time to UTC for storage/scheduling
                                    const executeAtUtc = localDateTime.toUTC();
                                    const nowUtc = DateTime.utc();

                                    // Check if time is in the past (allow 1 min buffer)
                                    if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                        console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                        await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                    } else {
                                        // Time is valid and in the future, proceed to save
                                        const executeAtUtcDate = executeAtUtc.toJSDate(); // Convert to JS Date for MongoDB
                                        await addReminder(from, reminder_text, executeAtUtcDate); // Save to DB

                                        // Send confirmation to user
                                        const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); // Format for confirmation
                                        await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                        console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                    }
                                }
                            } catch (validationError) {
                                // Handle errors during Luxon validation/processing
                                console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                                await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                            }
                        } else {
                            // OpenAI failed to parse the reminder details
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي: YYYY-MM-DD HH:MM ؟");
                        }
                    } // End of reminder processing block

                    // 2. CHECK FOR SPECIFIC QUERIES (like "What time is it?")
                    // Only check if it wasn't processed as a reminder attempt
                    if (!reminderProcessed) {
                        const lowerMsg = msg_body.toLowerCase(); // Convert to lowercase once for checks
                        // Check for various ways user might ask for the time
                        if (lowerMsg.includes("الساعة كام") || lowerMsg.includes("الوقت ايه") || lowerMsg === "الوقت") {
                            console.log("ℹ️ Detected time query. Handling directly.");
                            // Get current time using Luxon in the specified timezone
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            // Format the time nicely in Arabic
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' }); // Example: ٠٩:٥٥ صباحاً
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            // Send the time directly back to the user
                            await sendWhatsAppMessage(from, replyMsg);
                            handledSpecifically = true; // Mark that we handled this message
                        }
                        // Add checks for other specific queries here if needed in the future
                        // else if (lowerMsg.includes("التاريخ ايه") || lowerMsg === "التاريخ") { ... }
                    }

                    // 3. FALLBACK TO GENERAL OPENAI REPLY
                    // If the message wasn't a reminder attempt AND wasn't handled by specific logic
                    if (!reminderProcessed && !handledSpecifically) {
                        console.log("💬 Message not a reminder command nor handled specifically, sending to OpenAI for general reply...");
                        // Call the general OpenAI reply function
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Optionally send a fallback if OpenAI fails for general chat
                            // await sendWhatsAppMessage(from, "معلش، مش قادر أرد دلوقتي حاول كمان شوية.");
                        }
                    }
                    // --- End of message processing logic ---

                } else { // Handle cases where message body or sender ID is missing
                    console.warn("⚠️ Webhook received empty message body or missing sender number.");
                }
            } else { // Handle incoming messages that are not text (e.g., image, audio, location)
                console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
                // Optionally send a reply indicating non-text messages aren't processed
                // await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس للأسف.");
            }
        } else { // Handle incoming events that are not standard WhatsApp messages (e.g., status updates)
            console.log('✅ Received event is not an incoming WhatsApp message or has an unexpected structure.');
        }

        // IMPORTANT: Always acknowledge receipt to Meta quickly (within seconds)
        // This prevents Meta from resending the same event thinking it failed.
        // Check if headers haven't been sent already (e.g., by an error response like 403)
        if (!res.headersSent) {
            res.sendStatus(200); // Send HTTP 200 OK
        }

    } catch (err) { // Catch any unexpected errors in the main processing block
        console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
        // Still try to acknowledge receipt to Meta even if our processing failed
        if (!res.headersSent) {
             res.sendStatus(200); // Acknowledge to prevent Meta retries for this event
        }
    }
}); // End of router.post('/')

// Export the configured router to be used by the main application file (index.js)
module.exports = router;
