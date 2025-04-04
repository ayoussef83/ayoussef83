// utils/openai.js (Reads prompts from files & USES LIMITED HISTORY)
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
// --- <<< استدعاء دالة getDb عشان نوصل للداتا بيز >>> ---
const { getDb } = require('./database.js'); // تأكد إن المسار ده صح

// --- Load configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-turbo';
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo';
// --- <<< تم تغيير القيمة الافتراضية هنا إلى 2 >>> ---
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '4', 10); // الافتراضي آخر رسالتين فقط

// --- Function to read prompt files safely ---
function readPromptFromFile(fileName) {
    try {
        const filePath = path.join(__dirname, '../config', fileName);
        console.log(`Attempting to read prompt from: ${filePath}`);
        const promptText = fs.readFileSync(filePath, 'utf8').trim();
         if (!promptText) { throw new Error(`Prompt file is empty: ${fileName}`); }
         console.log(`Successfully read prompt from: ${fileName}`);
        return promptText;
    } catch (error) {
        console.error(`❌ FATAL ERROR: Could not read or parse prompt file: ${fileName}`, error);
        throw new Error(`Failed to read prompt file: ${fileName}.`);
    }
}

// --- Read prompts from files ONCE at startup ---
const generalSystemPrompt = readPromptFromFile('generalPrompt.txt');
// استخدمنا الـ prompt المعدل اللي فيه توضيح عن استخدام الهيستوري للسياق فقط
const reminderParserSystemPromptTemplate = readPromptFromFile('reminderParserPrompt.txt');


// --- Function to get recent message history ---
async function getRecentHistory(conversationId, limit = HISTORY_LIMIT) {
    console.log(`ℹ️ Fetching recent history for ${conversationId}, limit: ${limit}`);
    try {
        const db = getDb();
        if (!db) { console.warn("⚠️ DB instance not available fetching history."); return []; }
        const historyCollection = db.collection('message_history');
        const recentMessages = await historyCollection.find({ conversationId: conversationId }).sort({ timestamp: -1 }).limit(limit).toArray();
        const formattedHistory = recentMessages.reverse().map(msg => ({ role: msg.role, content: msg.content }));
        console.log(`✅ Retrieved ${formattedHistory.length} messages from history.`);
        return formattedHistory;
    } catch (error) { console.error(`❌ Error fetching history:`, error); return []; }
}


// --- Function for general replies (Uses History) ---
async function getReplyFromOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { console.error("❌ OpenAI API key missing!"); return "آسف..."; }
    if (!conversationId) { console.error("❌ conversationId missing (general reply)"); return "آسف..."; }
    const systemPrompt = generalSystemPrompt;
    const history = await getRecentHistory(conversationId); // Fetch history (limit=2 by default now)
    const messages = [ { role: "system", content: systemPrompt }, ...history, { role: "user", content: userMessage } ]; // Include history

    try {
        console.log(`🤖 Sending general query to OpenAI with ${history.length} history messages. Current message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, { model: OPENAI_MODEL, messages: messages, max_tokens: 150, temperature: 0.7 }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });
        const reply = response.data.choices?.[0]?.message?.content?.trim();
        console.log(`🤖 OpenAI general reply received.`);
        return reply;
    } catch (error) { /* ... error handling ... */ return `حصل خطأ...`; }
}

// --- Function for parsing reminders (Uses History - Limit=2) ---
async function parseReminderWithOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { console.error("❌ OpenAI API key missing!"); return null; }
    if (!conversationId) { console.error("❌ conversationId missing (parse reminder)"); return null; }

    const nowInCairo = DateTime.now().setZone(TIME_ZONE);
    const currentTimeString = nowInCairo.toFormat("yyyy-MM-dd HH:mm ZZZZ");
    // Use the template that includes instructions on using history for context
    const systemPrompt = reminderParserSystemPromptTemplate.replace('{currentTime}', currentTimeString);

    // --- <<< Get recent history (Limit is 2 by default now) >>> ---
    const history = await getRecentHistory(conversationId);

    // --- <<< Construct messages array WITH history (last 2 messages) >>> ---
    const messages = [
        { role: "system", content: systemPrompt },
        ...history, // <--- رجعنا الهيستوري هنا تاني (بس هيكون قليل المرة دي)
        { role: "user", content: userMessage }
    ];

    try {
        // Log reflects that history is being sent again
        console.log(`🤖 Sending reminder parse query to OpenAI with ${history.length} history messages. Current message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: messages, // Send array including limited history
            temperature: 0.1,
            max_tokens: 150,
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });

        // --- Rest of JSON parsing logic --- (Same as before)
        let responseData = response.data.choices?.[0]?.message?.content;
        console.log(`🤖 OpenAI raw parsing response: "${responseData}"`);
        if (!responseData) { console.warn("⚠️ OpenAI parsing response empty."); return null; }
        let parsedJson;
        try {
            if (typeof responseData === 'string') {
                if (responseData.trim().toLowerCase() === 'null') { console.log("⚠️ OpenAI returned null string."); return null; }
                 responseData = responseData.replace(/^```json\s*/, '').replace(/\s*```$/, '');
                 parsedJson = JSON.parse(responseData);
            } else if (typeof responseData === 'object' && responseData !== null) { parsedJson = responseData; }
            else { console.warn("⚠️ Unexpected OpenAI response type."); return null; }

            if (parsedJson && typeof parsedJson.reminder_text === 'string' && typeof parsedJson.local_datetime_iso === 'string') {
                 if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(parsedJson.local_datetime_iso)) {
                     console.log("✅ Successfully parsed JSON from OpenAI:", parsedJson);
                     return parsedJson;
                 } else { console.warn("⚠️ OpenAI JSON date format incorrect:", parsedJson.local_datetime_iso); return null; }
            } else { console.warn("⚠️ OpenAI JSON missing fields/wrong types:", parsedJson); return null; }
        } catch (jsonError) { console.error("❌ Error parsing JSON response:", jsonError.message); return null; }
        // --- End of JSON parsing logic ---

    } catch (error) { /* ... API call error handling ... */ return null; }
}


// Export the functions
module.exports = {
    getReplyFromOpenAI,
    parseReminderWithOpenAI
};
