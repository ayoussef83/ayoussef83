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
// --- <<< credentials for second OpenAI call >>> ---
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
                    try { /* ... log user message ... */ const db = getDb(); if (db) { await db.collection('message_history').insertOne({ conversationId: from, role: 'user', content: msg_body, timestamp: new Date() }); console.log("📝 User message saved."); } else { console.warn("⚠️ DB unavailable for user history."); } } catch (dbError) { console.error("❌ Error saving user message:", dbError); }

                    let reminderProcessed = false;
                    let handledByToolOrDirectly = false; // Renamed for clarity
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    const lowerMsgBody = msg_body.toLowerCase();
                    const startsWithReminderKeyword = reminderKeywords.some(keyword => lowerMsgBody.startsWith(keyword.toLowerCase()));

                    // --- 1. Check for Reminder Keywords (Use specialized parser) ---
                    if (startsWithReminderKeyword) {
                        reminderProcessed = true; // Mark as handled by reminder logic
                        handledByToolOrDirectly = true; // Prevents fallback general reply
                        console.log(`ℹ️ Handling as reminder -> parseReminderWithOpenAI`);
                        const parsedReminder = await parseReminderWithOpenAI(msg_body, from);
                        if (parsedReminder /*...etc...*/) { /* ... process valid reminder logic ... */ const { reminder_text, local_datetime_iso } = parsedReminder; console.log(`✅ Parsed reminder: ${reminder_text} at ${local_datetime_iso}`); try { const formatString = 'yyyy-MM-dd HH:mm'; const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE }); if (!localDateTime.isValid) { console.warn(`⚠️ Invalid date from parser: ${local_datetime_iso}`); await sendWhatsAppMessage(from, `معلش، الوقت فيه مشكلة: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.`); } else { const executeAtUtc = localDateTime.toUTC(); const nowUtc = DateTime.utc(); if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) { console.warn("⚠️ Reminder time past."); await sendWhatsAppMessage(from, `الوقت (${local_datetime_iso}) عدى.`); } else { const executeAtUtcDate = executeAtUtc.toJSDate(); await addReminder(from, reminder_text, executeAtUtcDate); const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`); console.log(`✅ Reminder scheduled.`); } } } catch (validationError) { console.error("❌ Error validating date:", validationError); await sendWhatsAppMessage(from, "حصلت مشكلة في الوقت."); } } else { console.warn("⚠️ OpenAI could not parse reminder."); await sendWhatsAppMessage(from, "معلش، متلخبط في الوقت. 🤔 ممكن تكتبه بصيغة YYYY-MM-DD HH:MM ؟"); }
                    }

                    // --- 2. Check for Hardcoded Queries (like Time) ---
                    if (!reminderProcessed) {
                        if (lowerMsgBody.includes("الساعة كام") || lowerMsgBody.includes("الوقت ايه") || lowerMsgBody === "الوقت") {
                            handledByToolOrDirectly = true; // Mark as handled
                            console.log("ℹ️ Handling time query directly.");
                            const nowInCairo = DateTime.now().setZone(TIME_ZONE);
                            const formattedTime = nowInCairo.toFormat('hh:mm a', { locale: 'ar-EG' });
                            const replyMsg = `الساعة دلوقتي ${formattedTime} بتوقيت القاهرة.`;
                            await sendWhatsAppMessage(from, replyMsg);
                        }
                        // Add other simple, non-LLM queries here if needed
                    }

                    // --- 3. Use General LLM with Tools for everything else ---
                    if (!reminderProcessed && !handledByToolOrDirectly) {
                        console.log("💬 Handling with OpenAI + Tools...");
                        // Call the main function that might return content or request a tool call
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
                            // TODO: Replace this with more robust date parsing using Luxon / OpenAI
                            // This basic parsing only handles "tomorrow" and "today" for now.
                            // It needs enhancement to understand "June 18th", "next Sunday", etc.
                            if (args.date_phrase) {
                                console.log(`   Attempting basic parse of date_phrase: "${args.date_phrase}"`);
                                const lowerDatePhrase = args.date_phrase.toLowerCase();
                                if (lowerDatePhrase.includes("بكرة") || lowerDatePhrase.includes("غدا")) {
                                    queryDate = DateTime.now().setZone(TIME_ZONE).plus({ days: 1 }).startOf('day').toJSDate();
                                } else if (lowerDatePhrase.includes("النهاردة") || lowerDatePhrase.includes("اليوم")) {
                                     // Avoid parsing "اليوم ده" ambiguously here, let subject handle it maybe
                                     if (!(lowerDatePhrase.includes("اليوم ده") || lowerDatePhrase.includes("اليوم دا"))) {
                                         queryDate = DateTime.now().setZone(TIME_ZONE).startOf('day').toJSDate();
                                     }
                                } else if (args.date_phrase.includes("18 يونيو")) { // Basic handling for testing
                                    queryDate = DateTime.fromObject({day: 18, month: 6, year: DateTime.now().year}, {zone: TIME_ZONE}).startOf('day').toJSDate();
                                }
                                console.log(`   Parsed queryDate (JS Date object): ${queryDate}`);
                            }
                            // --- End Date Parsing ---

                            // --- Execute the actual tool function (DB query) ---
                            const toolResults = await findReminders({
                                conversationId: from,
                                queryDate: queryDate, // Pass the parsed JS Date (or null)
                                querySubject: args.subject // Pass the subject from AI args
                            });

                            // --- Format results for the second OpenAI call ---
                            let resultsString = "";
                            if (toolResults.length > 0) {
                                resultsString = `Found ${toolResults.length} reminders:\n`;
                                toolResults.forEach(r => {
                                    const localTime = DateTime.fromJSDate(r.executeAt, { zone: 'utc' }).setZone(TIME_ZONE);
                                    resultsString += `- "${r.message}" at ${localTime.toFormat('yyyy-MM-dd hh:mm a')}\n`;
                                });
                            } else {
                                resultsString = "No matching reminders found for the specified criteria.";
                            }
                            console.log("🛠️ Tool execution result:", resultsString);

                            // --- Call OpenAI AGAIN with tool results to get final response ---
                            console.log("🔄 Calling OpenAI again with tool results...");
                            // Use the messages from the *first* call, plus the assistant's tool request, plus the tool result
                            const messagesForFollowUp = [
                                ...(aiResponse.original_messages || []), // Include original history sent
                                aiResponse.original_tool_call_response, // Include the assistant message asking for tool call
                                {
                                    role: "tool",
                                    tool_call_id: aiResponse.call_id, // ID of the tool call request
                                    name: "findReminders",          // Name of the tool called
                                    content: resultsString           // Results from our function
                                }
                            ];

                            try {
                                const finalApiResponse = await axios.post(OPENAI_API_URL, {
                                    model: OPENAI_MODEL,
                                    messages: messagesForFollowUp,
                                    // No tools needed for this call, just generate text
                                }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });

                                const finalReply = finalApiResponse.data.choices?.[0]?.message?.content?.trim();

                                if (finalReply) {
                                    console.log("✅ AI generated final response after tool call.");
                                    await sendWhatsAppMessage(from, finalReply);
                                } else {
                                    console.warn("⚠️ OpenAI did not provide final response after tool call. Sending raw results.");
                                    await sendWhatsAppMessage(from, "لقيت المواعيد دي:\n" + resultsString); // Fallback: send raw results
                                }
                            } catch (finalApiError) {
                                 console.error("❌ Error in second OpenAI call (after tool execution):", finalApiError);
                                 await sendWhatsAppMessage(from, "عرفت أجيب المواعيد بس حصل مشكلة وأنا بكتب الرد. دي النتيجة:\n" + resultsString); // Send raw results on error
                            }
                        } // End handling findReminders tool call
                        else if (aiResponse.type === 'error') {
                             console.error("Error from getOpenAIResponseAndTools:", aiResponse.content);
                             await sendWhatsAppMessage(from, "معلش، حصل خطأ داخلي.");
                         }
                         // Handle other potential tool calls here if added later
                    } // End fallback logic

                } else { console.warn("⚠️ Empty msg_body or missing 'from'."); }
            } else { console.log(`➡️ Received non-text message: ${message.type}`); }
        } else { console.log('✅ Non-message WhatsApp event received.'); }

        if (!res.headersSent) { res.sendStatus(200); }
    } catch (err) { console.error("❌ CRITICAL: Unexpected error in POST /webhook handler:", err); if (!res.headersSent) { res.sendStatus(200); } }
});

module.exports = router;
