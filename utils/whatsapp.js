// utils/whatsapp.js (Complete - Cleaned Requires & Includes History Logging)

const axios = require('axios');
// --- <<< تأكد إن السطر ده موجود والمسار صح >>> ---
const { getDb } = require('./database.js'); // Assumes database.js is in the SAME utils folder

// --- Load WhatsApp Credentials from Environment Variables ---
// *** تأكد إن الأسماء دي هي نفسها اللي في Render Env Vars ***
const WHATSAPP_TOKEN = process.env.META_TOKEN; // Using META_TOKEN based on previous check
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // Assuming this name is correct

/**
 * Sends a text message using the WhatsApp Business API and logs the reply to history.
 * @param {string} to - The recipient's WhatsApp ID (phone number).
 * @param {string} text - The message text to send.
 * @returns {Promise<boolean>} - True if the API call was successful, false otherwise.
 */
async function sendWhatsAppMessage(to, text) {
    // Validate essential configuration first
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error('❌ CONFIGURATION ERROR: WhatsApp Token or Phone Number ID is missing from environment variables!');
        return false; // Cannot proceed
    }

    console.log(`Attempting to send WhatsApp message via API to ${to}...`);
    const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`; // Use a recent stable API version
    const payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
    };

    try {
        // Make the API call to Meta
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`✅ WhatsApp API call succeeded for sending message to ${to}. Status: ${response.status}`);

        // --- Log outgoing assistant message to DB ---
        // Only attempt if sending succeeded
        try {
            const db = getDb(); // Use the imported getDb function
            if (db) {
                const historyCollection = db.collection('message_history');
                await historyCollection.insertOne({
                    conversationId: to, // Use recipient's number as conversation ID
                    role: 'assistant',  // Role is 'assistant'
                    content: text,      // The message text that was sent
                    timestamp: new Date() // Current timestamp
                });
                console.log("📝 Bot reply saved to history.");
            } else {
                console.warn("⚠️ DB instance not available, cannot save bot reply history.");
            }
        } catch (dbError) {
            // Log error during DB saving, but don't treat it as a failure of sending the message itself
            console.error("❌ Error saving bot reply to history:", dbError);
        }
        // --- End Logging Outgoing Message ---

        return true; // WhatsApp send was successful

    } catch (error) {
        // Handle errors during the WhatsApp API call
        console.error(`❌ WhatsApp API call failed for sending message to ${to}.`);
        if (error.response) {
            console.error('WhatsApp API Error Status:', error.response.status);
            console.error('WhatsApp API Error Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('WhatsApp API Error Message:', error.message);
        }
        return false; // WhatsApp send failed
    }
}

// Export the function
module.exports = { sendWhatsAppMessage };

