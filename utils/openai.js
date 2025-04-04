// utils/openai.js (Reads prompts from files)
const axios = require('axios');
const fs = require('fs');        // Required to read files
const path = require('path');    // Required to build file paths correctly
const { DateTime } = require('luxon'); // Required to get current time for reminder parsing context

// Load sensitive info and configs from environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Allow overriding API URL and Model via environment variables, with defaults
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-turbo'; // Defaulting to gpt-4-turbo now based on previous steps
const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Cairo'; // Default timezone

// --- Function to read prompt files safely ---
// Reads a file from the 'config' directory located one level above the 'utils' directory
function readPromptFromFile(fileName) {
    try {
        // Construct the absolute path: __dirname is the current directory (utils), '..' goes up one level, 'config' enters config folder, then the filename
        const filePath = path.join(__dirname, '../config', fileName);
        console.log(`Attempting to read prompt from: ${filePath}`); // Log path for debugging deployment path issues
        // Read file content synchronously (usually okay at startup) and trim whitespace
        const promptText = fs.readFileSync(filePath, 'utf8').trim();
         if (!promptText) {
             // If the file is empty, it's an error
             throw new Error(`Prompt file is empty: ${fileName}`);
         }
         console.log(`Successfully read prompt from: ${fileName}`);
        return promptText; // Return the file content
    } catch (error) {
        // Log a critical error if reading fails (e.g., file not found, permissions)
        console.error(`❌ FATAL ERROR: Could not read or parse prompt file: ${fileName}`, error);
        // Stop the application by throwing an error - safer than running with missing prompts
        throw new Error(`Failed to read prompt file: ${fileName}. Check server configuration, file existence, content, and permissions.`);
    }
}

// --- Read prompts from files ONCE when the module loads (at application startup) ---
// Reads the prompt defining the bot's general personality and language style
const generalSystemPrompt = readPromptFromFile('generalPrompt.txt');
// Reads the prompt containing detailed instructions for parsing reminders and time
// This template should contain the placeholder "{currentTime}"
const reminderParserSystemPromptTemplate = readPromptFromFile('reminderParserPrompt.txt');


// --- Function for generating general conversational replies ---
async function getReplyFromOpenAI(userMessage) {
    if (!OPENAI_API_KEY) {
        console.error("❌ OpenAI API key is missing from environment variables!");
        return "آسف، خدمة الذكاء الاصطناعي غير متاحة حالياً بسبب مشكلة في الإعدادات."; // Provide a clearer error message
    }

    // Use the general system prompt read from the file
    const systemPrompt = generalSystemPrompt;
    // We don't inject current time here unless the prompt itself needs it dynamically for general chat.
    // We are handling "What time is it?" specifically in webhook.js for accuracy.

    try {
        console.log(`🤖 Sending to OpenAI (Model: ${OPENAI_MODEL}) for general reply. Message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: [
                { role: "system", content: systemPrompt }, // Use the prompt read from file
                { role: "user", content: userMessage }
            ],
            max_tokens: 150, // Max length of the generated reply
            temperature: 0.7 // Controls creativity (0=deterministic, 1=max creative)
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });
        const reply = response.data.choices?.[0]?.message?.content?.trim();
        console.log(`🤖 OpenAI general reply received.`);
        return reply; // Return the generated text reply
    } catch (error) {
        // Handle potential errors during the API call
        let errorMsg = error.message;
        if (error.response) {
             // Log detailed API error from OpenAI if available
             console.error("❌ OpenAI API Error (General Reply) Status:", error.response.status);
             console.error("❌ OpenAI API Error (General Reply) Data:", JSON.stringify(error.response.data, null, 2));
             errorMsg = `API Error ${error.response.status}`; // Keep user-facing error concise
        } else {
            // Log other errors (e.g., network)
            console.error("❌ Error calling OpenAI API for general reply:", errorMsg);
        }
        // Return an error message (avoid exposing too many details)
        return `حصل خطأ (${errorMsg}) أثناء محاولة التواصل مع الذكاء الاصطناعي.`;
    }
}

// --- Function for parsing reminder requests ---
async function parseReminderWithOpenAI(userMessage) {
    if (!OPENAI_API_KEY) {
        console.error("❌ OpenAI API key is missing! Cannot parse reminder.");
        return null; // Return null to indicate failure clearly
    }

    // Get the current time to provide context to the prompt
    const nowInCairo = DateTime.now().setZone(TIME_ZONE);
    const currentTimeString = nowInCairo.toFormat("yyyy-MM-dd HH:mm ZZZZ"); // e.g., "2025-04-04 18:55 EET+02:00"

    // Replace the placeholder in the template string read from the file
    // Make sure reminderParserPrompt.txt contains the exact string "{currentTime}"
    const systemPrompt = reminderParserSystemPromptTemplate.replace('{currentTime}', currentTimeString);

    try {
        console.log(`🤖 Sending to OpenAI (Model: ${OPENAI_MODEL}) for reminder parsing. Message: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL, // Use the configured model (now gpt-4-turbo)
            messages: [
                { role: "system", content: systemPrompt }, // Use the specific parsing prompt read from file
                { role: "user", content: userMessage }
            ],
            temperature: 0.1, // Low temperature for more deterministic parsing results
            max_tokens: 150, // Should be sufficient for the JSON output or "null"
            response_format: { type: "json_object" } // Explicitly request JSON output format
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });

        let responseData = response.data.choices?.[0]?.message?.content; // Get the raw response content
        console.log(`🤖 OpenAI raw parsing response: "${responseData}"`);

        // If response_format: json_object worked, responseData might already be an object
        // If not, it might be a string containing "null" or a JSON string.
        if (!responseData) {
             console.warn("⚠️ OpenAI parsing response is empty.");
             return null;
        }

        let parsedJson;
        try {
            // Handle potential string responses first
            if (typeof responseData === 'string') {
                // Check if the response is just the word "null"
                if (responseData.trim().toLowerCase() === 'null') {
                    console.log("⚠️ OpenAI indicated parsing failure (returned null string).");
                    return null;
                }
                // Attempt to parse the string as JSON (clean markdown fences first)
                 responseData = responseData.replace(/^```json\s*/, '').replace(/\s*```$/, '');
                 parsedJson = JSON.parse(responseData);
            } else if (typeof responseData === 'object' && responseData !== null) {
                 // If API returned an object directly (because of response_format)
                 parsedJson = responseData;
            } else {
                 // Handle unexpected response types
                 console.warn("⚠️ Unexpected response type from OpenAI parsing:", typeof responseData);
                 return null;
            }

            // Validate the structure and types of the parsed JSON object
            if (parsedJson && typeof parsedJson.reminder_text === 'string' && typeof parsedJson.local_datetime_iso === 'string') {
                 // Validate the date format specifically using regex
                 if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(parsedJson.local_datetime_iso)) {
                     console.log("✅ Successfully parsed JSON from OpenAI:", parsedJson);
                     return parsedJson; // Return the valid parsed object
                 } else {
                      console.warn("⚠️ OpenAI returned JSON but 'local_datetime_iso' format is incorrect:", parsedJson.local_datetime_iso);
                      return null; // Format validation failed
                 }
            } else {
                console.warn("⚠️ OpenAI response JSON is missing required fields ('reminder_text', 'local_datetime_iso') or has incorrect types:", parsedJson);
                return null; // Structure validation failed
            }
        } catch (jsonError) {
            // Handle errors occurring during JSON parsing
            console.error("❌ Error parsing JSON response from OpenAI:", jsonError.message, "Raw response string/object:", responseData);
            return null; // Parsing failed
        }

    } catch (error) {
        // Handle errors during the API call itself
        let errorMsg = error.message;
        if (error.response) {
             console.error("❌ OpenAI API Error (Parsing) Status:", error.response.status);
             console.error("❌ OpenAI API Error (Parsing) Data:", JSON.stringify(error.response.data, null, 2));
             errorMsg = `API Error ${error.response.status}`;
        } else {
            console.error("❌ Error calling OpenAI API for reminder parsing:", errorMsg);
        }
        // Do not expose potentially sensitive error details directly, just signal failure
        return null;
    }
}

// Export the functions so they can be used in routes/webhook.js
module.exports = {
    getReplyFromOpenAI,
    parseReminderWithOpenAI
};
