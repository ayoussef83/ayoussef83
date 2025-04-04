// utils/openai.js
const axios = require('axios');
const fs = require('fs');
const path = require('path'); // نستخدم path عشان نضمن المسار صح
require('dotenv').config(); // يفضل تكون في index.js بس

const OPENAI_TOKEN = process.env.OPENAI_TOKEN;

// بناء المسار الكامل لملف الـ prompt
// __dirname يمثل المسار الحالي للملف ده (utils), نرجع خطوة للخلف وندخل config
const promptFilePath = path.join(__dirname, '..', 'config', 'azoozPrompt.txt');
let systemPrompt = 'You are a helpful assistant.'; // قيمة افتراضية لو الملف مش موجود

try {
    // قراءة الـ prompt من الملف
    systemPrompt = fs.readFileSync(promptFilePath, 'utf-8');
    console.log("System prompt loaded successfully.");
} catch (err) {
    console.error(`❌ Error loading system prompt from ${promptFilePath}:`, err.message);
    console.error("Using default system prompt.");
    // في حالة الخطأ، سيتم استخدام القيمة الافتراضية اللي فوق
}


async function getReplyFromOpenAI(userMessage) {
  if (!OPENAI_TOKEN) {
     console.error('❌ OpenAI Token is missing!');
     return "أنا آسف، فيه مشكلة في الإعدادات عندي ومش قادر أتصل بـ OpenAI حالياً.";
  }
  if (!userMessage) {
      console.log('No user message provided to OpenAI.');
      return "محتاج تبعتلي رسالة عشان أقدر أرد عليك.";
  }

  try {
    console.log(`Sending to OpenAI: [System: ${systemPrompt.substring(0,50)}...], [User: ${userMessage}]`);
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o', // أو الموديل اللي تفضله
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000 // زيادة الـ timeout شوية لـ OpenAI (20 ثانية)
      }
    );

    const reply = response.data.choices?.[0]?.message?.content?.trim();

    if (reply) {
         console.log("Received reply from OpenAI.");
         return reply;
    } else {
        console.error('❌ OpenAI response structure might have changed or reply is empty.');
        console.error('Full OpenAI Response:', JSON.stringify(response.data, null, 2));
        return "حصلت حاجة غريبة ومقدرتش أفهم الرد من OpenAI.";
    }

  } catch (err) {
    console.error('❌ OpenAI API error:');
    if (err.response) {
       console.error('Status:', err.response.status);
       console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
        console.error(err.message);
    }
    return "حصلت مشكلة وأنا بحاول أكلم OpenAI، جرب تبعت تاني كمان شوية 🙏";
  }
}

module.exports = { getReplyFromOpenAI };
