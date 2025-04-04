// utils/openai.js (TEST VERSION - History DISABLED for Reminder Parsing)
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { getDb } = require('./database.js'); // Assuming database.js is in the same utils folder

// --- Load configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-turbo';
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo';
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '6', 10); // Still defined, but not used by parser in this test version

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


// --- Function for general replies (STILL USES HISTORY) ---
async function getReplyFromOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { console.error("❌ OpenAI API key missing!"); return "آسف..."; }
    if (!conversationId) { console.error("❌ conversationId missing (general reply)"); return "آسف..."; }
    const systemPrompt = generalSystemPrompt;
    const history = await getRecentHistory(conversationId); // Fetch history
    const messages = [ { role: "system", content: systemPrompt }, ...history, { role: "user", content: userMessage } ]; // Include history

    try {
        console.log(`🤖 Sending general query to OpenAI with ${history.length} history messages. Current message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, { model: OPENAI_MODEL, messages: messages, max_tokens: 150, temperature: 0.7 }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });
        const reply = response.data.choices?.[0]?.message?.content?.trim();
        console.log(`🤖 OpenAI general reply received.`);
        return reply;
    } catch (error) { /* ... error handling ... */ return `حصل خطأ...`; }
}

// --- Function for parsing reminders (MODIFIED **NOT** TO SEND HISTORY for TESTING) ---
async function parseReminderWithOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { console.error("❌ OpenAI API key missing!"); return null; }
    if (!conversationId) { console.error("❌ conversationId missing (parse reminder)"); return null; }

    const nowInCairo = DateTime.now().setZone(TIME_ZONE);
    const currentTimeString = nowInCairo.toFormat("yyyy-MM-dd HH:mm ZZZZ");
    const systemPrompt = reminderParserSystemPromptTemplate.replace('{currentTime}', currentTimeString);

    // --- We fetch history BUT DO NOT SEND IT for this test ---
    const history = await getRecentHistory(conversationId); // Fetched but not used below

    // --- Construct messages array WITHOUT history for this specific function ---
    const messages = [
        { role: "system", content: systemPrompt },
        // ...history, // <--- السطر ده متعطل في نسخة الاختبار دي
        { role: "user", content: userMessage } // User message only
    ];

    try {
        // Modified log message for clarity during testing
        console.log(`🤖 Sending reminder parse query to OpenAI **WITHOUT HISTORY (TEST)**. Current message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: messages, // Sending array without history
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
