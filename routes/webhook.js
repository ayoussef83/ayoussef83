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
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '4', 10); // Let's try 4 for history

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
    name: "findReminders", // Must match the function name the bot will execute
    description: "Searches the user's scheduled reminders based on an optional date phrase (like 'tomorrow', 'today', 'June 18th', 'next monday', 'that day') or an optional subject keyword extracted from the user query. Use this when the user asks about their schedule, appointments, or specific reminders.",
    parameters: {
      type: "object",
      properties: {
        // OpenAI will extract these parameters from the user's query
        date_phrase: {
          type: "string",
          description: "The date phrase mentioned by the user, e.g., 'tomorrow', 'today', 'June 18th', 'next monday', 'that travel day', 'the day we discussed'"
        },
        subject: {
          type: "string",
          description: "A keyword or phrase from the reminder message subject to search for, e.g., 'flight', 'meeting', 'Ehab', 'customer service'"
        }
      },
      // Neither parameter is strictly required, but the tool function needs at least one
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


// --- <<< NEW Primary Function: Handles Chat & Tool Calls >>> ---
/**
 * Gets a response from OpenAI, potentially deciding to call a tool or reply directly.
 * @param {string} userMessage - The current message from the user.
 * @param {string} conversationId - The user's WhatsApp ID.
 * @returns {Promise<object>} - An object indicating the response type:
 * { type: 'content', content: string } for direct reply
 * { type: 'tool_call', call_id: string, name: string, arguments: object } for function call
 * { type: 'error', content: string } for errors
 */
async function getOpenAIResponseAndTools(userMessage, conversationId) {
    if (!OPENAI_API_KEY) { /* ... key check ... */ return { type: 'error', content: 'AI service unavailable' }; }
    if (!conversationId) { /* ... id check ... */ return { type: 'error', content: 'Internal error (no conv ID)' }; }

    // Add instruction about tool usage to the general prompt
    const systemPrompt = generalSystemPrompt + "\n\nIf the user asks about their schedule or reminders, use the 'findReminders' tool to get the information before answering.";

    const history = await getRecentHistory(conversationId); // Fetch recent history
    const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage }
    ];

    try {
        console.log(`🤖 Sending query to OpenAI (Model: ${OPENAI_MODEL}) with tools. History size: <span class="math-inline">\{history\.length\}\. Message\: "</span>{userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: messages,
            tools: [findRemindersTool], // Provide the tool definition
            tool_choice: "auto", // Let OpenAI decide (call tool or reply directly)
            max_tokens: 250
        }, { headers: { 'Authorization
