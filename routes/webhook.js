// utils/database.js (أضف هذه الدالة وعدل الـ exports)
// ... (الكود بتاع connectDB و getDb و getRemindersCollection زي ما هو فوق) ...

/** // <<<--- الدالة الجديدة ---<<<
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
        const db = getDb();
        if (!db) {
            console.warn("⚠️ DB instance not available when trying to find reminders.");
            return [];
        }
        const collection = getRemindersCollection(); // Use existing function to get 'reminders' collection

        let query = { to: conversationId }; // Always filter by user

        // Build query based on provided date
        if (queryDate instanceof Date && !isNaN(queryDate)) {
            // Create a date range for the entire day in UTC
            // The date received should represent the start of the target day in local time,
            // we convert it to UTC start and end of day for MongoDB query.
            // Note: This assumes queryDate is already set to the START of the target day.
            const dateStart = new Date(queryDate); // Assuming queryDate is start of day UTC (or needs conversion)
            // Let's ensure it's start of day UTC
            dateStart.setUTCHours(0, 0, 0, 0);
            const dateEnd = new Date(dateStart);
            dateEnd.setUTCDate(dateStart.getUTCDate() + 1); // Start of the *next* day UTC

            query.executeAt = { $gte: dateStart, $lt: dateEnd }; // Find reminders within that UTC day
            console.log(`   Querying date range UTC: ${dateStart.toISOString()} to ${dateEnd.toISOString()}`);
        }

        // Build query based on provided subject (case-insensitive)
        if (querySubject && typeof querySubject === 'string' && querySubject.trim().length > 0) {
            // Escape special regex characters to allow searching for them literally
            const escapedSubject = querySubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.message = { $regex: escapedSubject, $options: 'i' }; // Case-insensitive regex search
            console.log(`   Querying subject regex: /${escapedSubject}/i`);
        }

        // Avoid running query if no specific criteria (date or subject) is given
        // (We should always have conversationId, so check if other keys exist)
        if (Object.keys(query).length <= 1) {
             console.log("⚠️ findReminders called without specific date or subject criteria.");
             // Depending on desired behavior, we might return an empty array or a specific indicator
             return []; // Return empty array if no specific criteria provided
        }


        // Execute the query, sort by time, limit results
        const reminders = await collection.find(query)
            .sort({ executeAt: 1 }) // Sort reminders chronologically
            .limit(20) // Limit the number of results to avoid very long messages
            .toArray();

        console.log(`✅ Found ${reminders.length} matching reminders.`);
        return reminders; // Return the array of reminder documents found

    } catch (error) {
        console.error(`❌ Error finding reminders for ${conversationId}:`, error);
        return []; // Return empty array in case of database errors
    }
}

// --- تعديل سطر module.exports ---
// Export the necessary functions, including the new findReminders
module.exports = { connectDB, getDb, getRemindersCollection, findReminders }; // Add findReminders here
