// routes/webhook.js (Workaround: Use dot notation for date-fns-tz)
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
// --- التغيير هنا: استدعاء المكتبة كلها ---
const dateFnsTz = require('date-fns-tz');
// ---------------------------------------
require('dotenv').config();

const router = express.Router();

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = 'Africa/Cairo';

// --- Verification Endpoint (GET /webhook) ---
router.get('/', (req, res) => {
    // ... (Code remains the same) ...
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
         if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ Webhook verified');
            res.status(200).send(challenge);
        } else { /*...*/ res.sendStatus(403); }
    } else { /*...*/ res.sendStatus(400); }
});

// --- Message Handler Endpoint (POST /webhook) ---
router.post('/', async (req, res) => {
    console.log('Received webhook event:', JSON.stringify(req.body, null, 2));
    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from;

            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim();
                if (msg_body && from) {
                    console.log(`📩 New text message from ${from}: ${msg_body}`);

                    const reminderPrefix = "ذكرني:";
                    const timePrefix = "في:";
                    let isReminder = false;

                    if (msg_body.startsWith(reminderPrefix)) {
                        const parts = msg_body.substring(reminderPrefix.length).split(timePrefix);
                        if (parts.length === 2) {
                            const reminderMessage = parts[0].trim();
                            const timeString = parts[1].trim();

                            if (reminderMessage && timeString) {
                                isReminder = true;
                                // --- إصلاح الـ Log هنا ---
                                console.log(`Attempting to parse reminder: "<span class="math-inline">\{reminderMessage\}" at "</span>{timeString}"`);
                                // ------------------------
                                try {
                                    const formatString = 'yyyy-MM-dd HH:mm';
                                    // --- التغيير هنا: استخدام dateFnsTz.parse ---
                                    let parsedDate = dateFnsTz.parse(timeString, formatString, new Date(), { timeZone: TIME_ZONE });

                                    // --- التغيير هنا: استخدام dateFnsTz.isValid ---
                                    if (!dateFnsTz.isValid(parsedDate)) {
                                    // ------------------------------------------
                                        console.log(`Failed to parse date string "${timeString}" with format ${formatString}`);
                                        await sendWhatsAppMessage(from, `معلش، مقدرتش أفهم صيغة الوقت والتاريخ دي: "${timeString}". جرب تكتبها بصيغة زي YYYY-MM-DD HH:MM (مثال: 2025-04-04 14:00 للساعة 2 الضهر).`);
                                    } else {
                                        // --- التغيير هنا: استخدام dateFnsTz.zonedTimeToUtc ---
                                        const executeAtUtc = dateFnsTz.zonedTimeToUtc(parsedDate, TIME_ZONE);
                                        // -------------------------------------------------
                                        const nowUtc = new Date();

                                        if (executeAtUtc <= nowUtc) {
                                            console.log("Reminder time is in the past.");
                                            await sendWhatsAppMessage(from, `الوقت اللي حددته (${timeString}) عدى خلاص! لو سمحت حدد وقت في المستقبل.`);
                                        } else {
                                            await addReminder(from, reminderMessage, executeAtUtc);
                                            // --- التغيير هنا: استخدام dateFnsTz.format ---
                                            const formattedLocalTime = dateFnsTz.format(parsedDate, 'yyyy-MM-dd hh:mm a', { timeZone: TIME_ZONE });
                                            // -------------------------------------------
                                            await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminderMessage}" في الميعاد ده: ${formattedLocalTime}`);
                                        }
                                    }
                                } catch (parseError) {
                                    console.error("Error parsing date/time or adding reminder:", parseError);
                                    await sendWhatsAppMessage(from, "حصلت مشكلة وأنا بحاول أفهم الوقت أو أحفظ التذكير ده."); // الرسالة اللي وصلتلك
                                }
                            } else { /*...*/ await sendWhatsAppMessage(from, "صيغة الأمر مش كاملة..."); }
                        } else { /*...*/ await sendWhatsAppMessage(from, "صيغة الأمر مش مظبوطة..."); }
                    }

                    if (!isReminder) {
                        console.log("Message is not a reminder, sending to OpenAI...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) { /*...*/ await sendWhatsAppMessage(from, aiReply); }
                    }
                } /* ... */
            } /* ... */
        } /* ... */
        res.sendStatus(200);
    } catch (err) { /* ... */ res.sendStatus(200); }
});

module.exports = router;
