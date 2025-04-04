// utils/openai.js (Implementing Function Calling / Tool Use)
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
// Using 4 messages for history based on previous successful context test
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '4', 10);

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
// Describes the function to OpenAI so it knows when and how to call it
const findRemindersTool = {
  type: "function",
  function: {
    name: "findReminders", // Must match the function name the bot will execute in database.js
    description: "Searches the user's scheduled reminders in the database based on an optional date phrase (like 'tomorrow', 'today', 'June 18th', 'next monday', 'that day') or an optional subject keyword extracted from the user query. Use this tool *only* when the user explicitly asks about their schedule, appointments, upcoming reminders, or asks about a specific reminder ('When is the flight reminder?'). Do not use for setting new reminders.",
    parameters: {
      type: "object",
      properties: {
        // OpenAI will attempt to extract these parameters from the user's query and conversation history
        date_phrase: {
          type: "string",
          description: "The date or time phrase mentioned by the user relevant to the query, e.g., 'tomorrow', 'today', 'June 18th', 'next monday', 'that travel day', 'the day we discussed'"
        },
        subject: {
          type: "string",
          // <<<--- تم تعديل الوصف هنا ---<<<
          description: "A keyword or phrase *in Egyptian Arabic* extracted from the user's query representing the reminder subject, e.g., 'طيارة', 'ايهاب', 'اجتماع', 'خدمة العملاء', 'المكوة'. Use the exact Arabic phrase if possible."
        }
      },
      // Neither parameter is strictly required by the schema,
      // but the underlying findReminders function expects at least one useful parameter.
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
        // Ensure messages are in the correct chronological order for the LLM
        const formattedHistory = recentMessages.reverse().map(msg => ({
             role: msg.role === 'bot' || msg.role === 'assistant' ? 'assistant' : 'user', // Normalize roles
             content: msg.content
        }));
        console.log(`✅ Retrieved ${formattedHistory.length} messages from history.`);
        return formattedHistory;
    } catch (error) { console.error(`❌ Error fetching history:`, error); return []; }
}


// --- <<< Primary Function: Handles Chat & Tool Calls >>> ---
/**
 * Gets a response from OpenAI, potentially deciding to call a tool or reply directly.
 * @param {string} userMessage - The current message from the user.
 * @param {string} conversationId - The user's WhatsApp ID.
 * @returns {Promise<object>} - An object indicating the response type:
 * { type: 'content', content: string } for direct reply
 * { type: 'tool_call', call_id: string, name: string, arguments: object, original_messages: Array, original_tool_call_response: object } for function call
 * { type: 'error', content: string } for errors
 */
async function getOpenAIResponseAndTools(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { console.error("❌ OpenAI API key missing!"); return { type: 'error', content: 'AI service unavailable' }; }
    if (!conversationId) { console.error("❌ Internal error (no conv ID)"); return { type: 'error', content: 'Internal error (no conv ID)' }; }

    // Add instruction about tool usage to the general prompt
    const systemPrompt = generalSystemPrompt + "\n\nWhen asked about schedules or specific reminders, use the 'findReminders' tool to search the database before answering. Do not invent schedule details.";

    const history = await getRecentHistory(conversationId); // Fetch recent history (limit=4 by default now)
    const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage }
    ];

    try {
        console.log(`🤖 Sending query to OpenAI (Model: ${OPENAI_MODEL}) with tools enabled. History size: ${history.length}. Message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: messages,
            tools: [findRemindersTool], // Provide the tool definition to the API
            tool_choice: "auto",        // Let OpenAI decide whether to use the tool or reply directly
            max_tokens: 250             // Response length limit
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const responseMessage = response.data.choices?.[0]?.message;

        if (!responseMessage) {
            console.warn("⚠️ No response message from OpenAI.");
            return { type: 'error', content: 'No response from AI' };
        }

        // *** Check if the response contains tool calls ***
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const toolCall = responseMessage.tool_calls[0]; // Assuming one tool call for now
            console.log(`✅ OpenAI decided to call tool: ${toolCall.function.name}`);

            if (toolCall.function.name === "findReminders") {
                try {
                    // Parse arguments provided by OpenAI
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log("🛠️ Tool arguments received from AI:", args); // Log arguments for debugging
                    // Return all necessary info for webhook.js to execute the tool and follow up
                    return {
                        type: 'tool_call',
                        call_id: toolCall.id,                   // Needed for the follow-up API call
                        name: 'findReminders',
                        arguments: {                            // Extracted arguments
                            date_phrase: args.date_phrase,
                            subject: args.subject
                        },
                        original_messages: messages,            // The messages array sent in the *first* call
                        original_tool_call_response: responseMessage // The assistant message asking for the tool call
                    };
                } catch (parseError) {
                     console.error("❌ Error parsing findReminders arguments from OpenAI:", parseError, "Arguments:", toolCall.function.arguments);
                     return { type: 'error', content: 'Error processing AI tool arguments' };
                }
            } else {
                 // Handle if OpenAI calls a tool we didn't define or expect
                 console.warn("⚠️ OpenAI requested unknown tool:", toolCall.function.name);
                 return { type: 'error', content: 'Unsupported tool request from AI' };
            }
        }
        // *** Check for direct text content if no tool call was made ***
        else if (responseMessage.content) {
            console.log(`✅ OpenAI provided direct text reply.`);
            return { type: 'content', content: responseMessage.content.trim() };
        }
        // Fallback if the response structure is unexpected
        else {
            console.warn("⚠️ OpenAI response had no content and no tool calls.");
            return { type: 'content', content: "معلش، مش عارف أرد إزاي. ممكن تجرب تاني؟" };
        }

    } catch (error) {
        // Handle errors during the initial API call
         let errorMsg = error.message;
         if (error.response) {
              console.error("❌ OpenAI API Error (getOpenAIResponseAndTools) Status:", error.response.status);
              console.error("❌ OpenAI API Error (getOpenAIResponseAndTools) Data:", JSON.stringify(error.response.data, null, 2));
              errorMsg = `API Error ${error.response.status}`;
         } else { console.error("❌ Error calling OpenAI API with tools:", errorMsg); }
         return { type: 'error', content: `حصل خطأ (${errorMsg}) مع الـ AI.` };
    }
}

// --- Reminder Parsing Function (Kept separate, uses JSON mode, not tools) ---
// This function remains for handling direct reminder commands like "ذكرني..."
async function parseReminderWithOpenAI(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { /* ... key check ... */ return null; }
    if (!conversationId) { /* ... id check ... */ return null; }
    // Use HISTORY_LIMIT for parsing context as well
    const history = await getRecentHistory(conversationId);
    const nowInCairo = DateTime.now().setZone(TIME_ZONE);
    const currentTimeString = nowInCairo.toFormat("yyyy-MM-dd HH:mm ZZZZ");
    const systemPrompt = reminderParserSystemPromptTemplate.replace('{currentTime}', currentTimeString);
    const messages = [ { role: "system", content: systemPrompt }, ...history, { role: "user", content: userMessage } ];
    try {
        console.log(`🤖 Sending reminder parse query (JSON Mode) with ${history.length} history messages.`);
        const response = await axios.post(OPENAI_API_URL, { model: OPENAI_MODEL, messages: messages, temperature: 0.1, max_tokens: 150, response_format: { type: "json_object" } }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });
        // --- Rest of JSON parsing logic --- (Same as before)
        let responseData = response.data.choices?.[0]?.message?.content; console.log(`🤖 OpenAI raw parsing response: "${responseData}"`); if (!responseData) { console.warn("⚠️ OpenAI parsing response empty."); return null; } let parsedJson; try { if (typeof responseData === 'string') { if (responseData.trim().toLowerCase() === 'null') { console.log("⚠️ OpenAI returned null string."); return null; } responseData = responseData.replace(/^```json\s*/, '').replace(/\s*```$/, ''); parsedJson = JSON.parse(responseData); } else if (typeof responseData === 'object' && responseData !== null) { parsedJson = responseData; } else { console.warn("⚠️ Unexpected OpenAI response type."); return null; } if (parsedJson && typeof parsedJson.reminder_text === 'string' && typeof parsedJson.local_datetime_iso === 'string') { if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(parsedJson.local_datetime_iso)) { console.log("✅ Successfully parsed JSON from OpenAI:", parsedJson); return parsedJson; } else { console.warn("⚠️ OpenAI JSON date format incorrect:", parsedJson.local_datetime_iso); return null; } } else { console.warn("⚠️ OpenAI JSON missing fields/wrong types:", parsedJson); return null; } } catch (jsonError) { console.error("❌ Error parsing JSON response:", jsonError.message); return null; }
    } catch (error) { /* ... API call error handling ... */ return null; }
}


// Export the functions needed by webhook.js
module.exports = {
    getOpenAIResponseAndTools, // New main function using tools
    parseReminderWithOpenAI    // Function for parsing reminder commands directly
};
