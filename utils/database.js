// utils/database.js (REVISED to correctly export getDb AND add findReminders)
const { MongoClient, ServerApiVersion } = require('mongodb');
// dotenv should ideally be called only ONCE at the very beginning of index.js

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'AzoozBot';
const REMINDERS_COLLECTION = 'reminders'; // Collection name for reminders
const HISTORY_COLLECTION = 'message_history'; // Collection name for history

if (!MONGO_URI) {
    console.error('❌ FATAL: MONGO_URI environment variable is not set!');
    process.exit(1); // Exit if critical config is missing
}

const client = new MongoClient(MONGO_URI, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

let db; // Module-scoped variable to hold the database instance

async function connectDB() {
    if (db) { console.log("Database connection already established."); return db; }
    try {
        console.log("Connecting to MongoDB Atlas...");
        await client.connect();
        db = client.db(DB_NAME);
        console.log(`✅ Successfully connected to MongoDB Atlas! Database: ${DB_NAME}`);
        // Ensure indexes
        const remindersCollection = db.collection(REMINDERS_COLLECTION);
        await remindersCollection.createIndex({ executeAt: 1 });
        console.log(`Index created/ensured on ${REMINDERS_COLLECTION}.executeAt field.`);
        const historyCollection = db.collection(HISTORY_COLLECTION);
        await historyCollection.createIndex({ conversationId: 1, timestamp: -1 });
        console.log(`Index created/ensured on ${HISTORY_COLLECTION}.{conversationId, timestamp}.`);
        return db;
    } catch (err) {
        console.error('❌ CRITICAL: Failed to connect to MongoDB Atlas or ensure indexes:', err);
        process.exit(1);
    }
}

function getRemindersCollection() {
    if (!db) { throw new Error("Database not initialized. Call connectDB first."); }
    return db.collection(REMINDERS_COLLECTION);
}

function getDb() {
    if (!db) { throw new Error("Database not initialized. Call connectDB first."); }
    return db;
}

/** // <<<--- الدالة الجديدة المضافة ---<<<
 * Finds reminders for a specific user based on date or subject.
 * @param {object} options
 * @param {string} options.conversationId - User's WhatsApp ID.
 * @param {Date} [options.queryDate] - Optional: Specific date (start of day, UTC).
 * @param {string} [options.querySubject] - Optional: Keyword for reminder message.
 * @returns {Promise<Array<object>>} - Array of reminder documents.
 */
async function findReminders({ conversationId, queryDate, querySubject }) {
    console.log(`ℹ️ Finding reminders for ${conversationId} with criteria: Date=${queryDate ? queryDate.toISOString().split('T')[0] : 'N/A'}, Subject=${querySubject || 'N/A'}`);
    try {
        const db = getDb();
        if (!db) { console.warn("⚠️ DB instance unavailable finding reminders."); return []; }
        const collection = getRemindersCollection();
        let query = { to: conversationId };

        if (queryDate instanceof Date && !isNaN(queryDate)) {
            const dateStart = new Date(queryDate); dateStart.setUTCHours(0, 0, 0, 0);
            const dateEnd = new Date(dateStart); dateEnd.setUTCDate(dateStart.getUTCDate() + 1);
            query.executeAt = { $gte: dateStart, $lt: dateEnd };
            console.log(`   Querying date range UTC: ${dateStart.toISOString()} to ${dateEnd.toISOString()}`);
        }
        if (querySubject && typeof querySubject === 'string' && querySubject.trim().length > 0) {
            const escapedSubject = querySubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.message = { $regex: escapedSubject, $options: 'i' };
            console.log(`   Querying subject regex: /${escapedSubject}/i`);
        }
        if (Object.keys(query).length <= 1) { console.log("⚠️ findReminders called without date/subject."); return []; }

        const reminders = await collection.find(query).sort({ executeAt: 1 }).limit(20).toArray();
        console.log(`✅ Found ${reminders.length} matching reminders.`);
        return reminders;
    } catch (error) { console.error(`❌ Error finding reminders:`, error); return []; }
}

// Export all necessary functions
//           <<<--- تم إضافة findReminders هنا للتصدير ---<<<
module.exports = { connectDB, getDb, getRemindersCollection, findReminders };
