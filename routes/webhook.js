// routes/webhook.js (Complete Corrected Version)
const express = require('express');
// Import BOTH functions from utils/openai
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
const { DateTime } = require('luxon');

const router = express.Router();

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = 'Africa/Cairo'; // Ensure consistency

// --- Verification Endpoint (GET /webhook) ---
// This part handles the initial verification from Meta and should remain as is
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
// This is the main function that processes incoming messages
// Notice the "async" keyword here, allowing "await" inside
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    console.log(JSON.stringify(req.body, null, 2)); // Log the full incoming request body
    console.log('------------------------------');

    try { // Outer try block to catch any unexpected errors during processing
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Check if it's a valid WhatsApp message event
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // Sender's WhatsApp ID

            // Process only text messages
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim(); // Get message text and remove whitespace

                // Ensure message body and sender ID are present
                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- Logic to handle reminders vs general chat ---
                    // Define multiple keywords that trigger reminder parsing
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"]; // Add more if needed
                    let reminderProcessed = false; // Flag to track if we handled it as a reminder

                    // Check if the message starts with ANY of the keywords (case-insensitive)
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        msg_body.toLowerCase().startsWith(keyword.toLowerCase())
                    );

                    // If the message starts with one of the reminder keywords
                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected potential reminder command (using '${msg_body.split(' ')[0]}'). Attempting parsing with OpenAI...`);
                        reminderProcessed = true; // Mark as handled (parsing might still fail)

                        // Call the OpenAI function to parse text and time (THIS IS WHERE "await" IS NEEDED AND VALID)
                        const parsedReminder = await parseReminderWithOpenAI(msg_body);

                        // Check if OpenAI successfully parsed the details
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                            const { reminder_text, local_datetime_iso } = parsedReminder;
                            console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);

                            // Validate the time string returned by OpenAI using Luxon
                            try {
                                const formatString = 'yyyy-MM-dd HH:mm'; // The format we expect from OpenAI
                                const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });

                                // Check if Luxon could parse the date string correctly
                                if (!localDateTime.isValid) {
                                    console.warn(`⚠️ Failed to validate date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                    await sendWhatsAppMessage(from, `معلش، فهمت التذكير لكن معرفتش أظبط الوقت اللي رجع من التحليل: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة تانية أو الصيغة الدقيقة: YYYY-MM-DD HH:MM`);
                                } else {
                                    // Convert the valid local time to UTC for storage and scheduling
                                    const executeAtUtc = localDateTime.toUTC();
                                    const nowUtc = DateTime.utc();

                                    // Check if the calculated time is in the past (add a 1-minute buffer)
                                    if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                        console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                        await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                    } else {
                                        // Convert to native JS Date object for MongoDB compatibility
                                        const executeAtUtcDate = executeAtUtc.toJSDate();
                                        // Call the function to save the reminder to the database
                                        await addReminder(from, reminder_text, executeAtUtcDate);

                                        // Send confirmation message to the user
                                        const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); // Format for confirmation message
                                        await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                        console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                    }
                                }
                            } catch (validationError) {
                                // Catch any errors during Luxon date validation/processing
                                console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                                await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                            }

                        } else {
                            // If OpenAI couldn't parse the reminder (returned null)
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي: YYYY-MM-DD HH:MM ؟");
                        }
                    } // End if (startsWithReminderKeyword)

                    // If the message wasn't handled as a reminder (didn't start with a keyword)
                    if (!reminderProcessed) {
                        console.log("💬 Message not a reminder command, sending to OpenAI for general reply...");
                        // Call the general OpenAI reply function
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Optionally send a fallback message
                            // await sendWhatsAppMessage(from, "معلش، مش قادر أرد دلوقتي.");
                        }
                    }
                    // --- End of reminder/general reply logic ---

                } else { // Handles case where message body or sender is missing
                    console.warn("⚠️ Webhook received empty message body or missing sender number.");
                }
            } else { // Handles non-text messages
                console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
                // Optionally reply for non-text messages
                // await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس.");
            }
        } else { // Handles events that are not incoming WhatsApp messages
            console.log('✅ Received event is not an incoming WhatsApp message or has unexpected structure.');
        }

        // IMPORTANT: Always acknowledge receipt to Meta quickly to avoid duplicate events
        // Make sure this is outside any conditional logic that might prevent it from running
        if (!res.headersSent) { // Check if response hasn't already been sent (e.g., by sendStatus(403))
            res.sendStatus(200);
        }

    } catch (err) { // Outer Catch block for unexpected errors
        console.error("❌ Unexpected error in POST /webhook handler:", err);
        // Try to acknowledge receipt even if there was an error
        if (!res.headersSent) {
             res.sendStatus(200); // Acknowledge to prevent Meta retries
        }
    }
});

// Export the router to be used in index.js
module.exports = router;
