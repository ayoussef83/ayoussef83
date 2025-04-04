// routes/webhook.js (Complete - Includes Schedule Query Logic)

// --- Core Dependencies ---
const express = require('express');
const { DateTime } = require('luxon');

// --- Utilities & Helpers ---
// *** تأكد من صحة هذه المسارات بناءً على هيكل المشروع عندك ***
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
// <<<--- تم إضافة findReminders هنا ---<<<
const { getDb, findReminders } = require('../utils/database');
const { addReminder } = require('../scheduler/reminderQueue'); // تأكد من المسار

// --- Initialize Express Router ---
const router = express.Router();

// --- Load configuration ---
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo';

// --- GET /webhook (Verification) ---
router.get('/', (req, res) => {
    // ... (Verification logic - unchanged from previous versions) ...
    const mode = req.query['hub.mode']; const token = req.query['hub.verify_token']; const challenge = req.query['hub.challenge']; console.log('Received GET /webhook verification request:'); console.log(`Mode: ${mode}, Token: ${token ? '******' : 'Not provided'}, Challenge: ${challenge}`); if (mode && token) { if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) { console.log('✅ Webhook verified successfully!'); res.status(200).send(challenge); } else { console.log('❌ Webhook verification failed - Incorrect Token'); res.sendStatus(403); } } else { console.log('❌ Webhook verification failed - Missing mode or token'); res.sendStatus(400); }
});

// --- POST /webhook (Message Handler) ---
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    console.log(`Webhook received: Object='${req.body.object}', Entry Count=${req.body.entry?.length}`);
    console.log('------------------------------');

    try { // Outer try
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

                    // Log incoming message
                    try { /* ... (logging code as before, uses getDb) ... */ const db = getDb(); if (db) { await db.collection('message_history').insertOne({ conversationId: from, role: 'user', content: msg_body, timestamp: new Date() }); console.log("📝 User message saved to history."); } else { console.warn("⚠️ DB instance unavailable for user history."); } } catch (dbError) { console.error("❌ Error saving user message:", dbError); }

                    // --- Message Processing Logic ---
                    let reminderProcessed = false;
                    let handledSpecifically = false;
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase();
                    const startsWithReminderKeyword = reminderKeywords.some(keyword => lowerMsgBody.startsWith(keyword.toLowerCase()));

                    // 1. Check Reminders
                    if (startsWithReminderKeyword) {
                        reminderProcessed = true;
                        console.log(`ℹ️ Parsing reminder with OpenAI...`);
                        const parsedReminder = await parseReminderWithOpenAI(msg_body, from);
                        if (parsedReminder /*...etc...*/) { /* ... process valid reminder logic ... */ const { reminder_text, local_datetime_iso } = parsedReminder; console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`); try { const formatString = 'yyyy-MM-dd HH:mm'; const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE }); if (!localDateTime.isValid) { console.warn(`⚠️ Failed date validation from OpenAI "${local_datetime_iso}".`); await sendWhatsAppMessage(from, `معلش، الوقت فيه مشكلة: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة<y_bin_46>-MM-DD HH:MM`); } else { const executeAtUtc = localDateTime.toUTC(); const nowUtc = DateTime.utc(); if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) { console.warn("⚠️ Reminder time is in the past."); await sendWhatsAppMessage(from, `الوقت (${local_datetime_iso}) عدى. حدد وقت في المستقبل.`); } else { const executeAtUtcDate = executeAtUtc.toJSDate(); await addReminder(from, reminder_text, executeAtUtcDate); const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`); console.log(`✅ Reminder scheduled for ${from}.`); } } } catch (validationError) { console.error("❌ Error validating date:", validationError); await sendWhatsAppMessage(from, "حصلت مشكلة وأنا بتأكد من الوقت."); } } else { console.warn("⚠️ OpenAI could not parse reminder details."); await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت بس متلخبط. 🤔 ممكن تكتبه بصيغة<y_bin_46>-MM-DD HH:MM ؟"); }
                    } // END Reminder Check

                    // --- Check specific queries only if not handled as reminder ---
                    if (!reminderProcessed) {

                        // 2. Check for Time Query
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                            console.log("ℹ️ Handling time query directly.");
                            handledSpecifically = true;
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            await sendWhatsAppMessage(from, replyMsg);
                        }
                        // <<<--- NEW: Check for Schedule Query (only if not time query) ---<<<
                        else {
                            let queryDate = null;
                            let querySubject = null;
                            let isScheduleQuery = false;
                            let extractedDatePhrase = null;
                            const scheduleKeywords = ["مواعيد", "عندي ايه", "في ايه", "ايه جدول", "ايه تذكيرات", "جدولي"]; // Added "جدولي"
                            // Check for "When is X reminder?" pattern
                            const subjectQueryMatch = msg_body.match(/^(?:امتى|معاد|تذكير)\s+(.+)/i);
                             // Check for keywords indicating a schedule query
                            if (scheduleKeywords.some(keyword => lowerMsgBody.includes(keyword)) || subjectQueryMatch ) {
                                 isScheduleQuery = true;
                                 // --- Basic Date Extraction (Needs Improvement for Production) ---
                                if (lowerMsgBody.includes("بكرة") || lowerMsgBody.includes("غدا")) {
                                    extractedDatePhrase = "بكرة"; queryDate = DateTime.now().setZone(TIME_ZONE).plus({ days: 1 }).startOf('day').toJSDate();
                                } else if (lowerMsgBody.includes("النهاردة") || lowerMsgBody.includes("اليوم")) {
                                     if (!(lowerMsgBody.includes("اليوم ده") || lowerMsgBody.includes("اليوم دا"))) { // Only parse if it's explicitly "today", not "this day"
                                         extractedDatePhrase = "النهاردة"; queryDate = DateTime.now().setZone(TIME_ZONE).startOf('day').toJSDate();
                                     } else {
                                         extractedDatePhrase = "اليوم ده"; queryDate = null; // Rely on subject or ask clarification
                                     }
                                 }
                                 // TODO: Add parsing for specific dates "MM/DD", "DD Month", day names etc. using Luxon or regex

                                 // --- Basic Subject Extraction ---
                                 if (subjectQueryMatch && subjectQueryMatch[1]) {
                                      querySubject = subjectQueryMatch[1].replace(/[؟?]/g, '').trim();
                                 } else if (lowerMsgBody.includes("بتاع السفر")) { querySubject = "طيارة"; } // Simple context carry-over attempt
                                 // TODO: Add more robust subject extraction

                                 // --- Execute schedule query if criteria were extracted ---
                                 if (queryDate || querySubject) {
                                     console.log(`ℹ️ Handling schedule query. Date: ${queryDate ? queryDate.toISOString().split('T')[0] : 'N/A'}, Subject: ${querySubject || 'N/A'}`);
                                     handledSpecifically = true;

                                     // Call the function from database.js to find reminders
                                     const reminders = await findReminders({ conversationId: from, queryDate, querySubject });

                                     // Format the reply based on results
                                     let replyMsg = "";
                                     if (reminders.length > 0) {
                                         replyMsg = `تمام، دي المواعيد المسجلة `;
                                         if (queryDate) { replyMsg += `ليوم ${extractedDatePhrase || DateTime.fromJSDate(queryDate).setZone(TIME_ZONE).toFormat('yyyy-MM-dd')} `; }
                                         if (querySubject) { replyMsg += `بخصوص "${querySubject}" `; }
                                         replyMsg += `(${reminders.length}):\n`; // Added count
                                         reminders.forEach(r => {
                                             const localTime = DateTime.fromJSDate(r.executeAt, { zone: 'utc' }).setZone(TIME_ZONE);
                                             replyMsg += `- "${r.message}" الساعة ${localTime.toFormat('hh:mm a', { locale: 'ar-EG' })}\n`;
                                         });
                                     } else { // Construct "not found" message
                                         replyMsg = `تمام، بصيت معنديش أي مواعيد مسجلة ليك `;
                                          if (queryDate) { replyMsg += `ليوم ${extractedDatePhrase || DateTime.fromJSDate(queryDate).setZone(TIME_ZONE).toFormat('yyyy-MM-dd')} `; }
                                          if (querySubject) { replyMsg += `بخصوص "${querySubject}" `; }
                                         replyMsg += `حالياً.`;
                                     }
                                     // Send the formatted reply
                                     await sendWhatsAppMessage(from, replyMsg.trim());

                                 } else if (isScheduleQuery) {
                                      // If intent was schedule query, but couldn't extract criteria
                                      console.log("ℹ️ Detected vague schedule query, asking clarification.");
                                      handledSpecifically = true;
                                      await sendWhatsAppMessage(from, "أفندم؟ بتسأل عن مواعيد يوم إيه أو بخصوص إيه بالظبط؟ لو بتسأل عن النهارده أو بكرة قوللي.");
                                 }
                             } // End if (isScheduleQuery check)
                        } // End else (if not time query)
                    } // End if (!reminderProcessed)

                    // 3. Fallback General Reply
                    // Only if NOT reminder AND NOT handled specifically
                    if (!reminderProcessed && !handledSpecifically) {
                        console.log("💬 Fallback: Sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body, from);
                        if (aiReply) { await sendWhatsAppMessage(from, aiReply); }
                        else { console.warn("⚠️ No general reply from OpenAI."); }
                    }
                    // --- End Message Processing Logic ---

                } else { console.warn("⚠️ Empty msg_body or missing 'from'."); }
            } else { console.log(`➡️ Received non-text message: ${message.type}`); }
        } else { console.log('✅ Received event is not a standard incoming WhatsApp message.'); }

        // Acknowledge Meta
        if (!res.headersSent) { res.sendStatus(200); }
    } catch (err) { // Outer Catch
        console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
        if (!res.headersSent) { res.sendStatus(200); }
    }
}); // End router.post('/')

module.exports = router;
