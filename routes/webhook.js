// routes/webhook.js
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
// استدعاء دالة إضافة التذكير من ملف الـ scheduler
const { addReminder } = require('../scheduler/reminderQueue');
// استدعاء الدوال اللازمة من مكتبة التوقيت
const { parse, zonedTimeToUtc, format, isValid } = require('date-fns-tz');
require('dotenv').config();

const router = express.Router();

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = 'Africa/Cairo'; // تحديد المنطقة الزمنية لمصر

// --- Verification Endpoint (GET /webhook) ---
router.get('/', (req, res) => {
    // ... (كود التحقق زي ما هو مفهوش تغيير) ...
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

                    // **** بداية منطق التذكير ****
                    const reminderPrefix = "ذكرني:";
                    const timePrefix = "في:";
                    let isReminder = false; // Flag to know if it was a reminder command

                    if (msg_body.startsWith(reminderPrefix)) {
                        const parts = msg_body.substring(reminderPrefix.length).split(timePrefix);
                        if (parts.length === 2) {
                            const reminderMessage = parts[0].trim();
                            const timeString = parts[1].trim();

                            if (reminderMessage && timeString) {
                                isReminder = true; // It's a reminder command
                                console.log(`Attempting to parse reminder: "<span class="math-inline">\{reminderMessage\}" at "</span>{timeString}"`);
                                try {
                                    // افتراض الصيغة: YYYY-MM-DD HH:MM (24-hour format)
                                    const formatString = 'yyyy-MM-dd HH:mm';
                                    // تحليل النص المدخل بناءً على توقيت مصر
                                    let parsedDate = parse(timeString, formatString, new Date(), { timeZone: TIME_ZONE });

                                    // التحقق إذا كان التحليل نجح
                                    if (!isValid(parsedDate)) {
                                        console.log(`Failed to parse date string "${timeString}" with format ${formatString}`);
                                        await sendWhatsAppMessage(from, `معلش، مقدرتش أفهم صيغة الوقت والتاريخ دي: "${timeString}". جرب تكتبها بصيغة زي YYYY-MM-DD HH:MM (مثال: 2025-04-04 14:00 للساعة 2 الضهر).`);
                                    } else {
                                        // تحويل التاريخ المحلي (بتوقيت القاهرة) إلى UTC للتخزين والمقارنة
                                        const executeAtUtc = zonedTimeToUtc(parsedDate, TIME_ZONE);
                                        const nowUtc = new Date();

                                        if (executeAtUtc <= nowUtc) {
                                            console.log("Reminder time is in the past.");
                                            await sendWhatsAppMessage(from, `الوقت اللي حددته (${timeString}) عدى خلاص! لو سمحت حدد وقت في المستقبل.`);
                                        } else {
                                            // **** حفظ التذكير في قاعدة البيانات ****
                                            await addReminder(from, reminderMessage, executeAtUtc);

                                            // إرسال رسالة تأكيد للمستخدم بالتوقيت المحلي
                                            const formattedLocalTime = format(parsedDate, 'yyyy-MM-dd hh:mm a', { timeZone: TIME_ZONE }); // Format for confirmation message
                                            await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminderMessage}" في الميعاد ده: ${formattedLocalTime}`);
                                        }
                                    }
                                } catch (parseError) {
                                    console.error("Error parsing date/time or adding reminder:", parseError);
                                    await sendWhatsAppMessage(from, "حصلت مشكلة وأنا بحاول أفهم الوقت أو أحفظ التذكير ده.");
                                }
                            } else {
                                 console.log("Reminder command incomplete. Missing message or time.");
                                  await sendWhatsAppMessage(from, "صيغة الأمر مش كاملة. لازم تكتب 'ذكرني: [الرسالة] في: [الوقت]'");
                            }
                        } else {
                             console.log("Reminder command format incorrect.");
                             await sendWhatsAppMessage(from, "صيغة الأمر مش مظبوطة. لازم تكتب 'ذكرني: [الرسالة] في: [الوقت]'");
                        }
                    }
                    // **** نهاية منطق التذكير ****

                    // لو الرسالة مكنتش أمر تذكير، نفذ منطق OpenAI العادي
                    if (!isReminder) {
                        console.log("Message is not a reminder, sending to OpenAI...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.log("No AI reply generated or returned.");
                        }
                    }
                } /* ... (rest of checks) ... */
            } /* ... (rest of checks) ... */
        } /* ... (rest of checks) ... */
        res.sendStatus(200);
    } catch (err) { /* ... (error handling) ... */ res.sendStatus(200); }
});

module.exports = router;
