// routes/webhook.js (Workaround: Use native Date parsing, then date-fns-tz for UTC conversion)
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue');
// لا نحتاج استدعاء parse, isValid من هنا
// const { parse, zonedTimeToUtc, format, isValid } = require('date-fns-tz');
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
        // ... (Parsing webhook payload remains the same) ...
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
                                console.log(`Attempting to parse reminder: "<span class="math-inline">\{reminderMessage\}" at "</span>{timeString}"`);
                                try {
                                    // **** بداية التغيير: استخدام new Date() للتحليل ****
                                    // استبدال أول مسافة بحرف T قد يساعد بعض المحركات على فهمها كتوقيت محلي
                                    const potentialDateString = timeString.replace(' ', 'T');
                                    const parsedDate = new Date(potentialDateString); // Native Date parsing
                                    // **** نهاية التغيير ****

                                    // التحقق باستخدام isNaN
                                    if (isNaN(parsedDate.getTime())) {
                                        console.log(`Failed to parse date string "${timeString}" using native new Date().`);
                                        await sendWhatsAppMessage(from, `معلش، مقدرتش أفهم صيغة الوقت والتاريخ دي: "${timeString}". جرب تكتبها بصيغة YYYY-MM-DD HH:MM.`);
                                    } else {
                                        // **** بداية التغيير: لو التحليل نجح، نستخدم date-fns-tz للتحويل لـ UTC ****
                                        let executeAtUtc;
                                        let dateFnsTz;
                                        try {
                                             // نحاول نعمل require هنا عشان نستخدمها للتحويل فقط
                                             dateFnsTz = require('date-fns-tz');
                                             // نفترض أن التاريخ المدخل هو بتوقيت القاهرة
                                             executeAtUtc = dateFnsTz.zonedTimeToUtc(parsedDate, TIME_ZONE);
                                         } catch (tzErr) {
                                             console.error("Failed to require/use date-fns-tz for UTC conversion, saving as potentially incorrect UTC.", tzErr);
                                             // حل بديل جداً: نحفظ التاريخ كما هو (قد يكون بتوقيت السيرفر أو UTC غير دقيق)
                                             // أو نعتمد على التوقيت المحلي للسيرفر (غير مضمون)
                                             // الأفضل هنا هو إرجاع خطأ لو معرفناش نحول صح
                                              await sendWhatsAppMessage(from, "حصلت مشكلة داخلية وأنا بحاول أظبط توقيت التذكير.");
                                              // ونوقف التنفيذ هنا بدل حفظ وقت غلط
                                              throw new Error("Failed to convert parsed date to UTC using date-fns-tz");
                                         }
                                         // **** نهاية التغيير ****

                                        const nowUtc = new Date();
                                        if (executeAtUtc <= nowUtc) {
                                            console.log("Reminder time is in the past.");
                                            await sendWhatsAppMessage(from, `الوقت اللي حددته (${timeString}) عدى خلاص! لو سمحت حدد وقت في المستقبل.`);
                                        } else {
                                            await addReminder(from, reminderMessage, executeAtUtc);
                                            // نحتاج date-fns-tz هنا تاني عشان نطبع الوقت صح في رسالة التأكيد
                                            let formattedLocalTime = timeString; // fallback
                                            try {
                                                 if(!dateFnsTz) dateFnsTz = require('date-fns-tz'); // نتأكد انها موجودة
                                                 formattedLocalTime = dateFnsTz.format(parsedDate, 'yyyy-MM-dd hh:mm a', { timeZone: TIME_ZONE });
                                            } catch (formatErr){ console.error("Failed to format local time for confirmation"); }
                                            await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminderMessage}" في الميعاد ده: ${formattedLocalTime}`);
                                        }
                                    }
                                } catch (parseOrAddError) {
                                    console.error("Error parsing date/time or adding reminder:", parseOrAddError);
                                    await sendWhatsAppMessage(from, "حصلت مشكلة وأنا بحاول أفهم الوقت أو أحفظ التذكير ده.");
                                }
                            } else { /*...*/ await sendWhatsAppMessage(from, "صيغة الأمر مش كاملة..."); }
                        } else { /*...*/ await sendWhatsAppMessage(from, "صيغة الأمر مش مظبوطة..."); }
                    }

                    if (!isReminder) { /* ... (OpenAI logic remains the same) ... */ }
                } /* ... */
            } /* ... */
        } /* ... */
        res.sendStatus(200);
    } catch (err) { /* ... */ res.sendStatus(200); }
});

module.exports = router;
