// utils/database.js (REVISED to correctly export getDb)
const { MongoClient, ServerApiVersion } = require('mongodb');
// dotenv should ideally be called only ONCE at the very beginning of index.js
// Make sure you have `require('dotenv').config();` at the top of your main index.js
// require('dotenv').config(); // Remove or comment out if called in index.js

const MONGO_URI = process.env.MONGO_URI;
// Use a default name if not provided, or make DB_NAME an env variable too
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

        // Message history collection index (compound index useful for fetching recent history for a user)
        const historyCollection = db.collection(HISTORY_COLLECTION);
        await historyCollection.createIndex({ conversationId: 1, timestamp: -1 });
        console.log(`Index created/ensured on ${HISTORY_COLLECTION}.{conversationId, timestamp}.`);

        return db; // Return the db instance after successful connection and indexing
    } catch (err) {
        console.error('❌ CRITICAL: Failed to connect to MongoDB Atlas or ensure indexes:', err);
        // Exit the process if database connection fails on startup
        process.exit(1);
    }
}

/**
 * Returns the reminders collection instance. Throws an error if DB not connected.
 * @returns {import('mongodb').Collection}
 */
function getRemindersCollection() {
    if (!db) {
        console.error("❌ getRemindersCollection called before DB connection was established!");
        // It's better to throw an error here to catch programming mistakes early
        throw new Error("Database not initialized. Call connectDB first.");
    }
    return db.collection(REMINDERS_COLLECTION);
}

/** // <<<--- الدالة الجديدة والمهمة ---<<<
 * Returns the database instance. Throws an error if DB not connected.
 * Allows accessing any collection, like message_history.
 * @returns {import('mongodb').Db}
 */
function getDb() {
    if (!db) {
        console.error("❌ getDb called before DB connection was established!");
        // Throw error to ensure DB is connected before use
        throw new Error("Database not initialized. Call connectDB first.");
    }
    return db; // Return the reference to the connected database instance
}

// Export the functions needed by other modules
//           <<<--- تم إضافة getDb هنا للتصدير ---<<<
module.exports = { connectDB, getDb, getRemindersCollection };
