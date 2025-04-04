// routes/webhook.js (Corrected version with missing brace added)
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
const { DateTime } = require('luxon');

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

    try { // <<<< OUTER TRY BLOCK STARTS HERE
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
                                try { // Inner try for parsing/adding
                                    const formatString = 'yyyy-MM-dd HH:mm'; // Define expected format
                                    // Parse using Luxon, assuming input is in Egypt time
                                    const localDateTime = DateTime.fromFormat(timeString, formatString, { zone: TIME_ZONE });

                                    if (!localDateTime.isValid) {
                                        console.warn(`⚠️ Failed to parse date string "${timeString}" with format ${formatString}. Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                        await sendWhatsAppMessage(from, `معلش، مقدرتش أفهم صيغة الوقت والتاريخ دي: "${timeString}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة زي: yyyy-MM-dd HH:mm (مثال: 2025-04-05 14:30)`);
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
                                } catch (parseOrAddError) { // Inner catch
                                    console.error("❌ Error during reminder parsing or adding:", parseOrAddError);
                                    await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أحفظ التذكير ده. حاول تاني لو سمحت.");
                                }
                            } else { // else for if(reminderMessage && timeString)
                                console.warn("⚠️ Reminder command format incorrect (split failed?).");
                                isReminder = false; // Treat as normal message if format is wrong
                            }
                        } else { // else for if(parts.length === 2)
                            console.warn("⚠️ Reminder command format incorrect (missing 'في:').");
                            isReminder = false; // Treat as normal message if format is wrong
                        }
                    } // End if (msg_body.startsWith(reminderPrefix))

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
                } else { // else for if(msg_body && from)
                    console.warn("⚠️ Webhook received empty message body or missing sender number.");
                }
            } else { // else for if (message.type === 'text')
                // Log non-text messages
                console.log(`➡️ Received non-text message type: ${message.type} from ${from}`);
                // Optionally send a default reply
                // await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس.");
            }
        } else { // else for if (value?.messaging_product === 'whatsapp' ...)
            // Log other events (like status updates) if needed, but ignore for processing
            console.log('✅ Received event is not an incoming WhatsApp message.');
        }

        // Acknowledge receipt to Meta quickly
        res.sendStatus(200);

    } // <<<< ***** THE MISSING BRACE WAS ADDED HERE ***** End of OUTER TRY block
    catch (err) { // <<<< OUTER CATCH BLOCK STARTS HERE
        // Catch unexpected errors in the main handler
        console.error("❌ Unexpected error in POST /webhook handler:", err);
        // Still send 200 OK to Meta to prevent retries for this specific event
        res.sendStatus(200);
    }
});

module.exports = router;
