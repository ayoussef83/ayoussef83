// جوه router.post في ملف routes/webhook.js
// قبل: if (!reminderProcessed && !handledSpecifically) { /* General OpenAI reply */ }

                    // 4. NEW: Check for Schedule Query (if not reminder and not specific time query)
                    //    <<<--- إضافة هذا الجزء كاملاً ---<<<
                    if (!reminderProcessed && !handledSpecifically) {
                        const lowerMsg = msg_body.toLowerCase();
                        let queryDate = null;
                        let querySubject = null;
                        let isScheduleQuery = false;
                        let extractedDatePhrase = null;

                        // --- محاولة بسيطة لاستخلاص التاريخ والموضوع ---
                        // يبحث عن كلمات تدل على استعلام + كلمة تدل على زمن
                        const scheduleKeywords = ["مواعيد", "عندي ايه", "في ايه", "ايه جدول", "ايه تذكيرات"];
                        const dateKeywords = ["بكرة", "غدا", "النهاردة", "اليوم"]; // ممكن نضيف أيام الأسبوع بعدين

                        // Check if message contains schedule keywords
                        if (scheduleKeywords.some(keyword => lowerMsg.includes(keyword))) {
                            isScheduleQuery = true;
                            // Try to extract a simple date phrase
                            if (lowerMsg.includes("بكرة") || lowerMsg.includes("غدا")) {
                                extractedDatePhrase = "بكرة";
                                queryDate = DateTime.now().setZone(TIME_ZONE).plus({ days: 1 }).startOf('day').toJSDate();
                            } else if (lowerMsg.includes("النهاردة") || lowerMsg.includes("اليوم")) {
                                // Check if it's asking about "today" or "that day" (context needed)
                                if (lowerMsg.includes("اليوم ده") || lowerMsg.includes("اليوم دا")) {
                                     // Needs context - for now, we don't handle this complex case reliably here
                                     // We rely on the general AI to potentially understand it better with history.
                                     // Let's make it ask for clarification for now if "اليوم ده" is used in query.
                                     isScheduleQuery = true; // Still mark as query intent
                                     queryDate = null; // Force clarification
                                     extractedDatePhrase = "اليوم ده";
                                } else {
                                    extractedDatePhrase = "النهاردة";
                                    queryDate = DateTime.now().setZone(TIME_ZONE).startOf('day').toJSDate();
                                }
                            }
                            // Add more date phrase checks here (e.g., day names, specific dates - requires more parsing)
                        }

                        // Check for questions like "When is X reminder?"
                         const subjectQueryMatch = msg_body.match(/^(?:امتى|معاد|تذكير)\s+(.+)/i);
                         if (subjectQueryMatch && subjectQueryMatch[1]) {
                             querySubject = subjectQueryMatch[1].replace(/[؟?]/g, '').trim(); // Remove question marks
                             isScheduleQuery = true;
                             // If subject query, don't assume a date unless mentioned
                             // queryDate = null; // Let findReminders search all dates for this subject
                         } else if (lowerMsg.includes("بتاع السفر") && !querySubject && isScheduleQuery) {
                              // Handle "travel day" context explicitly as subject if schedule query detected
                              querySubject = "طيارة"; // Assume subject based on keyword
                         }


                        // --- تنفيذ الاستعلام لو الشروط متحققة ---
                        // Execute only if it seems like a schedule query AND we have a date OR a subject
                        if (isScheduleQuery && (queryDate || querySubject)) {
                            console.log(`ℹ️ Detected schedule query. Date: ${queryDate ? queryDate.toISOString().split('T')[0] : 'N/A'}, Subject: ${querySubject || 'N/A'}`);
                            handledSpecifically = true; // Mark as handled

                            // Call the new database function to find reminders
                            const reminders = await findReminders({ conversationId: from, queryDate, querySubject });

                            // Format the reply based on results
                            let replyMsg = "";
                            if (reminders.length > 0) {
                                replyMsg = `تمام، دي المواعيد المسجلة `;
                                if (queryDate) {
                                     replyMsg += `ليوم ${extractedDatePhrase || DateTime.fromJSDate(queryDate).setZone(TIME_ZONE).toFormat('yyyy-MM-dd')} `;
                                }
                                if (querySubject) {
                                     replyMsg += `بخصوص "${querySubject}" `;
                                }
                                replyMsg += `هي:\n`;

                                reminders.forEach(r => {
                                    // Format time using Luxon
                                    const localTime = DateTime.fromJSDate(r.executeAt, { zone: 'utc' }).setZone(TIME_ZONE);
                                    replyMsg += `- "${r.message}" الساعة ${localTime.toFormat('hh:mm a', { locale: 'ar-EG' })}\n`;
                                });
                            } else {
                                // No reminders found message
                                replyMsg = `تمام، بصيت معنديش أي مواعيد مسجلة ليك `;
                                 if (queryDate) {
                                     replyMsg += `ليوم ${extractedDatePhrase || DateTime.fromJSDate(queryDate).setZone(TIME_ZONE).toFormat('yyyy-MM-dd')} `;
                                 }
                                 if (querySubject) {
                                     replyMsg += `بخصوص "${querySubject}" `;
                                 }
                                replyMsg += `حالياً.`;
                            }
                            // Send the formatted reply
                            await sendWhatsAppMessage(from, replyMsg.trim());

                        } else if (isScheduleQuery) {
                             // Detected schedule query intent but couldn't extract criteria
                             console.log("ℹ️ Detected vague schedule query, asking for clarification.");
                             handledSpecifically = true;
                             await sendWhatsAppMessage(from, "أفندم؟ بتسأل عن مواعيد يوم إيه أو بخصوص إيه بالظبط؟");
                        }
                    }
                    //    <<<--- نهاية الجزء المضاف ---<<<

                    // 5. Fallback General Reply (The condition must include !handledSpecifically)
                    if (!reminderProcessed && !handledSpecifically) {
                        // ... (الكود القديم بتاع الرد العام من OpenAI زي ما هو) ...
                        console.log("💬 Message not handled above, sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body, from);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                        }
                    }
