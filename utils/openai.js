// utils/openai.js (Reads prompts from files & USES HISTORY)
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
// --- <<< حدد عدد الرسايل القديمة اللي عايزين نبعتها (ممكن نغير الرقم ده بعدين) >>> ---
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '6', 10); // الافتراضي آخر 6 رسايل (3 أدوار)

// --- Function to read prompt files safely ---
function readPromptFromFile(fileName) {
    try {
        const filePath = path.join(__dirname, '../config', fileName);
        console.log(`Attempting to read prompt from: ${filePath}`);
        const promptText = fs.readFileSync(filePath, 'utf8').trim();
         if (!promptText) {
             throw new Error(`Prompt file is empty: ${fileName}`);
         }
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


// --- <<< NEW: Function to get recent message history >>> ---
/**
 * Retrieves the most recent messages for a given conversation ID.
 * @param {string} conversationId - The user's WhatsApp ID.
 * @param {number} limit - The maximum number of messages to retrieve.
 * @returns {Promise<Array<{role: string, content: string}>>} - Array of messages {role, content} or empty array.
 */
async function getRecentHistory(conversationId, limit = HISTORY_LIMIT) {
    console.log(`ℹ️ Fetching recent history for ${conversationId}, limit: ${limit}`);
    try {
        const db = getDb(); // Get DB instance
        if (!db) {
            console.warn("⚠️ DB instance not available when trying to fetch history.");
            return []; // Return empty if DB connection lost
        }
        const historyCollection = db.collection('message_history');
        // Find messages for this user, sort by newest first, limit results
        const recentMessages = await historyCollection
            .find({ conversationId: conversationId })
            .sort({ timestamp: -1 }) // Newest messages first
            .limit(limit)
            .toArray();

        // Reverse the array to get chronological order (oldest of the batch first)
        // Map to the format OpenAI expects: { role: 'user'/'assistant', content: '...' }
        const formattedHistory = recentMessages.reverse().map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        console.log(`✅ Retrieved ${formattedHistory.length} messages from history.`);
        return formattedHistory;

    } catch (error) {
        console.error(`❌ Error fetching message history for ${conversationId}:`, error);
        return []; // Return empty array on error to prevent breaking the flow
    }
}


// --- Function for general replies (MODIFIED TO USE HISTORY) ---
// Takes conversationId (user's 'from' number) as the second argument now
async function getReplyFromOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) {
        console.error("❌ OpenAI API key missing!");
        return "آسف، خدمة الذكاء الاصطناعي غير متاحة حالياً.";
    }
     if (!conversationId) { // Basic check
         console.error("❌ conversationId missing in getReplyFromOpenAI call.");
         return "آسف، حدث خطأ داخلي بسيط.";
    }

    const systemPrompt = generalSystemPrompt; // Use the prompt read from file

    // --- <<< Get recent history before calling API >>> ---
    const history = await getRecentHistory(conversationId);

    // --- <<< Construct the messages array including history >>> ---
    const messages = [
        { role: "system", content: systemPrompt }, // System prompt first
        ...history, // Spread the array of past messages [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}]
        { role: "user", content: userMessage } // Finally, the current user message
    ];

    try {
        console.log(`🤖 Sending general query to OpenAI with ${history.length} history messages. Current message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: messages, // Send the array including history
            max_tokens: 150,
            temperature: 0.7
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });
        const reply = response.data.choices?.[0]?.message?.content?.trim();
        console.log(`🤖 OpenAI general reply received.`);
        return reply;
    } catch (error) {
        let errorMsg = error.message;
        if (error.response) {
             console.error("❌ OpenAI API Error (General Reply) Status:", error.response.status);
             console.error("❌ OpenAI API Error (General Reply) Data:", JSON.stringify(error.response.data, null, 2));
             errorMsg = `API Error ${error.response.status}`;
        } else { console.error("❌ Error calling OpenAI API for general reply:", errorMsg); }
        return `حصل خطأ (${errorMsg}) أثناء محاولة التواصل مع الذكاء الاصطناعي.`;
    }
}

// --- Function for parsing reminders (MODIFIED TO USE HISTORY) ---
// Takes conversationId (user's 'from' number) as the second argument now
async function parseReminderWithOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { /* ... key check ... */ return null; }
    if (!conversationId) { /* ... conversationId check ... */ return null; }

    const nowInCairo = DateTime.now().setZone(TIME_ZONE);
    const currentTimeString = nowInCairo.toFormat("yyyy-MM-dd HH:mm ZZZZ");
    // Inject current time into the template read from file
    const systemPrompt = reminderParserSystemPromptTemplate.replace('{currentTime}', currentTimeString);

    // --- <<< Get recent history before calling API >>> ---
    const history = await getRecentHistory(conversationId);

    // --- <<< Construct the messages array including history >>> ---
    const messages = [
        { role: "system", content: systemPrompt }, // Parsing prompt first
        ...history, // Add history
        { role: "user", content: userMessage } // Add current user message
    ];

    try {
        console.log(`🤖 Sending reminder parse query to OpenAI with ${history.length} history messages. Current message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: messages, // Send array including history
            temperature: 0.1,
            max_tokens: 150,
            response_format: { type: "json_object" }
        }, { /* ... headers ... */ });

        // --- Rest of JSON parsing logic --- (Same as before)
        let responseData = response.data.choices?.[0]?.message?.content;
        console.log(`🤖 OpenAI raw parsing response: "${responseData}"`);
        if (!responseData) { /* ... handle empty response ... */ return null; }
        let parsedJson;
        try {
            if (typeof responseData === 'string') {
                if (responseData.trim().toLowerCase() === 'null') { /* ... handle "null" string ... */ return null; }
                 responseData = responseData.replace(/^```json\s*/, '').replace(/\s*```$/, '');
                 parsedJson = JSON.parse(responseData);
            } else if (typeof responseData === 'object' && responseData !== null) { parsedJson = responseData; }
            else { /* ... handle unexpected type ... */ return null; }

            if (parsedJson && typeof parsedJson.reminder_text === 'string' && typeof parsedJson.local_datetime_iso === 'string') {
                 if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(parsedJson.local_datetime_iso)) {
                     console.log("✅ Successfully parsed JSON from OpenAI:", parsedJson);
                     return parsedJson;
                 } else { /* ... handle incorrect date format ... */ return null; }
            } else { /* ... handle missing fields ... */ return null; }
        } catch (jsonError) { /* ... handle JSON parse error ... */ return null; }
        // --- End of JSON parsing logic ---

    } catch (error) { /* ... API call error handling ... */ return null; }
}


// Export the functions needed by webhook.js
module.exports = {
    getReplyFromOpenAI,
    parseReminderWithOpenAI
};
