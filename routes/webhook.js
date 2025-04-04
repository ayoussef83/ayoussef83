// routes/webhook.js
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { addReminder } = require('../scheduler/reminderQueue'); // لاستدعاء دالة إضافة التذكير
const { parse, zonedTimeToUtc, format } = require('date-fns-tz'); // للتعامل مع التواريخ والتوقيت
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
    console.log('Received webhook event:', JSON.stringify(req.body, null, 2));

    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // Sender phone number

            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim(); // .trim() لإزالة المسافات الزائدة

                if (msg_body && from) {
                    console.log(`📩 New text message from ${from}: ${msg_body}`);

                    // **** بداية منطق التذكير ****
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
                                console.log(`Attempting to parse reminder: "<span class="math-inline">\{reminderMessage\}" at "</span>{timeString}"`);
                                try {
                                    // محاولة تحليل الوقت المدخل (نفترض صيغة معينة مؤقتاً)
                                    // جرب صيغ مختلفة لوقت الإدخال
                                    // الصيغة الأولى: 'yyyy-MM-dd HH:mm' (زي 2025-04-04 15:30)
                                    let parsedDate = parse(timeString, 'yyyy-MM-dd HH:mm', new Date(), { timeZone: TIME_ZONE });

                                    // لو فشلت الصيغة الأولى، جرب صيغة تانية (ممكن تضيف صيغ أكتر)
                                    if (isNaN(parsedDate.getTime())) {
                                        // مثال صيغة تانية: 'dd/MM/yyyy HH:mm' (زي 04/04/2025 15:30)
                                        // parsedDate = parse(timeString, 'dd/MM/yyyy HH:mm', new Date(), { timeZone: TIME_ZONE });
                                        console.log("Could not parse date with format yyyy-MM-dd HH:mm");
                                        // ممكن نضيف صيغ أخرى هنا...
                                    }


                                    if (isNaN(parsedDate.getTime())) {
                                        // لو فشلت كل المحاولات
                                        console.log("Failed to parse date string:", timeString);
                                        await sendWhatsAppMessage(from, `معلش، مقدرتش أفهم صيغة الوقت والتاريخ دي: "${timeString}". جرب تكتبها بصيغة زي YYYY-MM-DD HH:MM`);
                                    } else {
                                        // لو نجح التحليل، حوله لـ UTC للحفظ
                                        const executeAtUtc = zonedTimeToUtc(parsedDate, TIME_ZONE);
                                        const nowUtc = new Date();

                                        if (executeAtUtc <= nowUtc) {
                                            // لو الوقت المطلوب في الماضي
                                            console.log("Reminder time is in the past.");
                                             await sendWhatsAppMessage(from, `الوقت اللي حددته (${timeString}) عدى خلاص! حدد وقت في المستقبل.`);
                                        } else {
                                            // حفظ التذكير في قاعدة البيانات
                                            await addReminder(from, reminderMessage, executeAtUtc);
                                            // إرسال رسالة تأكيد للمستخدم
                                            const formattedLocalTime = format(parsedDate, 'yyyy-MM-dd hh:mm a', { timeZone: TIME_ZONE });
                                            await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminderMessage}" في ${formattedLocalTime}`);
                                        }
                                    }
                                } catch (parseError) {
                                    console.error("Error parsing date/time or adding reminder:", parseError);
                                    await sendWhatsAppMessage(from, "حصلت مشكلة وأنا بحاول أحفظ التذكير ده.");
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

                } else {
                    console.log("Missing message body or sender number.");
                }
            } else {
                console.log(`Received non-text message type: ${message.type} from ${from}`);
                // Optional: await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس.");
            }
        } else {
            console.log('Received event is not a WhatsApp message or has no message content.');
        }

        res.sendStatus(200);

    } catch (err) {
        console.error('❌ Error processing webhook:', err);
        res.sendStatus(200); // Send 200 OK anyway to Meta
    }
});

module.exports = router;
