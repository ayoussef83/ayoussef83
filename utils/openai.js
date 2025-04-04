// utils/openai.js (Implementing Function Calling - CORRECTED axios call)
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
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '4', 10); // Using 4 based on last successful test

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

// --- Read prompts from files ---
const generalSystemPrompt = readPromptFromFile('generalPrompt.txt');
const reminderParserSystemPromptTemplate = readPromptFromFile('reminderParserPrompt.txt');


// --- Tool Definition for findReminders ---
const findRemindersTool = {
  type: "function",
  function: {
    name: "findReminders",
    description: "Searches the user's scheduled reminders based on an optional date phrase (like 'tomorrow', 'today', 'June 18th', 'next monday', 'that day') or an optional subject keyword extracted from the user query. Use this when the user asks about their schedule, appointments, or specific reminders.",
    parameters: {
      type: "object",
      properties: {
        date_phrase: { type: "string", description: "Date phrase mentioned by user (e.g., 'tomorrow', 'June 18th', 'that travel day')" },
        subject: { type: "string", description: "Keyword/subject to search in reminder text (e.g., 'flight', 'Ehab', 'meeting')" }
      },
      required: []
    }
  }
};


// --- Function to get recent message history ---
async function getRecentHistory(conversationId, limit = HISTORY_LIMIT) {
    console.log(`ℹ️ Fetching recent history for ${conversationId}, limit: ${limit}`);
    try {
        const db = getDb();
        if (!db) { console.warn("⚠️ DB instance unavailable fetching history."); return []; }
        const historyCollection = db.collection('message_history');
        const recentMessages = await historyCollection.find({ conversationId: conversationId }).sort({ timestamp: -1 }).limit(limit).toArray();
        const formattedHistory = recentMessages.reverse().map(msg => ({ role: msg.role, content: msg.content }));
        console.log(`✅ Retrieved ${formattedHistory.length} messages from history.`);
        return formattedHistory;
    } catch (error) { console.error(`❌ Error fetching history:`, error); return []; }
}


// --- Primary Function: Handles Chat & Tool Calls ---
async function getOpenAIResponseAndTools(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { /* ... key check ... */ return { type: 'error', content: 'AI service unavailable' }; }
    if (!conversationId) { /* ... id check ... */ return { type: 'error', content: 'Internal error (no conv ID)' }; }

    const systemPrompt = generalSystemPrompt + "\n\nIf the user asks about their schedule or reminders, use the 'findReminders' tool to get the information before answering.";
    const history = await getRecentHistory(conversationId);
    const messages = [ { role: "system", content: systemPrompt }, ...history, { role: "user", content: userMessage } ];

    try {
        console.log(`🤖 Sending query to OpenAI (Model: ${OPENAI_MODEL}) with tools. History size: ${history.length}. Message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: messages,
            tools: [findRemindersTool],
            tool_choice: "auto",
            max_tokens: 250
        // --- <<< الجزء ده تم تصحيحه ---<<<
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json' // Added Content-Type header
            }
        }); // <<< الأقواس الناقصة تم إضافتها >>>

        const responseMessage = response.data.choices?.[0]?.message;
        if (!responseMessage) { /* ... handle no response ... */ return { type: 'error', content: 'No response from AI' }; }

        // Check for tool calls
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const toolCall = responseMessage.tool_calls[0];
            console.log(`✅ OpenAI decided to call tool: ${toolCall.function.name}`);
            if (toolCall.function.name === "findReminders") {
                try {
                    const args = JSON.parse(toolCall.function.arguments);
                    return { type: 'tool_call', call_id: toolCall.id, name: 'findReminders', arguments: { date_phrase: args.date_phrase, subject: args.subject }, original_messages: messages, original_tool_call_response: responseMessage };
                } catch (parseError) { console.error("❌ Error parsing tool arguments:", parseError); return { type: 'error', content: 'Error processing AI tool request' }; }
            } else { console.warn("⚠️ Unknown tool requested:", toolCall.function.name); return { type: 'error', content: 'Unsupported tool request' }; }
        }
        // Check for direct content
        else if (responseMessage.content) {
            console.log(`✅ OpenAI provided direct text reply.`);
            return { type: 'content', content: responseMessage.content.trim() };
        }
        // Fallback
        else { console.warn("⚠️ OpenAI response had no content/tool calls."); return { type: 'content', content: "معلش، ممكن تجرب تاني؟" }; }

    } catch (error) { /* ... API error handling ... */ let errorMsg = error.message; if (error.response) { /* log details */ errorMsg = `API Error ${error.response.status}`; } else { console.error("❌ Error calling OpenAI API with tools:", errorMsg); } return { type: 'error', content: `حصل خطأ (${errorMsg}) مع الـ AI.` }; }
}

// --- Reminder Parsing Function (Separate, uses JSON mode) ---
async function parseReminderWithOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { /* ... key check ... */ return null; }
    if (!conversationId) { /* ... id check ... */ return null; }
    // Using HISTORY_LIMIT for this parser as well now, set default lower if needed via Env Var
    const history = await getRecentHistory(conversationId, parseInt(process.env.REMINDER_HISTORY_LIMIT || `${HISTORY_LIMIT}`, 10));
    const nowInCairo = DateTime.now().setZone(TIME_ZONE);
    const currentTimeString = nowInCairo.toFormat("yyyy-MM-dd HH:mm ZZZZ");
    const systemPrompt = reminderParserSystemPromptTemplate.replace('{currentTime}', currentTimeString);
    const messages = [ { role: "system", content: systemPrompt }, ...history, { role: "user", content: userMessage } ];
    try {
        console.log(`🤖 Sending reminder parse query (JSON Mode) with ${history.length} history messages.`);
        const response = await axios.post(OPENAI_API_URL, { model: OPENAI_MODEL, messages: messages, temperature: 0.1, max_tokens: 150, response_format: { type: "json_object" } }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }); // Added headers here too
        // --- Rest of JSON parsing logic --- (Same as before)
        let responseData = response.data.choices?.[0]?.message?.content; console.log(`🤖 OpenAI raw parsing response: "${responseData}"`); if (!responseData) { console.warn("⚠️ OpenAI parsing response empty."); return null; } let parsedJson; try { if (typeof responseData === 'string') { if (responseData.trim().toLowerCase() === 'null') { console.log("⚠️ OpenAI returned null string."); return null; } responseData = responseData.replace(/^```json\s*/, '').replace(/\s*```$/, ''); parsedJson = JSON.parse(responseData); } else if (typeof responseData === 'object' && responseData !== null) { parsedJson = responseData; } else { console.warn("⚠️ Unexpected OpenAI response type."); return null; } if (parsedJson && typeof parsedJson.reminder_text === 'string' && typeof parsedJson.local_datetime_iso === 'string') { if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(parsedJson.local_datetime_iso)) { console.log("✅ Successfully parsed JSON from OpenAI:", parsedJson); return parsedJson; } else { console.warn("⚠️ OpenAI JSON date format incorrect:", parsedJson.local_datetime_iso); return null; } } else { console.warn("⚠️ OpenAI JSON missing fields/wrong types:", parsedJson); return null; } } catch (jsonError) { console.error("❌ Error parsing JSON response:", jsonError.message); return null; }
    } catch (error) { /* ... API call error handling ... */ return null; }
}

// Export the main interaction function and the specialized parser
module.exports = {
    getOpenAIResponseAndTools,
    parseReminderWithOpenAI
};
