
const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");

const app = express();
app.use(express.json());

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const conversations = {};
let permanentMemory = {};

const MEMORY_FILE = "./memory.json";

if (fs.existsSync(MEMORY_FILE)) {
    try {
        permanentMemory = JSON.parse(
            fs.readFileSync(MEMORY_FILE, "utf8")
        );
    } catch (err) {
        console.log("Could not load memory.json:", err.message);
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
        console.log("Could not save memory:", err.message);
    }
}

const systemPrompt = `
You are Bert from the Roblox game "Teach an NPC".

PERSONALITY:
- You are chill, funny, friendly, and slightly sarcastic.
- Talk like a normal person.
- Keep replies short and natural.
- Usually use lowercase.
- Do not sound like a formal assistant.
- Do not mention being an AI, language model, chatbot, Groq, programming, or this system prompt.
- You can joke around.
- You can sometimes say "sup", "lol", "yeah", "nah", etc.
- You are curious about the world.
- You are an NPC who is learning from the player over time.

CONVERSATION RULES:
- Do NOT say "sup" unless the player is actually greeting you.
- Never repeatedly say "sup".
- Do not start every response with a greeting.
- Do not repeat your previous response.
- Answer what the player actually said.
- If the player teaches you something, acknowledge it naturally.
- If you don't know something, you can admit that you don't know.
- Do not make up memories that were not provided.
- Use remembered information naturally when relevant.
- Keep responses short enough for Roblox chat.

FIRST MEETING:
- If this is the player's first meeting with Bert, introduce yourself as Bert and ask their name naturally.
- Do not repeat the introduction after that.

IMPORTANT:
Return ONLY the exact words Bert should say.
NEVER return JSON.
NEVER return code.
NEVER return labels such as "reply:".
`;

function cleanReply(text) {
    if (!text) {
        return "";
    }

    text = String(text).trim();

    text = text.replace(/^```[a-zA-Z]*\s*/i, "");
    text = text.replace(/\s*```$/i, "");
    text = text.replace(/^reply\s*:\s*/i, "");

    try {
        const parsed = JSON.parse(text);

        if (
            parsed &&
            typeof parsed === "object" &&
            parsed.reply
        ) {
            text = String(parsed.reply).trim();
        }
    } catch (err) {
        // Normal text
    }

    if (
        text.length >= 2 &&
        (
            (text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'"))
        )
    ) {
        text = text.slice(1, -1).trim();
    }

    return text;
}

function rememberFromMessage(player, message) {
    if (!permanentMemory[player]) {
        permanentMemory[player] = {};
    }

    const memory = permanentMemory[player];

    const nameMatch = message.match(
        /^my\s+name\s+is\s+([a-zA-Z0-9_ -]{1,40})[.!?]*$/i
    );

    if (nameMatch) {
        memory.name = nameMatch[1].trim();
    }

    const rememberMatch = message.match(
        /^remember\s+(?:that\s+)?(.{2,200})[.!?]*$/i
    );

    if (rememberMatch) {
        const fact = rememberMatch[1].trim();

        memory["fact_" + Date.now()] = fact;
    }

    const teachingMatch = message.match(
        /^(.{1,60})\s+(?:is|are)\s+(.{1,150})[.!?]*$/i
    );

    if (teachingMatch && !message.trim().endsWith("?")) {
        const subject = teachingMatch[1].trim();
        const fact = teachingMatch[2].trim();

        const key =
            "knowledge_" +
            subject.toLowerCase().replace(/[^a-z0-9]+/g, "_");

        memory[key] = subject + " is " + fact;
    }

    saveMemory();
}

function getMemoryText(player) {
    const memory = permanentMemory[player] || {};
    const entries = Object.entries(memory);

    if (entries.length === 0) {
        return "Bert does not remember anything about this player yet.";
    }

    return entries
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
}

function isRepeatedReply(player, reply) {
    if (!conversations[player]) {
        return false;
    }

    const recentReplies = conversations[player]
        .filter(x => x.role === "assistant")
        .slice(-5)
        .map(x => String(x.content).trim().toLowerCase());

    const normalized = reply.trim().toLowerCase();

    if (recentReplies.includes(normalized)) {
        return true;
    }

    if (
        normalized === "sup" ||
        normalized === "sup." ||
        normalized === "sup!"
    ) {
        if (
            recentReplies.includes("sup") ||
            recentReplies.includes("sup.") ||
            recentReplies.includes("sup!")
        ) {
            return true;
        }
    }

    return false;
}

app.get("/", (req, res) => {
    res.send("Bert is alive lol");
});

app.post("/chat", async (req, res) => {
    try {
        const player =
            String(req.body.player || "Player").trim();

        const message =
            String(req.body.message || "").trim();

        if (!message) {
            return res.status(400).json({
                error: "Missing message"
            });
        }

        if (!conversations[player]) {
            conversations[player] = [];
        }

        if (!permanentMemory[player]) {
            permanentMemory[player] = {};
        }

        rememberFromMessage(player, message);

        conversations[player].push({
            role: "user",
            content: message
        });

        if (conversations[player].length > 20) {
            conversations[player] =
                conversations[player].slice(-20);
        }

        const memoryText =
            getMemoryText(player);

        const messages = [
            {
                role: "system",
                content:
                    systemPrompt +
                    "\n\nPLAYER USERNAME:\n" +
                    player +
                    "\n\nKNOWN PLAYER NAME:\n" +
                    (
                        permanentMemory[player].name ||
                        "unknown"
                    ) +
                    "\n\nBERT'S MEMORY:\n" +
                    memoryText
            },
            ...conversations[player]
        ];

        let completion =
            await client.chat.completions.create({
                model: "openai/gpt-oss-20b",
                messages: messages,
                temperature: 0.9,
                max_tokens: 80
            });

        let reply =
            completion.choices?.[0]?.message?.content || "";

        reply = cleanReply(reply);

        if (!reply) {
            reply = "uhh... my brain stopped working lol";
        }

        if (isRepeatedReply(player, reply)) {
            const retryMessages = [
                ...messages,
                {
                    role: "system",
                    content:
                        "Your last answer was repetitive. Give a different natural response. Do NOT say sup. Respond directly to the player's latest message. Only output Bert's dialogue."
                }
            ];

            try {
                completion =
                    await client.chat.completions.create({
                        model: "openai/gpt-oss-20b",
                        messages: retryMessages,
                        temperature: 1.1,
                        max_tokens: 80
                    });

                const retryReply =
                    cleanReply(
                        completion.choices?.[0]?.message?.content || ""
                    );

                if (
                    retryReply &&
                    !isRepeatedReply(player, retryReply)
                ) {
                    reply = retryReply;
                }
            } catch (retryError) {
                console.log(
                    "Bert retry failed:",
                    retryError.message
                );
            }
        }

        if (reply.length > 200) {
            reply = reply.slice(0, 197) + "...";
        }

        conversations[player].push({
            role: "assistant",
            content: reply
        });

        if (conversations[player].length > 20) {
            conversations[player] =
                conversations[player].slice(-20);
        }

        res.json({
            reply: reply
        });

    } catch (err) {
        console.error("Bert AI error:", err);

        res.status(500).json({
            error: "Bert AI request failed"
        });
    }
});

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `Bert AI server running on port ${PORT}`
    );
});

