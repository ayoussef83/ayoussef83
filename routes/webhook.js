// routes/webhook.js (Complete - Corrected Structure & Final Checks)

// --- Core Dependencies ---
const express = require('express');
const { DateTime } = require('luxon');

// --- Utilities & Helpers ---
// *** تأكد من صحة هذه المسارات بناءً على هيكل المشروع عندك ***
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { getDb, findReminders } = require('../utils/database'); // نستدعي الدالة الجديدة هنا أيضاً
const { addReminder } = require('../scheduler/reminderQueue'); // تأكد من المسار

// --- Initialize Express Router ---
const router = express.Router();

// --- Load configuration ---
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo';

// --- GET /webhook (Verification) ---
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    console.log('Received GET /webhook verification request:');
    console.log(`Mode: ${mode}, Token: ${token ? '******' : 'Not provided'}, Challenge: ${challenge}`);
    if (mode && token) {
        if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ Webhook verified successfully!');
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

// --- POST /webhook (Message Handler) ---
// ** الدالة دي لازم تكون async عشان نستخدم await جواها **
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    console.log(`Webhook received: Object='${req.body.object}', Entry Count=${req.body.entry?.length}`);
    console.log('------------------------------');

    try { // <<< بداية الـ try block الخارجي >>>
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Check if it's a standard WhatsApp message
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // Sender's WhatsApp ID (Used as conversationId)

            // Process only text messages
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim();

                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- Log incoming user message ---
                    try {
                        const db = getDb();
                        if (db) {
                            await db.collection('message_history').insertOne({ conversationId: from, role: 'user', content: msg_body, timestamp: new Date() });
                            console.log("📝 User message saved to history.");
                        } else { console.warn("⚠️ DB instance not available for user history logging."); }
                    } catch (dbError) { console.error("❌ Error saving user message:", dbError); }

                    // --- Message Processing Logic ---
                    let reminderProcessed = false;
                    let handledSpecifically = false;
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase();
                    const startsWithReminderKeyword = reminderKeywords.some(keyword => lowerMsgBody.startsWith(keyword.toLowerCase()));

                    // 1. Check for Reminder Keywords
                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected reminder keyword. Parsing with OpenAI (including history)...`);
                        reminderProcessed = true;
                        const parsedReminder = await parseReminderWithOpenAI(msg_body, from); // << await is valid here
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                            const { reminder_text, local_datetime_iso } = parsedReminder;
                            console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);
                            try {
                                const formatString = 'yyyy-MM-dd HH:mm';
                                const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });
                                if (!localDateTime.isValid) {
                                    console.warn(`⚠️ Failed date validation from OpenAI: "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                    await sendWhatsAppMessage(from, `معلش، الوقت فيه مشكلة: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة YYYY-MM-DD HH:MM`);
                                } else {
                                    const executeAtUtc = localDateTime.toUTC();
                                    const nowUtc = DateTime.utc();
                                    if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                        console.warn("⚠️ Reminder time is in the past.");
                                        await sendWhatsAppMessage(from, `الوقت (${local_datetime_iso}) عدى. حدد وقت في المستقبل.`);
                                    } else {
                                        const executeAtUtcDate = executeAtUtc.toJSDate();
                                        await addReminder(from, reminder_text, executeAtUtcDate); // << await is valid here
                                        const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a');
                                        await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`); // << await is valid here
                                        console.log(`✅ Reminder scheduled for ${from}.`);
                                    }
                                }
                            } catch (validationError) {
                                console.error("❌ Error validating date:", validationError);
                                await sendWhatsAppMessage(from, "حصلت مشكلة وأنا بتأكد من الوقت."); // << await is valid here
                            }
                        } else {
                            console.warn("⚠️ OpenAI could not parse reminder details.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت بس متلخبط. 🤔 ممكن تكتبه بصيغة YYYY-MM-DD HH:MM ؟"); // << await is valid here
                        }
                    } // End Reminder Check

                    // 2. Check Specific Queries (Time, Schedule) only if not reminder
                    if (!reminderProcessed) {
                        // Check for Time Query
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                            console.log("ℹ️ Handling time query directly.");
                            handledSpecifically = true;
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            await sendWhatsAppMessage(from, replyMsg); // << await is valid here
                        }
                        // Check for Schedule Query (if not time query)
                        else {
                            let queryDate = null;
                            let querySubject = null;
                            let isScheduleQuery = false;
                            let extractedDatePhrase = null;
                            const scheduleKeywords = ["مواعيد", "عندي ايه", "في ايه", "ايه جدول", "ايه تذكيرات"];

                            if (scheduleKeywords.some(keyword => lowerMsgBody.includes(keyword))) {
                                isScheduleQuery = true;
                                // Basic date phrase extraction (Needs improvement for robustness)
                                if (lowerMsgBody.includes("بكرة") || lowerMsgBody.includes("غدا")) {
                                    extractedDatePhrase = "بكرة"; queryDate = DateTime.now().setZone(TIME_ZONE).plus({ days: 1 }).startOf('day').toJSDate();
                                } else if (lowerMsgBody.includes("النهاردة") || lowerMsgBody.includes("اليوم")) {
                                    if (lowerMsgBody.includes("اليوم ده") || lowerMsgBody.includes("اليوم دا")) {
                                        isScheduleQuery = true; queryDate = null; extractedDatePhrase = "اليوم ده"; // Force clarification
                                    } else {
                                        extractedDatePhrase = "النهاردة"; queryDate = DateTime.now().setZone(TIME_ZONE).startOf('day').toJSDate();
                                    }
                                }
                            }
                            // Basic subject extraction
                            const subjectQueryMatch = msg_body.match(/^(?:امتى|معاد|تذكير)\s+(.+)/i);
                            if (subjectQueryMatch && subjectQueryMatch[1]) {
                                querySubject = subjectQueryMatch[1].replace(/[؟?]/g, '').trim(); isScheduleQuery = true;
                            } else if (lowerMsgBody.includes("بتاع السفر") && !querySubject && isScheduleQuery) { querySubject = "طيارة"; }

                            // Execute schedule query if valid criteria found
                            if (isScheduleQuery && (queryDate || querySubject)) {
                                console.log(`ℹ️ Handling schedule query. Date: ${queryDate ? queryDate.toISOString().split('T')[0] : 'N/A'}, Subject: ${querySubject || 'N/A'}`);
                                handledSpecifically = true;
                                // *** This await call is now correctly inside the async function scope ***
                                const reminders = await findReminders({ conversationId: from, queryDate, querySubject });
                                let replyMsg = "";
                                if (reminders.length > 0) {
                                    replyMsg = `تمام، دي المواعيد المسجلة `;
                                    if (queryDate) { replyMsg += `ليوم ${extractedDatePhrase || DateTime.fromJSDate(queryDate).setZone(TIME_ZONE).toFormat('yyyy-MM-dd')} `; }
                                    if (querySubject) { replyMsg += `بخصوص "${querySubject}" `; }
                                    replyMsg += `هي:\n`;
                                    reminders.forEach(r => {
                                        const localTime = DateTime.fromJSDate(r.executeAt, { zone: 'utc' }).setZone(TIME_ZONE);
                                        replyMsg += `- "${r.message}" الساعة ${localTime.toFormat('hh:mm a', { locale: 'ar-EG' })}\n`;
                                    });
                                } else {
                                    replyMsg = `تمام، بصيت معنديش أي مواعيد مسجلة ليك `;
                                     if (queryDate) { replyMsg += `ليوم ${extractedDatePhrase || DateTime.fromJSDate(queryDate).setZone(TIME_ZONE).toFormat('yyyy-MM-dd')} `; }
                                     if (querySubject) { replyMsg += `بخصوص "${querySubject}" `; }
                                    replyMsg += `حالياً.`;
                                }
                                await sendWhatsAppMessage(from, replyMsg.trim()); // << await is valid here
                            } else if (isScheduleQuery) {
                                 // Vague query, ask for clarification
                                 console.log("ℹ️ Detected vague schedule query.");
                                 handledSpecifically = true;
                                 await sendWhatsAppMessage(from, "أفندم؟ بتسأل عن مواعيد يوم إيه أو بخصوص إيه بالظبط؟"); // << await is valid here
                            }
                        } // END Schedule Query Check
                    } // END if (!reminderProcessed)

                    // 3. Fallback General Reply
                    if (!reminderProcessed && !handledSpecifically) {
                        console.log("💬 Fallback: Sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body, from); // << await is valid here
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply); // << await is valid here
                        } else { console.warn("⚠️ No general reply from OpenAI."); }
                    }
                    // --- End Message Processing Logic ---

                } else { console.warn("⚠️ Empty msg_body or missing 'from'."); }
            } else { console.log(`➡️ Received non-text message: ${message.type}`); }
        // <<< Correct closing brace for 'if (value?.messaging_product...)'
        } else {
             // This 'else' corresponds to the 'if (value?.messaging_product...)'
             console.log('✅ Received event is not a standard incoming WhatsApp message.');
        } // <<< Correct closing brace placement

    } catch (err) { // <<< OUTER CATCH >>> for the main processing block
        console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
        // Acknowledge to Meta even if processing failed catastrophically
        if (!res.headersSent) {
             res.sendStatus(200); // Use 200 OK to prevent retries, handle error internally
        }
    } // <<< END OUTER CATCH >>>
}); // END router.post('/')

// --- Final Export ---
// Export the router to be used by the main application file (index.js)
module.exports = router;
