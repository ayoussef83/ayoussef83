// routes/webhook.js (Modified to use OpenAI for parsing)
const express = require('express');
// Import BOTH functions from utils/openai now
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
const { DateTime } = require('luxon');

const router = express.Router();

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = 'Africa/Cairo'; // Ensure consistency

// --- Verification Endpoint --- (Keep as is)
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

// --- Message Handler Endpoint ---
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('------------------------------');

    try { // Outer try block
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from;

            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim();

                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- MODIFIED LOGIC STARTS HERE ---
                    const reminderKeyword = "ذكرني"; // Can be expanded later
                    let reminderProcessed = false; // Flag to track if we handled it

                    // Check if message starts with the keyword (case-insensitive)
                    if (msg_body.toLowerCase().startsWith(reminderKeyword.toLowerCase())) {
                        console.log("ℹ️ Potential reminder command. Parsing with OpenAI...");
                        reminderProcessed = true; // Mark as handled (even if parsing fails)

                        // Call the new OpenAI parsing function
                        const parsedReminder = await parseReminderWithOpenAI(msg_body);

                        // Check if parsing was successful and returned valid data
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                            const { reminder_text, local_datetime_iso } = parsedReminder;
                            console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);

                            // Validate and process the parsed time string using Luxon
                            try {
                                const formatString = 'yyyy-MM-dd HH:mm'; // The format OpenAI should return
                                const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });

                                if (!localDateTime.isValid) {
                                    // Handle cases where OpenAI returns a badly formatted string despite instructions
                                    console.warn(`⚠️ Failed to validate date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                    await sendWhatsAppMessage(from, `معلش، فهمت التذكير لكن معرفتش أظبط الوقت اللي رجع من التحليل: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة تانية أو الصيغة الدقيقة: YYYY-MM-DD HH:MM`);
                                } else {
                                    // Convert to UTC for storage and comparison
                                    const executeAtUtc = localDateTime.toUTC();
                                    const nowUtc = DateTime.utc();

                                    // Check if the time is in the past (allow a small buffer like 1 minute)
                                    if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                        console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                        await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                    } else {
                                        // Convert valid future time to JS Date for MongoDB
                                        const executeAtUtcDate = executeAtUtc.toJSDate();
                                        // Call addReminder to save to DB
                                        await addReminder(from, reminder_text, executeAtUtcDate);

                                        // Send confirmation back to user
                                        const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); // e.g., 2025-04-05 05:00 PM
                                        await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                        console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                    }
                                }
                            } catch (validationError) {
                                // Catch errors during Luxon parsing/validation
                                console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                                await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                            }

                        } else {
                            // OpenAI parsing failed (returned null)
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي: YYYY-MM-DD HH:MM ؟");
                        }
                    } // End if (msg_body.startsWith(reminderKeyword))

                    // If the message wasn't identified and processed as a reminder, treat it as a general query
                    if (!reminderProcessed) {
                        console.log("💬 Message not a reminder, sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Optionally send a fallback message
                            // await sendWhatsAppMessage(from, "معلش، مش قادر أرد دلوقتي.");
                        }
                    }
                    // --- MODIFIED LOGIC ENDS HERE ---

                } else { // else for if(msg_body && from)
                    console.warn("⚠️ Webhook received empty message body or missing sender number.");
                }
            } else { // else for if (message.type === 'text')
                console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
                // Optionally reply for non-text messages
                // await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس.");
            }
        } else { // else for if (value?.messaging_product === 'whatsapp' ...)
            console.log('✅ Received event is not an incoming WhatsApp message or structure is different.');
        }

        // Acknowledge receipt to Meta quickly (important!)
        res.sendStatus(200);

    } // End Outer Try
    catch (err) { // Outer Catch block
        console.error("❌ Unexpected error in POST /webhook handler:", err);
        // Still acknowledge to prevent Meta from retrying the same broken event
        if (!res.headersSent) { // Avoid error if already sent status
             res.sendStatus(200);
        }
    }
});

module.exports = router;
