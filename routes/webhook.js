// routes/webhook.js (Using Luxon for date/time parsing and handling)
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
// --- استدعاء Luxon ---
const { DateTime } = require('luxon');
// ---------------------
require('dotenv').config();

const router = express.Router();

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = 'Africa/Cairo'; // Luxon uses IANA timezone names

// --- Verification Endpoint (GET /webhook) ---
router.get('/', (req, res) => {
    // ... (Verification code remains the same) ...
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
         if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
             console.log('✅ Webhook verified');
             res.status(200).send(challenge);
         } else { res.sendStatus(403); }
    } else { res.sendStatus(400); }
});

// --- Message Handler Endpoint (POST /webhook) ---
router.post('/', async (req, res) => {
    console.log('Received webhook event:', JSON.stringify(req.body, null, 2));
    try {
        // ... (Webhook parsing remains the same) ...
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
                            const timeString = parts[1].trim(); // e.g., "2025-04-04 08:30"

                            if (reminderMessage && timeString) {
                                isReminder = true;
                                console.log(`Attempting to parse reminder: "<span class="math-inline">\{reminderMessage\}" at "</span>{timeString}" using Luxon`);
                                try {
                                    // **** بداية التغيير: استخدام Luxon للتحليل ****
                                    const formatString = 'yyyy-MM-dd HH:mm';
                                    // تحليل النص مع تحديد المنطقة الزمنية المدخلة (مصر) والصيغة
                                    const localDateTime = DateTime.fromFormat(timeString, formatString, { zone: TIME_ZONE });

                                    if (!localDateTime.isValid) {
                                        console.log(`Failed to parse date string "${timeString}" with format ${formatString} using Luxon. Reason: ${localDateTime.invalidReason}`);
                                        await sendWhatsAppMessage(from, `معلش، مقدرتش أفهم صيغة الوقت والتاريخ دي: "${timeString}". السبب: ${localDateTime.invalidReason}. جرب صيغة yyyy-MM-dd HH:mm`);
                                    } else {
                                        // تحويل التاريخ لـ UTC (Luxon بيعمل ده بسهولة)
                                        const executeAtUtc = localDateTime.toUTC();
                                        const nowUtc = DateTime.utc(); // الوقت الحالي بـ UTC باستخدام Luxon

                                        // مقارنة التواريخ باستخدام Luxon
                                        if (executeAtUtc <= nowUtc) {
                                            console.log("Reminder time is in the past.");
                                            await sendWhatsAppMessage(from, `الوقت اللي حددته (${timeString}) عدى خلاص! لو سمحت حدد وقت في المستقبل.`);
                                        } else {
                                            // تحويل تاريخ UTC إلى كائن Date عادي عشان نحفظه في MongoDB
                                            const executeAtUtcDate = executeAtUtc.toJSDate();
                                            await addReminder(from, reminderMessage, executeAtUtcDate);

                                            // طباعة الوقت المحلي للتأكيد باستخدام Luxon
                                            const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); // e.g., 2025-04-04 08:30 AM
                                            await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminderMessage}" في الميعاد ده: ${formattedLocalTime}`);
                                        }
                                    }
                                    // **** نهاية التغيير ****
                                } catch (parseOrAddError) {
                                    console.error("Error parsing date/time with Luxon or adding reminder:", parseOrAddError);
                                    await sendWhatsAppMessage(from, "حصلت مشكلة وأنا بحاول أفهم الوقت أو أحفظ التذكير ده.");
                                }
                            } else { /*...*/ await sendWhatsAppMessage(from, "صيغة الأمر مش كاملة..."); }
                        } else { /*...*/ await sendWhatsAppMessage(from, "صيغة الأمر مش مظبوطة..."); }
                    }

                    if (!isReminder) {
                        console.log("Message is not a reminder, sending to OpenAI...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) { await sendWhatsAppMessage(from, aiReply); }
                    }
                } /* ... */
            } /* ... */
        } /* ... */
        res.sendStatus(200);
    } catch (err) {
         console.error("Error in POST /webhook handler:", err);
         // نبعت 200 دايماً عشان نتجنب إن Meta تعيد إرسال نفس الطلب لو حصل أي خطأ
         res.sendStatus(200);
    }
});

module.exports = router;
