// utils/whatsapp.js (Complete - With Outgoing Message Logging)

const axios = require('axios');
// --- <<< NEW: Import DB utility HERE >>> ---
const { getDb } = require('./database'); // Adjust path if needed ('./database' if in same folder, '../utils/database' etc)

// --- Load WhatsApp Credentials from Environment Variables ---
// Make sure these environment variable names match EXACTLY what you set in Render
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Or maybe META_TOKEN? Double check your variable name
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // Double check your variable name

/**
 * Sends a text message using the WhatsApp Business API and logs the reply.
 * @param {string} to - The recipient's WhatsApp ID (phone number).
 * @param {string} text - The message text to send.
 * @returns {Promise<boolean>} - True if the API call was successful, false otherwise.
 */
async function sendWhatsAppMessage(to, text) {
    // Validate essential configuration
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error('❌ Configuration Error: WhatsApp Token or Phone Number ID is missing from environment variables!');
        // It's crucial to know if configuration is missing.
        // Depending on desired behavior, you might throw an error or return false.
        // Returning false allows the calling function to potentially handle it.
        return false;
    }

    console.log(`Attempting to send WhatsApp message via API to ${to}...`);
    // Use the correct API version URL (check Meta documentation for latest stable version)
    const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text } // WhatsApp Cloud API requires 'body' nested inside 'text'
    };

    try {
        // Make the API call to Meta
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        // Log success based on HTTP status code (usually 2xx indicates success)
        console.log(`✅ WhatsApp API call succeeded for sending message to ${to}. Status: ${response.status}`);

        // --- <<< NEW: Log outgoing assistant message to DB >>> ---
        // Attempt to log only AFTER the API call was successful
        try {
            const db = getDb(); // Get database instance
            if (db) {
                const historyCollection = db.collection('message_history');
                // Insert the bot's reply into the history
                await historyCollection.insertOne({
                    conversationId: to, // Use recipient's number as conversation ID
                    role: 'assistant',  // Role is 'assistant'
                    content: text,      // The message text that was sent
                    timestamp: new Date() // Current timestamp
                });
                console.log("📝 Bot reply saved to history.");
            } else {
                // Log a warning if DB connection isn't available for logging
                console.warn("⚠️ Could not get DB instance to save bot reply history.");
            }
        } catch (dbError) {
            // Log any error during DB saving, but don't let it stop the function
            // The message was already sent successfully to the user at this point.
            console.error("❌ Error saving bot reply to history:", dbError);
        }
        // --- <<< END NEW SECTION >>> ---

        return true; // Indicate successful sending to WhatsApp

    } catch (error) {
        // Handle errors during the WhatsApp API call
        console.error(`❌ WhatsApp API call failed for sending message to ${to}.`);
        if (error.response) {
            // Log detailed error from Meta if available
            console.error('WhatsApp API Error Status:', error.response.status);
            console.error('WhatsApp API Error Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            // Log other errors (network, etc.)
            console.error('WhatsApp API Error Message:', error.message);
        }
        return false; // Indicate sending failure
    }
}

// Export the function to be used elsewhere (e.g., in webhook.js)
module.exports = { sendWhatsAppMessage };
