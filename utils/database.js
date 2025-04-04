// utils/database.js
 const { MongoClient, ServerApiVersion } = require('mongodb');
 require('dotenv').config(); // يفضل تكون في index.js بس
 
 const MONGO_URI = process.env.MONGO_URI;
 const DB_NAME = 'AzoozBot'; // ممكن تختار أي اسم لقاعدة البيانات بتاعتك
 const REMINDERS_COLLECTION = 'reminders'; // اسم الـ collection اللي هنخزن فيه التذكيرات
 
 if (!MONGO_URI) {
     console.error('❌ MONGO_URI environment variable is not set!');
     // في بيئة الإنتاج، قد يكون من الأفضل إيقاف التطبيق هنا
     // process.exit(1);
 }
 
 // إنشاء Client مرة واحدة وإعادة استخدامه
 const client = new MongoClient(MONGO_URI, {
     serverApi: {
         version: ServerApiVersion.v1,
         strict: true,
         deprecationErrors: true,
     }
 });
 
 let db;
 
 /**
  * الاتصال بقاعدة البيانات وتهيئتها
  */
 async function connectDB() {
     if (db) {
         // لو متصلين بالفعل، رجع الاتصال الحالي
         return db;
     }
     try {
         console.log("Connecting to MongoDB Atlas...");
         await client.connect();
         db = client.db(DB_NAME);
         console.log(`✅ Successfully connected to MongoDB Atlas! Database: ${DB_NAME}`);
         // ممكن نعمل هنا ensureIndex لو محتاجين index معين للتذكيرات (مثلاً على وقت التنفيذ)
          await db.collection(REMINDERS_COLLECTION).createIndex({ executeAt: 1 });
          console.log("Index created/ensured on executeAt field.");
         return db;
     } catch (err) {
         console.error('❌ Failed to connect to MongoDB Atlas:', err);
         // في بيئة الإنتاج، قد يكون من الأفضل إيقاف التطبيق هنا
         // process.exit(1);
         throw err; // إعادة رمي الخطأ للتعامل معه في مكان أعلى إذا لزم الأمر
     }
 }
 
 /**
  * الحصول على collection التذكيرات
  * @returns {import('mongodb').Collection}
  */
 function getRemindersCollection() {
     if (!db) {
         console.error("Database not connected yet. Call connectDB first.");
         // أو ممكن نحاول نتصل تلقائياً هنا
         // throw new Error("Database not connected.");
         // الطريقة الأبسط هي الاعتماد على أن connectDB تم استدعاؤها عند بدء التشغيل
         return null; // Or handle error appropriately
     }
     return db.collection(REMINDERS_COLLECTION);
 }
 
 // تصدير الدوال اللي هنحتاجها
 module.exports = { connectDB, getRemindersCollection };
