// utils/database.js (REVISED to export getDb AND add findReminders)
const { MongoClient, ServerApiVersion } = require('mongodb');
// dotenv should ideally be called only ONCE at the very beginning of index.js
// Make sure you have `require('dotenv').config();` at the top of your main index.js

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'AzoozBot';
const REMINDERS_COLLECTION = 'reminders'; // Collection name for reminders
const HISTORY_COLLECTION = 'message_history'; // Collection name for history

if (!MONGO_URI) {
    console.error('❌ FATAL: MONGO_URI environment variable is not set!');
    process.exit(1); // Exit if critical config is missing
}

// Create a single MongoClient instance to be reused
const client = new MongoClient(MONGO_URI, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Module-scoped variable to hold the database instance once connected
let db;

/**
 * Connects to the MongoDB database, assigns the db instance, and ensures necessary indexes.
 * Should be called once at application startup.
 */
async function connectDB() {
    if (db) {
        console.log("Database connection already established.");
        return db; // Return existing connection
    }
    try {
        console.log("Connecting to MongoDB Atlas...");
        await client.connect(); // Connect the client
        db = client.db(DB_NAME); // Assign the database instance
        console.log(`✅ Successfully connected to MongoDB Atlas! Database: ${DB_NAME}`);

        // Ensure indexes exist for optimal query performance
        // Reminder collection index
        const remindersCollection = db.collection(REMINDERS_COLLECTION);
        await remindersCollection.createIndex({ executeAt: 1 });
        console.log(`Index created/ensured on ${REMINDERS_COLLECTION}.executeAt field.`);

        // Message history collection index
        const historyCollection = db.collection(HISTORY_COLLECTION);
        await historyCollection.createIndex({ conversationId: 1, timestamp: -1 });
        console.log(`Index created/ensured on ${HISTORY_COLLECTION}.{conversationId, timestamp}.`);

        return db; // Return the db instance after successful connection and indexing
    } catch (err) {
        console.error('❌ CRITICAL: Failed to connect to MongoDB Atlas or ensure indexes:', err);
        process.exit(1); // Exit the process if DB connection fails on startup
    }
}

/**
 * Returns the reminders collection instance. Throws an error if DB not connected.
 * @returns {import('mongodb').Collection}
 */
function getRemindersCollection() {
    if (!db) {
        console.error("❌ getRemindersCollection called before DB connection was established!");
        throw new Error("Database not initialized. Call connectDB first.");
    }
    return db.collection(REMINDERS_COLLECTION);
}

/**
 * Returns the database instance. Throws an error if DB not connected.
 * @returns {import('mongodb').Db}
 */
function getDb() {
    if (!db) {
        console.error("❌ getDb called before DB connection was established!");
        throw new Error("Database not initialized. Call connectDB first.");
    }
    return db; // Return the reference to the connected database instance
}


/** // <<<--- الدالة الجديدة المضافة ---<<<
 * Finds reminders for a specific user based on date or subject.
 * @param {object} options
 * @param {string} options.conversationId - The user's WhatsApp ID.
 * @param {Date} [options.queryDate] - Optional: The specific date to search for (start of day, UTC).
 * @param {string} [options.querySubject] - Optional: A keyword to search within the reminder message.
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of reminder documents.
 */
async function findReminders({ conversationId, queryDate, querySubject }) {
    console.log(`ℹ️ Finding reminders for ${conversationId} with criteria: Date=${queryDate ? queryDate.toISOString().split('T')[0] : 'N/A'}, Subject=${querySubject || 'N/A'}`);
    try {
        const db = getDb(); // Use the function we just defined
        if (!db) {
            // This case should ideally be prevented by the check inside getDb()
            console.warn("⚠️ DB instance not available when trying to find reminders.");
            return [];
        }
        // Use the specific function to get the reminders collection
        const collection = getRemindersCollection();

        let query = { to: conversationId }; // Always filter by the specific user

        // Add date criteria if a valid date is provided
        if (queryDate instanceof Date && !isNaN(queryDate)) {
            // Construct a date range for the entire day in UTC
            const dateStart = new Date(queryDate);
            dateStart.setUTCHours(0, 0, 0, 0); // Start of the day UTC
            const dateEnd = new Date(dateStart);
            dateEnd.setUTCDate(dateStart.getUTCDate() + 1); // Start of the next day UTC
            query.executeAt = { $gte: dateStart, $lt: dateEnd }; // Find reminders within that UTC day
            console.log(`   Querying date range UTC: ${dateStart.toISOString()} to ${dateEnd.toISOString()}`);
        }

        // Add subject criteria if a valid subject string is provided
        if (querySubject && typeof querySubject === 'string' && querySubject.trim().length > 0) {
            // Escape special regex characters to prevent errors and allow literal search
            const escapedSubject = querySubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Use case-insensitive regex search on the 'message' field
            query.message = { $regex: escapedSubject, $options: 'i' };
            console.log(`   Querying subject regex: /${escapedSubject}/i`);
        }

        // Ensure at least one specific filter (date or subject) is applied besides the user ID
        if (Object.keys(query).length <= 1) {
             console.log("⚠️ findReminders called without specific date or subject criteria.");
             return []; // Return empty if query is too broad
        }

        // Execute the MongoDB find query
        const reminders = await collection.find(query)
            .sort({ executeAt: 1 }) // Sort results by execution time
            .limit(20) // Limit results to prevent excessively long replies
            .toArray();

        console.log(`✅ Found ${reminders.length} matching reminders.`);
        return reminders; // Return the array of found reminder documents

    } catch (error) {
        console.error(`❌ Error finding reminders for ${conversationId}:`, error);
        return []; // Return empty array in case of database query errors
    }
}


// Export all necessary functions for other modules
//           <<<--- تم إضافة findReminders هنا ---<<<
module.exports = { connectDB, getDb, getRemindersCollection, findReminders };
