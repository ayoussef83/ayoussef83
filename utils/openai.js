// utils/openai.js (Modified with new parsing function)
const axios = require('axios');
const { DateTime } = require('luxon'); // Needed for current time context

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'; // Or your preferred API endpoint
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'; // Or gpt-4 etc.
const TIME_ZONE = 'Africa/Cairo'; // Consistent timezone

// Existing function for general replies (Keep as is or adapt if needed)
async function getReplyFromOpenAI(userMessage) {
    if (!OPENAI_API_KEY) {
        console.error("❌ OpenAI API key is missing!");
        return "آسف، خدمة الذكاء الاصطناعي غير متاحة حالياً.";
    }
    try {
        console.log(`🤖 Sending to OpenAI for general reply: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL,
            messages: [
                 // Consider adding your customized Azooz Bot persona here
                { role: "system", content: "You are Azooz Bot, a helpful and friendly WhatsApp assistant speaking Egyptian Arabic." },
                { role: "user", content: userMessage }
            ],
            max_tokens: 150,
            temperature: 0.7
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });
        const reply = response.data.choices?.[0]?.message?.content?.trim();
        console.log(`🤖 OpenAI general reply: "${reply}"`);
        return reply;
    } catch (error) {
        console.error("❌ Error calling OpenAI API for general reply:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        return "حدث خطأ أثناء محاولة التواصل مع الذكاء الاصطناعي.";
    }
}


// --- NEW FUNCTION for parsing reminders ---
async function parseReminderWithOpenAI(userMessage) {
    if (!OPENAI_API_KEY) {
        console.error("❌ OpenAI API key is missing! Cannot parse reminder.");
        return null; // Indicate failure
    }

    const nowInCairo = DateTime.now().setZone(TIME_ZONE);
    // Format includes timezone offset like EET+02:00 which helps model context
    const currentTimeString = nowInCairo.toFormat("yyyy-MM-dd HH:mm ZZZZ");

    // System prompt instructing the model how to behave and format output
    const systemPrompt = `You are an expert assistant specialized in parsing Egyptian Arabic reminder requests into structured data.
Current date and time in Cairo (${TIME_ZONE}) is: ${currentTimeString}.
Analyze the user's message to identify the core reminder text and the specific intended date and time.
The user might use colloquial terms (e.g., بكرة, بعده, كمان ساعة, الضهر, العصر, المغرب, بالليل, يوم السبت الجاي) or specific dates/times.
Convert the identified date and time into the exact format 'YYYY-MM-DD HH:mm' based on the Cairo timezone (${TIME_ZONE}).
Infer reasonable times: الضهر=12:00, العصر=15:00, المغرب=18:00, بالليل=20:00. If only a day is mentioned, assume the upcoming one. Use current year if year not specified.
Your response MUST be a valid JSON object containing ONLY 'reminder_text' (string) and 'local_datetime_iso' (string in 'YYYY-MM-DD HH:mm' format).
Example: {"reminder_text": "اكلم احمد", "local_datetime_iso": "2025-04-05 17:00"}
If you cannot confidently determine BOTH the reminder text AND a specific valid date/time in the required format, respond ONLY with the word: null`;

    try {
        console.log(`🤖 Sending to OpenAI for reminder parsing: "${userMessage}"`);
        const response = await axios.post(OPENAI_API_URL, {
            model: OPENAI_MODEL, // Consider GPT-4 for better parsing if needed
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
            temperature: 0.1, // Low temperature for deterministic parsing
            max_tokens: 150 // Should be enough for JSON or "null"
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });

        let responseText = response.data.choices?.[0]?.message?.content?.trim();
        console.log(`🤖 OpenAI raw parsing response: "${responseText}"`);

        // Check if OpenAI explicitly returned null
        if (!responseText || responseText.toLowerCase() === 'null') {
             console.log("⚠️ OpenAI indicated parsing failure (returned null).");
            return null;
        }

        // Try to parse the response as JSON
        try {
            // Clean potential markdown code fences
            responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            const parsedJson = JSON.parse(responseText);

            // Validate structure and types
            if (parsedJson && typeof parsedJson.reminder_text === 'string' && typeof parsedJson.local_datetime_iso === 'string') {
                 // Validate date format using regex
                 if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(parsedJson.local_datetime_iso)) {
                     console.log("✅ Successfully parsed JSON from OpenAI:", parsedJson);
                     return parsedJson;
                 } else {
                      console.warn("⚠️ OpenAI returned JSON but 'local_datetime_iso' format is incorrect:", parsedJson.local_datetime_iso);
                      return null;
                 }
            } else {
                console.warn("⚠️ OpenAI response JSON is missing required fields or has incorrect types:", parsedJson);
                return null;
            }
        } catch (jsonError) {
            console.error("❌ Error parsing JSON response from OpenAI:", jsonError.message, "Raw response:", responseText);
            return null; // Parsing failed
        }

    } catch (error) {
        // Log detailed error if possible
        let errorMsg = error.message;
        if (error.response) {
             console.error("❌ OpenAI API Error Status:", error.response.status);
             console.error("❌ OpenAI API Error Data:", JSON.stringify(error.response.data, null, 2));
             errorMsg = `API Error ${error.response.status}: ${JSON.stringify(error.response.data)}`;
        } else {
            console.error("❌ Error calling OpenAI API for reminder parsing:", errorMsg);
        }
        return null; // Indicate failure
    }
}

module.exports = {
    getReplyFromOpenAI,
    parseReminderWithOpenAI // Export the new function
};
