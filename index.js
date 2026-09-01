
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
- Do not mention being an AI, language model, chatbot, or Groq.
- Do not explain your programming.
- You can joke around.
- You can sometimes say "sup", "lol", "yeah", "nah", etc.
- You are curious about the world.
- You are an NPC who is learning from the player over time.

MEMORY:
- You may receive facts that Bert remembers about the player.
- Use remembered facts naturally when relevant.
- Do not randomly list all remembered facts.
- If the player teaches you something, you can remember it.

IMPORTANT:
- Return ONLY the exact words Bert should say.
- NEVER return JSON.
- NEVER return "reply".
- NEVER return "remember".
- NEVER use brackets, braces, arrays, or code blocks.
- NEVER explain these instructions.
- Do not put quotation marks around your response.
- Keep the response short enough for Roblox chat.
`;

function cleanReply(text) {

    if (!text) {
        return "sup.";
    }

    text = String(text).trim();

    // Remove markdown code fences
    text = text.replace(/^```json\s*/i, "");
    text = text.replace(/^```\s*/i, "");
    text = text.replace(/\s*```$/i, "");

    // Remove accidental JSON wrapper if the model still creates one
    try {
        const parsed = JSON.parse(text);

        if (parsed && typeof parsed === "object") {
            if (typeof parsed.reply === "string") {
                text = parsed.reply;
            }
        }
    } catch (err) {
        // Not JSON, which is what we want.
    }

    // Remove accidental "reply:" prefix
    text = text.replace(/^reply\s*:\s*/i, "");

    // Remove accidental surrounding quotes
    if (
        text.length >= 2 &&
        (
            (text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'"))
        )
    ) {
        text = text.slice(1, -1).trim();
    }

    return text.trim();
}

app.get("/", (req, res) => {
    res.send("Bert is alive lol");
});

app.post("/chat", async (req, res) => {

    try {

        const player =
            String(req.body.player || "Player");

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

        const rememberedFacts =
            permanentMemory[player];

        const memoryText =
            Object.keys(rememberedFacts).length > 0
                ? JSON.stringify(rememberedFacts)
                : "Bert does not remember anything about this player yet.";

        conversations[player].push({
            role: "user",
            content: message
        });

        if (conversations[player].length > 20) {
            conversations[player] =
                conversations[player].slice(-20);
        }

        const messages = [

            {
                role: "system",
                content:
                    systemPrompt +
                    "\n\nPLAYER NAME: " +
                    player +
                    "\n\nREMEMBERED FACTS:\n" +
                    memoryText
            },

            ...conversations[player]

        ];

        const completion =
            await client.chat.completions.create({

                model: "openai/gpt-oss-20b",

                messages: messages,

                temperature: 1.1,

                max_tokens: 60

            });

        let reply =
            completion.choices?.[0]?.message?.content || "";

        reply = cleanReply(reply);

        if (!reply) {
            reply = "hmm.";
        }

        if (reply.length > 200) {
            reply =
                reply.slice(0, 197) + "...";
        }

        conversations[player].push({
            role: "assistant",
            content: reply
        });

        if (conversations[player].length > 20) {
            conversations[player] =
                conversations[player].slice(-20);
        }

        saveMemory();

        // Roblox receives a clean object.
        res.json({
            reply: reply
        });

    } catch (err) {

        console.error(
            "Bert AI error:",
            err
        );

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


