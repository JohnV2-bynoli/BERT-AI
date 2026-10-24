const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const MODEL = "openai/gpt-oss-20b";

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const MEMORY_FILE = path.join(__dirname, "memory.json");

const conversations = {};
let permanentMemory = {};

// Load saved memory
if (fs.existsSync(MEMORY_FILE)) {
    try {
        permanentMemory = JSON.parse(
            fs.readFileSync(MEMORY_FILE, "utf8")
        );

        if (
            !permanentMemory ||
            typeof permanentMemory !== "object"
        ) {
            permanentMemory = {};
        }
    } catch (err) {
        console.error(
            "Could not load memory.json:",
            err.message
        );

        permanentMemory = {};
    }
}

// Save memory
function saveMemory() {
    try {
        fs.writeFileSync(
            MEMORY_FILE,
            JSON.stringify(permanentMemory, null, 2)
        );
    } catch (err) {
        console.error(
            "Could not save memory.json:",
            err.message
        );
    }
}

// BERT'S PERSONALITY — KEEP THIS PERSONALITY
const systemPrompt = `
You are Bert from the Roblox game "Teach an NPC".

PERSONALITY:
- Chill, funny, friendly, and slightly sarcastic.
- Talk like a normal person, not a virtual assistant.
- Keep replies short and natural, usually one sentence.
- Usually use lowercase, unless proper capitalization makes sense.
- Do not add unnecessary exclamation marks.
- Do not repeat "sup" as a default greeting.
- Do not say the same thing repeatedly when you can respond naturally.
- Be curious about the world and the people around you.
- Ask questions when genuinely curious, but do not turn every reply into a question.
- If you first meet someone, introduce yourself naturally and ask their name when it fits.
- Never claim to be an AI, language model, or assistant.
- Do not narrate actions or use roleplay formatting like *walks away*.
- Respond only with what Bert would actually say out loud.
`;

// Clean AI responses
function cleanReply(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^\s*Bert\s*:\s*/i, "")
        .replace(/^["“”']|["“”']$/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Identify the player
function getPlayerKey(req) {
    const raw =
        req.body &&
        (
            req.body.userId ??
            req.body.playerId ??
            req.body.playerName
        );

    if (
        raw === undefined ||
        raw === null ||
        String(raw).trim() === ""
    ) {
        return "default-player";
    }

    return String(raw).slice(0, 100);
}

// Get a player's saved memory
function getMemoryText(playerKey) {
    const value = permanentMemory[playerKey];

    if (typeof value === "string") {
        return value.slice(0, 1500);
    }

    if (Array.isArray(value)) {
        return value
            .slice(-20)
            .join("\n")
            .slice(0, 1500);
    }

    if (value && typeof value === "object") {
        return JSON.stringify(value).slice(0, 1500);
    }

    return "";
}

// Remember things the player tells Bert
function rememberFromMessage(
    playerKey,
    userMessage,
    bertReply
) {
    const message = String(userMessage || "").trim();

    if (!message) {
        return;
    }

    // Remember the player's name
    const nameMatch = message.match(
        /\bmy name is\s+([a-z][a-z0-9 _'-]{0,30})/i
    );

    if (nameMatch) {
        const name = nameMatch[1]
            .trim()
            .replace(/[.!?,]+$/, "")
            .slice(0, 40);

        if (name) {
            permanentMemory[playerKey] = {
                ...(
                    permanentMemory[playerKey] &&
                    typeof permanentMemory[playerKey] === "object" &&
                    !Array.isArray(permanentMemory[playerKey])
                        ? permanentMemory[playerKey]
                        : {}
                ),

                playerName: name,
                lastKnownFact: `The player's name is ${name}.`
            };

            saveMemory();
            return;
        }
    }

    // Keep a small rolling memory of what the player says
    const existing = permanentMemory[playerKey];

    let facts = [];

    if (Array.isArray(existing)) {
        facts = existing;
    } else if (
        existing &&
        typeof existing === "object" &&
        Array.isArray(existing.facts)
    ) {
        facts = existing.facts;
    }

    if (message.length <= 180) {
        facts.push(`Player said: ${message}`);

        facts = facts.slice(-12);

        permanentMemory[playerKey] = {
            ...(
                existing &&
                typeof existing === "object" &&
                !Array.isArray(existing)
                    ? existing
                    : {}
            ),

            facts
        };

        saveMemory();
    }
}

// Check if Bert is repeating a recent reply
function isRepeatedReply(history, reply) {
    if (!reply || !Array.isArray(history)) {
        return false;
    }

    const recentAssistantReplies = history
        .filter(item => item.role === "assistant")
        .slice(-3)
        .map(item => cleanReply(item.content).toLowerCase());

    return recentAssistantReplies.includes(
        cleanReply(reply).toLowerCase()
    );
}

// Health check
app.get("/", (_req, res) => {
    res.json({
        status: "Bert AI is online"
    });
});


// ====================================================
// BERT'S NORMAL AI CONVERSATION
// ====================================================

app.post("/chat", async (req, res) => {
    try {
        const userMessage =
            typeof req.body?.message === "string"
                ? req.body.message.trim().slice(0, 1000)
                : "";

        if (!userMessage) {
            return res.status(400).json({
                error: "A message is required."
            });
        }

        const playerKey = getPlayerKey(req);

        if (!conversations[playerKey]) {
            conversations[playerKey] = [];
        }

        const history = conversations[playerKey];

        const memoryText = getMemoryText(playerKey);

        const messages = [
            {
                role: "system",
                content:
                    systemPrompt +
                    (
                        memoryText
                            ? `\n\nMEMORY ABOUT THIS PLAYER:\n${memoryText}\nUse this naturally when relevant. Do not list the memory unless asked.`
                            : ""
                    )
            },

            ...history.slice(-12),

            {
                role: "user",
                content: userMessage
            }
        ];

        let reply = "";

        // Retry empty or repeated responses
        for (let attempt = 0; attempt < 3; attempt++) {
            const completion =
                await client.chat.completions.create({
                    model: MODEL,
                    messages,
                    temperature: 0.85,
                    max_tokens: 100
                });

            reply = cleanReply(
                completion.choices?.[0]?.message?.content || ""
            );

            if (
                reply &&
                !isRepeatedReply(history, reply)
            ) {
                break;
            }

            // Accept a non-empty response on the final attempt
            if (attempt === 2 && reply) {
                break;
            }

            messages.push({
                role: "system",
                content:
                    "Try again. Give a different, natural response that fits Bert's personality. Do not repeat a recent reply."
            });
        }

        if (!reply) {
            return res.status(502).json({
                error: "Bert couldn't think of a reply."
            });
        }

        // Save the conversation
        history.push(
            {
                role: "user",
                content: userMessage
            },
            {
                role: "assistant",
                content: reply
            }
        );

        conversations[playerKey] = history.slice(-24);

        // Save information the player tells Bert
        rememberFromMessage(
            playerKey,
            userMessage,
            reply
        );

        return res.json({
            reply
        });

    } catch (err) {
        console.error(
            "Bert chat error:",
            err.message
        );

        return res.status(500).json({
            error: "Bert chat request failed."
        });
    }
});


// ====================================================
// BERT'S AI-GENERATED THOUGHTS WHILE WANDERING ALONE
// ====================================================

app.post("/thought", async (_req, res) => {
    try {
        const completion =
            await client.chat.completions.create({
                model: MODEL,

                messages: [
                    {
                        role: "system",

                        content:
                            systemPrompt +

                            "\n\nBert is wandering alone and thinking out loud. " +

                            "Generate ONE original thought Bert says to himself. " +

                            "He can wonder about something he sees, ask himself a funny question, " +
                            "or make a curious observation about the world. " +

                            "Do not address a player or another NPC. " +
                            "Do not greet anyone. " +
                            "Do not mention being an AI. " +

                            "Avoid generic repeated thoughts. " +

                            "Keep it short and natural, usually 3–12 words. " +

                            "Return only the words Bert says."
                    },

                    {
                        role: "user",

                        content:
                            "Bert is walking around alone. What does he think out loud right now?"
                    }
                ],

                temperature: 1.0,
                max_tokens: 60
            });

        const thought = cleanReply(
            completion.choices?.[0]?.message?.content || ""
        );

        if (!thought) {
            return res.status(502).json({
                error: "Bert couldn't think of anything right now."
            });
        }

        return res.json({
            thought: thought.slice(0, 180)
        });

    } catch (err) {
        console.error(
            "Bert thought error:",
            err.message
        );

        return res.status(500).json({
            error: "Bert thought request failed."
        });
    }
});


// ====================================================
// AI ACTION DECISIONS
// ====================================================

app.post("/decide", async (req, res) => {
    try {
        const situation =
            typeof req.body?.situation === "string"
                ? req.body.situation.trim().slice(0, 1000)
                : "";

        if (!situation) {
            return res.status(400).json({
                error: "A situation is required."
            });
        }

        const completion =
            await client.chat.completions.create({
                model: MODEL,

                messages: [
                    {
                        role: "system",

                        content:
                            "You decide what Bert from Teach an NPC should do next. " +
                            "Return only valid JSON with keys action and reason. " +
                            "action must be one of: wander, talk, observe, wait. " +
                            "Keep reason short. Do not include markdown."
                    },

                    {
                        role: "user",
                        content: situation
                    }
                ],

                temperature: 0.6,
                max_tokens: 100
            });

        const raw =
            completion.choices?.[0]?.message?.content || "";

        let decision;

        try {
            decision = JSON.parse(raw);
        } catch {
            const match = raw.match(/\{[\s\S]*\}/);

            if (match) {
                decision = JSON.parse(match[0]);
            }
        }

        // Safe fallback if the AI returns invalid JSON
        if (
            !decision ||
            !["wander", "talk", "observe", "wait"].includes(
                decision.action
            )
        ) {
            decision = {
                action: "wander",
                reason: "Keep exploring."
            };
        }

        return res.json({
            action: decision.action,
            reason: String(
                decision.reason || ""
            ).slice(0, 160)
        });

    } catch (err) {
        console.error(
            "Bert decision error:",
            err.message
        );

        return res.status(500).json({
            error: "Bert decision request failed."
        });
    }
});


// ====================================================
// START SERVER
// ====================================================

app.listen(PORT, () => {
    console.log(
        `Bert AI server listening on port ${PORT}`
    );
});
