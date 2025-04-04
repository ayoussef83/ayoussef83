// ... (الكود اللي قبله زي ما هو جوه الـ POST handler) ...

                if (msg_body && from) {
                    console.log(`📩 Received text message from ${from}: "${msg_body}"`);

                    // --- MODIFIED LOGIC STARTS HERE ---
                    // Define multiple keywords for triggering reminder parsing
                    // ممكن تزود أو تغير في الليستة دي زي ما تحب
                    const reminderKeywords = ["ذكرني", "فكرني", "ماتنساش", "خليني افتكر"];
                    let reminderProcessed = false; // Flag to track if we handled it

                    // Check if the message starts with ANY of the keywords (case-insensitive)
                    const startsWithReminderKeyword = reminderKeywords.some(keyword =>
                        // بنحول الكلمة المفتاحية والرسالة لـ lowercase عشان نتجاهل فرق الحروف الكبيرة والصغيرة
                        msg_body.toLowerCase().startsWith(keyword.toLowerCase())
                    );

                    // لو الرسالة بتبدأ بأي كلمة من الليستة
                    if (startsWithReminderKeyword) {
                        console.log(`ℹ️ Detected potential reminder command (using '${msg_body.split(' ')[0]}'). Attempting parsing with OpenAI...`); // Log which keyword was detected
                        reminderProcessed = true; // بنعتبر إننا حاولنا نعالجها كتذكير

                        // Call the OpenAI parsing function (زي ما هي من المرة اللي فاتت)
                        const parsedReminder = await parseReminderWithOpenAI(msg_body);

                        // Check if parsing was successful and returned valid data
                        if (parsedReminder && parsedReminder.reminder_text && parsedReminder.local_datetime_iso) {
                            const { reminder_text, local_datetime_iso } = parsedReminder;
                            console.log(`✅ OpenAI parsed: Text='${reminder_text}', Time='${local_datetime_iso}'`);

                            // Validate and process the parsed time string using Luxon
                            try {
                                const formatString = 'yyyy-MM-dd HH:mm'; // The format OpenAI should return
                                const localDateTime = DateTime.fromFormat(local_datetime_iso, formatString, { zone: TIME_ZONE });

                                if (!localDateTime.isValid) {
                                    // Handle cases where OpenAI returns a badly formatted string despite instructions
                                    console.warn(`⚠️ Failed to validate date string from OpenAI "${local_datetime_iso}". Reason: ${localDateTime.invalidReason || 'Unknown'}`);
                                    await sendWhatsAppMessage(from, `معلش، فهمت التذكير لكن معرفتش أظبط الوقت اللي رجع من التحليل: "${local_datetime_iso}".\nالسبب: ${localDateTime.invalidReason}.\nجرب صيغة تانية أو الصيغة الدقيقة: YYYY-MM-DD HH:MM`);
                                } else {
                                    // Convert to UTC for storage and comparison
                                    const executeAtUtc = localDateTime.toUTC();
                                    const nowUtc = DateTime.utc();

                                    // Check if the time is in the past (allow a small buffer like 1 minute)
                                    if (executeAtUtc <= nowUtc.plus({ minutes: 1 })) {
                                        console.warn("⚠️ Parsed reminder time is in the past or too soon.");
                                        await sendWhatsAppMessage(from, `الوقت اللي فهمته من كلامك (${local_datetime_iso} بتوقيت القاهرة) للأسف عدى أو قرب أوي. لازم تحدد وقت في المستقبل بدقيقة على الأقل.`);
                                    } else {
                                        // Convert valid future time to JS Date for MongoDB
                                        const executeAtUtcDate = executeAtUtc.toJSDate();
                                        // Call addReminder to save to DB
                                        await addReminder(from, reminder_text, executeAtUtcDate);

                                        // Send confirmation back to user
                                        const formattedLocalTime = localDateTime.toFormat('yyyy-MM-dd hh:mm a'); // e.g., 2025-04-05 05:00 PM
                                        await sendWhatsAppMessage(from, `تمام 👍، هفكرك بـ "${reminder_text}" في الميعاد ده: ${formattedLocalTime} بتوقيت القاهرة`);
                                        console.log(`✅ Reminder successfully parsed by AI and scheduled for ${from}.`);
                                    }
                                }
                            } catch (validationError) {
                                // Catch errors during Luxon parsing/validation
                                console.error("❌ Error validating/processing date returned by OpenAI:", validationError);
                                await sendWhatsAppMessage(from, "حصلت مشكلة تقنية وأنا بحاول أتأكد من الوقت اللي فهمته. حاول تاني لو سمحت.");
                            }

                        } else {
                            // OpenAI parsing failed (returned null)
                            console.warn("⚠️ OpenAI could not parse the reminder details confidently.");
                            await sendWhatsAppMessage(from, "معلش، حاولت أفهم الوقت والتاريخ من كلامك بس متلخبط شوية. 🤔 ممكن تكتبهولي بصيغة أوضح أو تستخدم الصيغة دي: YYYY-MM-DD HH:MM ؟");
                        }
                    } // End if (startsWithReminderKeyword)

                    // If the message wasn't identified and processed as a reminder, treat it as a general query
                    if (!reminderProcessed) {
                        console.log("💬 Message not a reminder command, sending to OpenAI for general reply...");
                        const aiReply = await getReplyFromOpenAI(msg_body);
                        if (aiReply) {
                            await sendWhatsAppMessage(from, aiReply);
                        } else {
                            console.warn("⚠️ No reply generated by OpenAI for general query.");
                            // Optionally send a fallback message
                            // await sendWhatsAppMessage(from, "معلش، مش قادر أرد دلوقتي.");
                        }
                    }
                    // --- MODIFIED LOGIC ENDS HERE ---

                } else { // else for if(msg_body && from)
                  // ... (باقي الكود زي ما هو) ...
