// routes/webhook.js (Complete - Using Function Calling / Tool Use)

const express = require('express');
const { DateTime } = require('luxon');
// --- <<< استدعاء الدوال الجديدة والقديمة من openai.js >>> ---
const { getOpenAIResponseAndTools, parseReminderWithOpenAI } = require('../utils/openai');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { getDb, findReminders } = require('../utils/database'); // Need findReminders here now
const { addReminder } = require('../scheduler/reminderQueue');
// --- <<< استدعاء axios عشان نكلم OpenAI في الخطوة التانية بتاعت الـ Tool >>> ---
const axios = require('axios'); // Needed for the second OpenAI call

const router = express.Router();

// --- Load configuration ---
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo';
// --- <<< credentials for second OpenAI call (if needed, already loaded via openai.js but keep keys handy) >>> ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-turbo';


// --- GET /webhook (Verification) ---
router.get('/', (req, res) => { /* ... unchanged verification logic ... */ const mode = req.query['hub.mode']; const token = req.query['hub.verify_token']; const challenge = req.query['hub.challenge']; console.log('Received GET /webhook verification request:'); console.log(`Mode: ${mode}, Token: ${token ? '******' : 'Not provided'}, Challenge: ${challenge}`); if (mode && token) { if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) { console.log('✅ Webhook verified successfully!'); res.status(200).send(challenge); } else { console.log('❌ Webhook verification failed - Incorrect Token'); res.sendStatus(403); } } else { console.log('❌ Webhook verification failed - Missing mode or token'); res.sendStatus(400); } });

// --- POST /webhook (Message Handler) ---
router.post('/', async (req, res) => {
    console.log('\n--- Incoming Webhook ---');
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
                    console.log(`📩 Received: "${msg_body}" from ${from}`);
                    // Log incoming message
                    try { const db = getDb(); if (db) { await db.collection('message_history').insertOne({ conversationId: from, role: 'user', content: msg_body, timestamp: new Date() }); console.log("📝 User message saved."); } else { console.warn("⚠️ DB unavailable for user history."); } } catch (dbError) { console.error("❌ Error saving user message:", dbError); }

                    let reminderProcessed = false;
                    let handledByToolOrDirectly = false;
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase();
                    const startsWithReminderKeyword = reminderKeywords.some(keyword => lowerMsgBody.startsWith(keyword.toLowerCase()));

                    // --- 1. Check for Reminder Keywords (Use specialized parser) ---
                    if (startsWithReminderKeyword) {
                        reminderProcessed = true;
                        handledByToolOrDirectly = true; // Mark as handled
                        console.log(`ℹ️ Handling as reminder -> parseReminderWithOpenAI`);
                        const parsedReminder = await parseReminderWithOpenAI(msg_body, from);
                        if (parsedReminder /*...etc...*/) { /* ... process valid reminder ... */ const { reminder_text, local_datetime_iso } = parsedReminder; console.log(`✅ Parsed reminder: ${reminder_text} at ${local_datetime_iso}`); try { const formatString = 'yyyy-MM-dd HH:mm'; const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE }); if (!localDateTime.isValid) { console.warn(`⚠️ Invalid date from parser: ${local_datetime_iso}`); await sendWhatsAppMessage(from, `معلش، الوقت فيه مشكلة: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.`); } else { const executeAtUtc = localDateTime.toUTC(); const nowUtc = DateTime.utc(); if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) { console.warn("⚠️ Reminder time past."); await sendWhatsAppMessage(from, `الوقت (${local_datetime_iso}) عدى.`); } else { const executeAtUtcDate = executeAtUtc.toJSDate(); await addReminder(from, reminder_text, executeAtUtcDate); const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`); console.log(`✅ Reminder scheduled.`); } } } catch (validationError) { console.error("❌ Error validating date:", validationError); await sendWhatsAppMessage(from, "حصلت مشكلة في الوقت."); } } else { console.warn("⚠️ OpenAI could not parse reminder."); await sendWhatsAppMessage(from, "معلش، متلخبط في الوقت. 🤔 ممكن تكتبه بصيغة YYYY-MM-DD HH:MM ؟"); }
                    }

                    // --- 2. Check for Hardcoded Specific Queries (like Time) ---
                    // Only check if not handled as reminder
                    if (!reminderProcessed) {
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                             handledByToolOrDirectly = true; // Mark as handled
                             console.log("ℹ️ Handling time query directly.");
                             const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                             const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                             const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                             await sendWhatsAppMessage(from, replyMsg);
                         }
                         // <<<--- تم إلغاء الجزء القديم بتاع تحليل أسئلة المواعيد من هنا ---<<<
                         // No more 'else if' block here trying to manually parse schedule queries
                    }

                    // --- 3. Use General LLM with Tools for everything else ---
                    // Only if NOT reminder AND NOT handled specifically by hardcoded logic
                    if (!reminderProcessed && !handledByToolOrDirectly) {
                        console.log("💬 Handling with OpenAI + Tools...");
                        // Call the new main function which might return content or request a tool call
                        const aiResponse = await getOpenAIResponseAndTools(msg_body, from);

                        // --- Handle AI Response ---
                        if (aiResponse.type === 'content') {
                            // AI provided a direct text reply
                            console.log("✅ AI provided direct response.");
                            await sendWhatsAppMessage(from, aiResponse.content);
                        }
                        else if (aiResponse.type === 'tool_call' && aiResponse.name === 'findReminders') {
                            // AI asked to use the findReminders tool
                            console.log("🛠️ AI requested 'findReminders' tool call with args:", aiResponse.arguments);
                            const args = aiResponse.arguments;
                            let queryDate = null;

                            // --- Parse date_phrase argument from AI ---
                            // !!! This needs more robust implementation !!!
                            // It should ideally handle relative terms like 'tomorrow', 'next week', 'that day', etc.
                            // by using the history potentially or another LLM call for parsing.
                            // For now, it includes basic checks + the specific date from args if OpenAI extracts it.
                            if (args.date_phrase) {
                                console.log(`   Attempting basic parse of date_phrase: "${args.date_phrase}"`);
                                const lowerDatePhrase = args.date_phrase.toLowerCase();
                                let parsedDate = null;
                                if (lowerDatePhrase.includes("بكرة") || lowerDatePhrase.includes("غدا")) {
                                    parsedDate = DateTime.now().setZone(TIME_ZONE).plus({ days: 1 });
                                } else if (lowerDatePhrase.includes("النهاردة") || (lowerDatePhrase.includes("اليوم") && !lowerDatePhrase.includes("ده") && !lowerDatePhrase.includes("دا"))) {
                                    parsedDate = DateTime.now().setZone(TIME_ZONE);
                                } else {
                                     // Try parsing specific dates like "June 18", "18 يونيو" etc. (very basic)
                                     // Ideally use a dedicated date parsing library or another LLM call here
                                     const dateMatch = args.date_phrase.match(/(\d{1,2})\s+(يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر)/i);
                                     // Very simplistic month mapping
                                     const months = { يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12 };
                                     if (dateMatch && dateMatch[1] && dateMatch[2] && months[dateMatch[2].toLowerCase()]) {
                                          const day = parseInt(dateMatch[1], 10);
                                          const month = months[dateMatch[2].toLowerCase()];
                                          const year = DateTime.now().year; // Assume current year
                                          parsedDate = DateTime.fromObject({day, month, year}, {zone: TIME_ZONE});
                                          console.log(`   Parsed specific date: ${parsedDate.toISO()}`);
                                     }
                                     // Add more specific date format checks if needed
                                }

                                if(parsedDate && parsedDate.isValid) {
                                    queryDate = parsedDate.startOf('day').toJSDate(); // Get JS Date at start of day UTC
                                    console.log(`   Parsed queryDate (JS Date object): ${queryDate}`);
                                } else {
                                     console.log("   Could not parse date_phrase into a specific date.");
                                     // If AI provided a date phrase but we couldn't parse it,
                                     // maybe ask user for clarification? Or proceed with subject only?
                                     // For now, proceed with subject only if date parsing fails here.
                                     queryDate = null;
                                }
                            } else {
                                 console.log("   No date_phrase provided by AI.");
                            }
                            // --- End Date Parsing ---

                            // --- Execute the actual tool function (DB query) ---
                            // We proceed even if only subject is available (queryDate might be null)
                            if (queryDate || args.subject) {
                                console.log("   Executing findReminders function...");
                                const toolResults = await findReminders({
                                    conversationId: from,
                                    queryDate: queryDate,
                                    querySubject: args.subject
                                });

                                // --- Format results for the second OpenAI call ---
                                let resultsString = "";
                                if (toolResults.length > 0) {
                                    resultsString = `I found ${toolResults.length} matching reminders:\n`; // Use English for AI context
                                    toolResults.forEach(r => {
                                        const localTime = DateTime.fromJSDate(r.executeAt, { zone: 'utc' }).setZone(TIME_ZONE);
                                        resultsString += `- "${r.message}" at ${localTime.toFormat('yyyy-MM-dd hh:mm a')}\n`;
                                    });
                                } else {
                                    resultsString = "No matching reminders found for the specified criteria.";
                                }
                                console.log("🛠️ Tool execution result string:", resultsString);

                                // --- Call OpenAI AGAIN with tool results to get final user-facing response ---
                                console.log("🔄 Calling OpenAI again with tool results...");
                                // Construct messages for the second call
                                const messagesForFollowUp = [
                                    ...(aiResponse.original_messages || []), // History + UserMsg from 1st call
                                    aiResponse.original_tool_call_response, // Assistant's request to call tool
                                    {                                       // Tool's response
                                        role: "tool",
                                        tool_call_id: aiResponse.call_id,
                                        name: "findReminders",
                                        content: resultsString // Send the formatted results back to the model
                                    }
                                ];

                                try {
                                    const finalApiResponse = await axios.post(OPENAI_API_URL, {
                                        model: OPENAI_MODEL,
                                        messages: messagesForFollowUp,
                                    }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });

                                    const finalReply = finalApiResponse.data.choices?.[0]?.message?.content?.trim();

                                    if (finalReply) {
                                        console.log("✅ AI generated final response after tool call.");
                                        await sendWhatsAppMessage(from, finalReply);
                                    } else {
                                        console.warn("⚠️ OpenAI did not provide final response after tool call. Sending raw results.");
                                        await sendWhatsAppMessage(from, "لقيت المواعيد دي (بس معرفتش أصيغ الرد):\n" + resultsString); // Fallback
                                    }
                                } catch (finalApiError) {
                                     console.error("❌ Error in second OpenAI call (after tool execution):", finalApiError);
                                     // Send raw results if final response generation fails
                                     await sendWhatsAppMessage(from, "عرفت أجيب المواعيد بس حصل مشكلة وأنا بكتب الرد النهائي. دي النتيجة:\n" + resultsString);
                                }
                            } else {
                                 // AI requested tool but didn't provide valid args, or parsing failed entirely
                                 console.warn("⚠️ Tool call requested by AI, but no valid query criteria (date/subject) could be determined.");
                                 await sendWhatsAppMessage(from, "معلش، طلبت مني أدور على مواعيد بس مش واضح أدور على إيه بالظبط. ممكن تحدد التاريخ أو الموضوع؟");
                            }
                        } // End handling findReminders tool call
                         else if (aiResponse.type === 'error') {
                             console.error("Error from getOpenAIResponseAndTools:", aiResponse.content);
                             await sendWhatsAppMessage(from, "معلش، حصل خطأ داخلي بسيط ومقدرتش أكمل طلبك.");
                         }
                         // Handle other potential tool calls here in the future with 'else if'
                    } // End fallback logic

                } else { console.warn("⚠️ Empty msg_body or missing 'from'."); }
            } else { console.log(`➡️ Received non-text message: ${message.type}`); }
        } else { console.log('✅ Non-message WhatsApp event received.'); }

        if (!res.headersSent) { res.sendStatus(200); }
    } catch (err) { console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err); if (!res.headersSent) { res.sendStatus(200); } }
}); // End router.post('/')

module.exports = router;
