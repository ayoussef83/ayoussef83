// utils/whatsapp.js
const axios = require('axios');

// Note: dotenv.config() should ideally be called only once in index.js
// require('dotenv').config();

const META_TOKEN = process.env.META_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/**
 * Sends a WhatsApp message using the Meta Graph API.
 * @param {string} to - Recipient's phone number (with country code)
 * @param {string} message - Message text
 */
async function sendWhatsAppMessage(to, message) {
    if (!META_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error('❌ Missing META_TOKEN or WHATSAPP_PHONE_NUMBER_ID in environment variables for sending WhatsApp message.');
        return; // Don't attempt to send if config is missing
    }
     if (!to || !message) {
        console.error(`❌ Missing 'to' (${to}) or 'message' (${message}) parameter for sendWhatsAppMessage.`);
        return; // Don't attempt to send if parameters are missing
    }

    const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: message },
    };
    const config = {
        headers: {
            'Authorization': `Bearer ${META_TOKEN}`,
            'Content-Type': 'application/json',
        },
        timeout: 15000 // Timeout for Meta API call (15 seconds)
    };

    try {
        console.log(`Attempting to send WhatsApp message to ${to}...`);
        await axios.post(url, payload, config);
        console.log(`✅ WhatsApp API call succeeded for sending message to ${to}`);
    } catch (err) {
        console.error(`❌ Error sending WhatsApp message to ${to}:`);
        if (err.response) {
           console.error('Status:', err.response.status);
           // Log the detailed error message from Meta if available
           const fbError = err.response.data?.error;
           if (fbError) {
                console.error('Meta Error:', JSON.stringify(fbError, null, 2));
           } else {
               console.error('Data:', JSON.stringify(err.response.data, null, 2));
           }
        } else if (err.request) {
            console.error('No response received from Meta:', err.message);
        } else {
            console.error('Error setting up Meta request:', err.message);
        }
        // Rethrow the error if you want the caller (e.g., scheduler) to know about the failure
        // throw err;
    }
}

module.exports = { sendWhatsAppMessage };
