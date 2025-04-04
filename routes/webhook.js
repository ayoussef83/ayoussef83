// routes/webhook.js
const express = require('express');
const { getReplyFromOpenAI } = require('../utils/openai'); // استيراد دالة OpenAI
const { sendWhatsAppMessage } = require('../utils/whatsapp'); // استيراد دالة إرسال واتساب
require('dotenv').config(); // يفضل تكون في index.js بس

const router = express.Router();

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// Verification Endpoint (GET /webhook)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ Webhook verified');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed - Incorrect Token');
      res.sendStatus(403); // Forbidden
    }
  } else {
      console.log('❌ Webhook verification failed - Missing mode or token');
      res.sendStatus(400); // Bad Request
  }
});

// Message Handler Endpoint (POST /webhook)
router.post('/', async (req, res) => {
  console.log('Received webhook event:', JSON.stringify(req.body, null, 2)); // Log the full event body for debugging

  try {
    // Meta sends an array of entries, usually just one
    const entry = req.body.entry?.[0];
    // Inside entry, changes contains the actual event details
    const change = entry?.changes?.[0];
    // The 'value' field contains message specifics
    const value = change?.value;

    // Check if it's a message event
    if (value?.messaging_product === 'whatsapp' && value?.messages?.length > 0) {
      const message = value.messages[0];
      const from = message.from; // Sender phone number

      // Handle only text messages for now
      if (message.type === 'text') {
        const msg_body = message.text?.body;

        if (msg_body && from) {
          console.log(`📩 New text message from ${from}: ${msg_body}`);

          // 1. Get reply from OpenAI
          const aiReply = await getReplyFromOpenAI(msg_body);

          // 2. Send the reply back via WhatsApp
          if (aiReply) {
            await sendWhatsAppMessage(from, aiReply);
          } else {
            console.log("No AI reply generated or returned.");
            // Maybe send a default message if AI fails?
            // await sendWhatsAppMessage(from, "معلش مش عارف أرد دلوقتي.");
          }
        } else {
             console.log("Missing message body or sender number.");
        }
      } else {
        // Handle non-text messages if needed (e.g., images, audio)
        console.log(`Received non-text message type: ${message.type} from ${from}`);
        // Optional: Send a default reply for non-text messages
        // await sendWhatsAppMessage(from, "أنا حالياً بفهم الرسايل النصية بس.");
      }
    } else {
      // Handle other types of webhook events if necessary (e.g., status updates)
      console.log('Received event is not a WhatsApp message or has no message content.');
    }

    // Respond to Meta quickly to acknowledge receipt
    res.sendStatus(200);

  } catch (err) {
    console.error('❌ Error processing webhook:', err);
    // Send 200 anyway so Meta doesn't keep retrying, but log the error
    res.sendStatus(200); // Or sendStatus(500) if you want Meta to know about the error
  }
});

module.exports = router;
