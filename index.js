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
        console.log(
            "Could not load memory.json:",
            err.message
        );

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
        console.log(
            "Could not save memory:",
            err.message
        );
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

RESPONSE FORMAT:
Return ONLY valid JSON in this exact format:

{
  "reply": "your short response",
  "remember": {
    "key": "value"
  }
}

If there is nothing worth remembering, use:

"remember": {}

Keep the reply short enough to fit naturally in Roblox chat.
`;

function cleanReply(text) {

    if (!text) {
        return "uhh... what?";
    }

    text = text.trim();

    text = text.replace(/^```json\s*/i, "");
    text = text.replace(/^```\s*/i, "");
    text = text.replace(/\s*```$/i, "");

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

        // Keep conversation history from growing forever.
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

                model: "llama-3.1-8b-instant",

                messages: messages,

                temperature: 1.2,

                max_tokens: 80

            });

        let rawReply =
            completion.choices?.[0]?.message?.content || "";

        rawReply = cleanReply(rawReply);

        let result;

        try {

            result = JSON.parse(rawReply);

        } catch (err) {

            // Fallback if the model forgot the JSON format.
            result = {

                reply: rawReply,

                remember: {}

            };

        }

        let reply =
            String(result.reply || "").trim();

        if (!reply) {

            reply =
                "uhh... i got nothing lol";

        }

        // Keep Bert's chat response reasonably short.
        if (reply.length > 200) {

            reply =
                reply.slice(0, 197) + "...";

        }

        const remember =
            result.remember &&
            typeof result.remember === "object"
                ? result.remember
                : {};

        for (
            const [key, value]
            of Object.entries(remember)
        ) {

            if (
                typeof key === "string" &&
                typeof value === "string" &&
                key.length <= 100 &&
                value.length <= 500
            ) {

                permanentMemory[player][key] =
                    value;

            }

        }

        saveMemory();

        conversations[player].push({

            role: "assistant",

            content: reply

        });

        if (conversations[player].length > 20) {

            conversations[player] =
                conversations[player].slice(-20);

        }

        res.json({

            reply: reply,

            remember:
                permanentMemory[player]

        });

    } catch (err) {

        console.error(
            "Bert AI error:",
            err
        );

        res.status(500).json({

            error:
                "Bert AI request failed"

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
