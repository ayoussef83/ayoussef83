/// routes/webhook.js (Complete - Final Check on Requires & Includes History Logging)

// --- Core Dependencies ---
const express = require('express');
const { DateTime } = require('luxon'); // Used for direct time query handling

// --- Utilities & Helpers ---
// *** تأكد إن المسارات دي صحيحة 100% بناءً على مكان الملفات عندك ***
// Assuming webhook.js is in 'routes/' and others are in 'utils/' or 'scheduler/' at the same level as 'routes/'
const { getReplyFromOpenAI, parseReminderWithOpenAI } = require('../utils/openai'); // Reads prompts & history now
const { sendWhatsAppMessage } = require('../utils/whatsapp'); // Logs outgoing messages now
const { getDb } = require('../utils/database'); // Exports getDb now
const { addReminder } = require('../scheduler/reminderQueue'); // Needs reminderQueue.js in scheduler (adjust path if needed)

// --- Initialize Express Router ---
const router = express.Router();

// --- Load configuration ---
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo'; // Default timezone

// --- GET /webhook (Verification) ---
// Handles the initial challenge from Meta/WhatsApp to verify the webhook URL
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Received GET /webhook verification request:');
    console.log(`Mode: ${mode}, Token: ${token ? '******' : 'Not provided'}, Challenge: ${challenge}`); // Avoid logging token

    if (mode && token) {
        // Check the mode and token sent are correct
        if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
            // Respond with the challenge token from the request
            console.log('✅ Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            console.log('❌ Webhook verification failed - Incorrect Token');
            res.sendStatus(403);
        }
    } else {
        // Responds with '400 Bad Request' if mode or token are missing
        console.log('❌ Webhook verification failed - Missing mode or token');
        res.sendStatus(400);
    }
});

// --- POST /webhook (Message Handler) ---
// Main endpoint to process incoming messages and events from WhatsApp
// Marked 'async' to allow using 'await' inside
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook Event ---');
    console.log(`Webhook received: Object='<span class="math-inline">\{req\.body\.object\}', Entry Count\=</span>{req.body.entry?.length}`); // Log basic info
    console.log('------------------------------');

    try { // Main try block for the entire request processing
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        // Check if it's a valid incoming WhatsApp message event
        if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
            const message = value.messages[0];
            const from = message.from; // User's WhatsApp ID (Used as conversationId)

            // Process only text messages
            if (message.type === 'text') {
                const msg_body = message.text?.body?.trim(); // Get the message text

                // Ensure message body and sender ID exist
                if (msg_body && from) {
                    console.log(`📩 Received text message from <span class="math-inline">\{from\}\: "</span>{msg_body}"`);

                    // --- Log incoming user message ---
                    try {
                        const db = getDb(); // Use the imported getDb function
                        if (db) {
                            const historyCollection = db.collection('message_history');
                            await historyCollection.insertOne({
                                conversationId: from, role: 'user', content: msg_body, timestamp: new Date()
                            });
                            console.log("📝 User message saved to history.");
                        } else { console.warn("⚠️ DB instance not available when trying to save user message history."); }
                    } catch (dbError) { console.error("❌ Error saving user message:", dbError); }
                    // --- End Logging Incoming Message ---

                    // --- Message Processing Logic ---
                    let reminderProcessed = false; // Flag: Was it handled as a reminder attempt?
                    let handledSpecifically = false; // Flag: Was it handled by specific logic?
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase(); // Convert once for efficiency
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        lowerMsgBody.startsWith(keyword.toLowerCase())
                    );

                    // 1. Check Reminders
                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected reminder keyword. Parsing with OpenAI (including history)...`);
                        reminderProcessed = true;
                        // --- Call OpenAI parser, passing 'from' for history context ---
                        const parsedReminder = await parseReminderWithOpenAI(msg_body, from);

                        // Check if OpenAI returned valid structured data
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                           // --- Process Valid Parsed Reminder ---
                           const { reminder_text, local_datetime_iso } = parsedReminder;
                           console.log(`✅ OpenAI parsed: Text='<span class="math-inline">\{reminder\_text\}', Time\='</span>{local_datetime_iso}'`);
                           try {
                               const formatString = 'yyyy-MM-dd HH:mm';
                               const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });
                               if (!localDateTime.isValid) {
                                   console.warn(`⚠️ Failed validation for date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                   await sendWhatsAppMessage(from, `معلش، فهمت التذكير لكن معرفتش أظبط الوقت اللي رجع من التحليل: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة تانية أو الصيغة الدقيقة:<y_bin_46>-MM-DD HH:MM`);
                               } else {
                                   const executeAtUtc = localDateTime.toUTC();
                                   const nowUtc = DateTime.utc();
                                   if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                       console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                       await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                   } else {
                                       const executeAtUtcDate = executeAtUtc.toJSDate();
                                       await addReminder(from, reminder_text, executeAtUtcDate);
                                       const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a');
                                       await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                       console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                   }
                               }
                           } catch (validationError) {
                               console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                               await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                           }
                           // --- End Process Valid Parsed Reminder ---
                        } else { // Handle failed OpenAI parsing
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي:<y_bin_46>-MM-DD HH:MM ؟");
                        }
                    } // End of reminder keyword check

                    // 2. Check for Specific Queries (like "What time is it?")
                    // Only check if it wasn't identified as a reminder attempt
                    if (!reminderProcessed) {
                        // Handle "What time is it?" directly
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                            console.log("ℹ️ Detected time query. Handling directly.");
                            handledSpecifically = true; // Mark as handled
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            await sendWhatsAppMessage(from, replyMsg); // This call will also log the bot reply
                        }
                        // Check for Schedule Query (using findReminders function)
                        // Add the 'else if' here to avoid conflict with time query
                        else { // Only check for schedule if it wasn't a time query
                            let queryDate = null;
                            let querySubject = null;
                            let isScheduleQuery = false;
                            let extractedDatePhrase = null;
                            const scheduleKeywords = ["مواعيد", "عندي ايه", "في ايه", "ايه جدول", "ايه تذكيرات"];

                            // Basic intent/entity extraction for schedule queries
                            if (scheduleKeywords.some(keyword => lowerMsgBody.includes(keyword))) {
                                isScheduleQuery = true;
                                if (lowerMsgBody.includes("بكرة") || lowerMsgBody.includes("غدا")) {
                                    extractedDatePhrase = "بكرة";
                                    queryDate = DateTime.now().setZone(TIME_ZONE).plus({ days: 1 }).startOf('day').toJSDate();
                                } else if (lowerMsgBody.includes("النهاردة") || lowerMsgBody.includes("اليوم")) {
                                     if (lowerMsgBody.includes("اليوم ده") || lowerMsgBody.includes("اليوم دا")) {
                                         // Ask for clarification for "this day" as context might be weak
                                         isScheduleQuery = true;
                                         queryDate = null;
                                         extractedDatePhrase = "اليوم ده";
                                     } else {
                                         extractedDatePhrase = "النهاردة";
                                         queryDate = DateTime.now().setZone(TIME_ZONE).startOf('day').toJSDate();
                                     }
                                }
                                // Add more date parsing here if needed (e.g., specific dates, day names)
                            }
                            const subjectQueryMatch = msg_body.match(/^(?:امتى|معاد|تذكير)\s+(.+)/i);
                            if (subjectQueryMatch && subjectQueryMatch[1]) {
                                querySubject = subjectQueryMatch[1].replace(/[؟?]/g, '').trim();
                                isScheduleQuery = true;
                            } else if (lowerMsgBody.includes("بتاع السفر") && !querySubject && isScheduleQuery) {
                                 querySubject = "طيارة"; // Infer subject
                            }

                            // --- Execute schedule query if criteria met ---
                            if(isScheduleQuery && (queryDate || querySubject)) {
                                console.log(`ℹ️ Detected schedule query. Date: ${queryDate ? queryDate.toISOString().split('T')[0] : 'N/A'}, Subject: ${querySubject || 'N/A'}`);
                                handledSpecifically = true; // Mark as handled

                                // *** This is the line that caused the 'await' error (now correctly inside async scope) ***
                                const reminders = await findReminders({ conversationId: from, queryDate, querySubject });

                                // Format reply based on results
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
                                await sendWhatsAppMessage(from, replyMsg.trim());

                            } else if (isScheduleQuery) {
                                 // Vague query, ask for clarification
                                 console.log("ℹ️ Detected vague schedule query, asking for clarification.");
                                 handledSpecifically = true;
                                 await sendWhatsAppMessage(from, "أفندم؟ بتسأل عن مواعيد يوم إيه أو بخصوص إيه بالظبط؟");
                            }
                        } // End of schedule query check
                    } // End else (if not time query)
                } // End if (!reminderProcessed)

                // 3. Fallback General Reply
                // Only if NOT reminder AND NOT handled specifically by other logic
                if (!reminderProcessed && !handledSpecifically) {
                    console.log("💬 Fallback: Sending to OpenAI for general reply (including history)...");
                    const aiReply = await getReplyFromOpenAI(msg_body, from); // Pass history context
                    if (aiReply) {
                        await sendWhatsAppMessage(from, aiReply); // This logs the reply
                    } else {
                        console.warn("⚠️ No reply generated by OpenAI for general query.");
                    }
                }
                // --- End of Message Processing Logic ---

            } else { console.warn("⚠️ Webhook received empty msg_body or missing sender 'from'."); }
        } else { console.log(`➡️ Received non-text message type: ${message.type} from ${from}`); }
    } else { console.log('✅ Received event is not a standard incoming WhatsApp message.'); }

    // IMPORTANT: Acknowledge receipt to Meta quickly
    if (!res.headersSent) { res.sendStatus(200); }

} catch (err) { // Outer Catch block for any unexpected errors
    console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err);
    if (!res.headersSent) { res.sendStatus(200); }
}
