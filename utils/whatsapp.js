// utils/whatsapp.js
const axios = require('axios');
require('dotenv').config(); // الأفضل دي تكون في index.js بس، لكن هنسيبها هنا مؤقتاً

const META_TOKEN = process.env.META_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/**
 * إرسال رسالة واتساب
 * @param {string} to - رقم المستلم
 * @param {string} message - نص الرسالة
 */
async function sendWhatsAppMessage(to, message) {
  // التأكد من وجود المتغيرات قبل الإرسال
  if (!META_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !to || !message) {
    console.error('❌ Missing required info for sending WhatsApp message.');
    console.error(`Token Exists: ${!!META_TOKEN}, PhoneID Exists: ${!!WHATSAPP_PHONE_NUMBER_ID}, To: ${to}, Message: ${message}`);
    return; // لا تحاول الإرسال إذا كانت المعلومات ناقصة
  }

  try {
    console.log(`Attempting to send message to ${to}...`);
    await axios.post(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${META_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000 // إضافة timeout (10 ثواني) عشان العملية متفضلش معلقة لو فيه مشكلة
      }
    );
    console.log(`✅ Message sending API call succeeded for ${to}`);
  } catch (err) {
    // طباعة تفاصيل الخطأ الوارد من Meta API إن أمكن
    let errorMessage = err.message;
    if (err.response) {
       console.error('❌ Error sending WhatsApp message - Status:', err.response.status);
       console.error('❌ Error sending WhatsApp message - Data:', JSON.stringify(err.response.data, null, 2));
       errorMessage = err.response.data?.error?.message || JSON.stringify(err.response.data);
    } else {
        console.error('❌ Error sending WhatsApp message:', errorMessage);
    }
    // ممكن هنا تبعت لنفسك إشعار بالخطأ لو حابب
  }
}

module.exports = { sendWhatsAppMessage };
