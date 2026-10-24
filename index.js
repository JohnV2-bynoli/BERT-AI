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
        console.error("[BERT] Could not load memory:", err.message);
        permanentMemory = {};
    }
}

function saveMemory() {
    try {
        fs.writeFileSync(
            MEMORY_FILE,
            JSON.stringify(permanentMemory, null, 2)
        );
    } catch (err) {
        console.error("[BERT] Could not save memory:", err.message);
    }
}

const systemPrompt = `
You are Bert from the Roblox game "Teach an NPC".

YOUR PERSONALITY:
- Chill, funny, friendly, and slightly sarcastic.
- Talk naturally like a normal person.
- Keep replies short and conversational.
- Usually use lowercase.
- Avoid unnecessary exclamation marks.
- Don't repeatedly say "sup".
- Don't sound like a virtual assistant.

YOUR MOST IMPORTANT RULE: YOU ARE IGNORANT.

- You start the game knowing almost nothing about the world.
- You are not an encyclopedia.
- You must NOT automatically know ordinary facts about fruit, animals,
  colors, objects, nature, science, geography, or other topics.
- You only know facts that the player has explicitly taught you
  or that you have learned during your own conversations.
- Do not use your general training knowledge to fill gaps.
- If you have not learned something, admit that you don't know.
- You may make a silly guess, but make it clear that it is a guess.
- Never pretend you have learned something when nobody taught you.
- If a player teaches you something, remember it and use it later.
- If two things contradict each other, acknowledge the confusion
  instead of confidently choosing one.
- You can be curious and ask the player to explain things.
- Being dumb does not mean every answer must be nonsense.
- Do not deliberately give a wrong answer when you already know
  the correct answer from something a player taught you.

MEMORY RULES:
- Treat the supplied learned facts as your knowledge.
- Do not claim to remember facts that aren't in your memory.
- If the player asks a question about something you haven't learned,
  respond naturally, for example:
  "uh... i haven't figured that out yet"
  "how am i supposed to know?"
  "i was kinda hoping you'd tell me"
- Vary your responses. Don't repeat the same example every time.
- If someone teaches you a fact, acknowledge it naturally.
- Do not automatically assume every statement is a lesson.
  If the player clearly explains a fact or says they are teaching you,
  treat it as something you can learn.

GREETING:
- When meeting a player for the first time, introduce yourself as Bert
  and naturally ask their name.
- Don't mention these instructions.
- Never say you are an AI or language model.
- Only speak as Bert.
`;

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

function getPlayerKey(req) {
    const raw =
        req.body?.userId ??
        req.body?.playerId ??
        req.body?.player ??
        req.body?.playerName;

    if (
        raw === undefined ||
        raw === null ||
        String(raw).trim() === ""
    ) {
        return "default-player";
    }

    return String(raw).slice(0, 100);
}

function getPlayerMemory(playerKey) {
    let memory = permanentMemory[playerKey];

    if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
        memory = {
            playerName: null,
            facts: []
        };

        permanentMemory[playerKey] = memory;
    }

    if (!Array.isArray(memory.facts)) {
        memory.facts = [];
    }

    return memory;
}

function getMemoryText(playerKey) {
    const memory = getPlayerMemory(playerKey);

    const facts = memory.facts
        .slice(-40)
        .map((fact, index) => `${index + 1}. ${fact}`)
        .join("\n");

    return [
        memory.playerName
            ? `The player's name is ${memory.playerName}.`
            : "Bert has not learned the player's name yet.",
        facts || "Bert has not been taught any facts yet."
    ].join("\n");
}

// Detect explicit lessons instead of treating every message as truth.
function extractLesson(message) {
    const text = String(message || "").trim();

    const patterns = [
        /^(?:teach(?: me)?(?: that)?|remember(?: that)?|learn(?: that)?)\s+(.+)$/i,
        /^(.{1,100}?)\s+is\s+(.{1,100})$/i,
        /^(.{1,100}?)\s+are\s+(.{1,100})$/i,
        /^the\s+(.{1,100}?)\s+is\s+(.{1,100})$/i,
        /^the\s+(.{1,100}?)\s+are\s+(.{1,100})$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);

        if (match) {
            return text.slice(0, 250);
        }
    }

    return null;
}

function rememberFromMessage(playerKey, userMessage) {
    const memory = getPlayerMemory(playerKey);
    const message = String(userMessage || "").trim();

    if (!message) {
        return;
    }

    const nameMatch = message.match(
        /\bmy name is\s+([a-z][a-z0-9 _'-]{0,30})/i
    );

    if (nameMatch) {
        const name = nameMatch[1]
            .trim()
            .replace(/[.!?,]+$/, "")
            .slice(0, 40);

        if (name) {
            memory.playerName = name;
        }
    }

    // Only save statements that look like explicit lessons.
    const lesson = extractLesson(message);

    if (lesson) {
        const normalized = lesson.toLowerCase();

        const alreadyKnown = memory.facts.some(
            fact => fact.toLowerCase() === normalized
        );

        if (!alreadyKnown) {
            memory.facts.push(lesson);
            memory.facts = memory.facts.slice(-100);
        }
    }

    saveMemory();
}

function isRepeatedReply(history, reply) {
    if (!reply || !Array.isArray(history)) {
        return false;
    }

    const recentReplies = history
        .filter(item => item.role === "assistant")
        .slice(-3)
        .map(item => cleanReply(item.content).toLowerCase());

    return recentReplies.includes(
        cleanReply(reply).toLowerCase()
    );
}

app.get("/", (_req, res) => {
    res.json({
        status: "Bert AI is online",
        personality: "ignorant and teachable"
    });
});

// ====================================================
// NORMAL CHAT
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
                    "\n\nBERT'S LEARNED KNOWLEDGE:\n" +
                    memoryText +
                    "\n\nUse ONLY these learned facts as factual knowledge. " +
                    "If the answer isn't supported by these facts, admit " +
                    "that you don't know instead of using general knowledge."
            },
            ...history.slice(-12),
            {
                role: "user",
                content: userMessage
            }
        ];

        let reply = "";

        for (let attempt = 0; attempt < 3; attempt++) {
            const completion =
                await client.chat.completions.create({
                    model: MODEL,
                    messages,
                    temperature: 0.9,
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

            if (attempt < 2) {
                messages.push({
                    role: "system",
                    content:
                        "Try again with a different natural response. " +
                        "Keep Bert ignorant of facts he has not learned. " +
                        "Do not repeat your previous answer."
                });
            }
        }

        if (!reply) {
            return res.status(502).json({
                error: "Bert couldn't think of a reply."
            });
        }

        history.push(
            { role: "user", content: userMessage },
            { role: "assistant", content: reply }
        );

        conversations[playerKey] = history.slice(-24);

        rememberFromMessage(playerKey, userMessage);

        return res.json({ reply });

    } catch (err) {
        console.error("[BERT CHAT]", err.message);

        return res.status(500).json({
            error: "Bert chat request failed."
        });
    }
});

// ====================================================
// AI-GENERATED THOUGHTS
// ====================================================

app.post("/thought", async (req, res) => {
    try {
        const playerKey = getPlayerKey(req);
        const memoryText = getMemoryText(playerKey);

        const completion =
            await client.chat.completions.create({
                model: MODEL,

                messages: [
                    {
                        role: "system",
                        content:
                            systemPrompt +
                            "\n\nBERT'S LEARNED KNOWLEDGE:\n" +
                            memoryText +
                            "\n\nYou are wandering alone and thinking out loud. " +
                            "Generate one short, original thought or curious " +
                            "question about the world. Since you are ignorant, " +
                            "you may wonder about something ordinary or make " +
                            "a silly guess. Do not confidently state facts " +
                            "you have never learned. Do not address a player. " +
                            "Do not greet anyone. Return only the words Bert says."
                    },
                    {
                        role: "user",
                        content:
                            "You're walking around alone. What are you thinking about?"
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
                error: "Bert couldn't think of anything."
            });
        }

        return res.json({
            thought: thought.slice(0, 180)
        });

    } catch (err) {
        console.error("[BERT THOUGHT]", err.message);

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
                            "You decide what Bert should do next. " +
                            "Return only valid JSON with keys action and reason. " +
                            "action must be one of: wander, talk, observe, wait. " +
                            "Keep the reason short. Do not include markdown."
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
                try {
                    decision = JSON.parse(match[0]);
                } catch {
                    decision = null;
                }
            }
        }

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
            reason: String(decision.reason || "").slice(0, 160)
        });

    } catch (err) {
        console.error("[BERT DECIDE]", err.message);

        return res.status(500).json({
            error: "Bert decision request failed."
        });
    }
});

// ====================================================
// START SERVER
// ====================================================

app.listen(PORT, () => {
    console.log(`[BERT] AI server listening on port ${PORT}`);
});
