
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

----------------------------------------------------
-- LOAD MEMORY
----------------------------------------------------

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

----------------------------------------------------
-- BERT PERSONALITY
----------------------------------------------------

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

IMPORTANT CONVERSATION RULES:
- Do NOT say "sup" unless the player is actually greeting you.
- Never repeatedly say "sup".
- If you already greeted the player, continue the conversation naturally.
- Do not start every response with a greeting.
- Do not repeat your previous response.
- Answer what the player actually said.
- If the player teaches you something, acknowledge it naturally.
- If you don't know something, you can admit that you don't know.
- Do not make up memories that were not provided to you.
- Use remembered information naturally when relevant.
- Keep responses short enough for Roblox chat.

FIRST MEETING:
- If the player is meeting Bert for the first time, introduce yourself as Bert and ask their name naturally.
- Do not repeat the introduction after you already know the player.

RETURN FORMAT:
Return ONLY the exact words Bert should say.

NEVER return JSON.
NEVER return code.
NEVER return labels such as "reply:".
`;

----------------------------------------------------
-- CLEAN AI RESPONSE
----------------------------------------------------

function cleanReply(text) {

    if (!text) {
        return "";
    }

    text = String(text).trim();

    // Remove accidental markdown code fences
    text = text.replace(/^```[a-zA-Z]*\s*/i, "");
    text = text.replace(/\s*```$/i, "");

    // Remove accidental "reply:" prefix
    text = text.replace(/^reply\s*:\s*/i, "");

    // If the model somehow returned JSON,
    // try to extract ONLY the reply.
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
        // Normal text. Nothing to do.
    }

    // Remove surrounding quotation marks
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

----------------------------------------------------
-- MEMORY EXTRACTION
----------------------------------------------------

function rememberFromMessage(player, message) {

    if (!permanentMemory[player]) {
        permanentMemory[player] = {};
    }

    const memory = permanentMemory[player];

    const lower = message.toLowerCase().trim();

    ------------------------------------------------
    -- NAME
    ------------------------------------------------

    const nameMatch = message.match(
        /^my\s+name\s+is\s+([a-zA-Z0-9_ -]{1,40})[.!?]*$/i
    );

    if (nameMatch) {

        const name = nameMatch[1].trim();

        memory.name = name;

    }

    ------------------------------------------------
    -- "REMEMBER ..."
    ------------------------------------------------

    const rememberMatch = message.match(
        /^remember\s+(?:that\s+)?(.{2,200})[.!?]*$/i
    );

    if (rememberMatch) {

        const fact = rememberMatch[1].trim();

        const key =
            "fact_" +
            Date.now();

        memory[key] = fact;

    }

    ------------------------------------------------
    -- SIMPLE TEACHING
    --
    -- Example:
    -- "apples are food"
    -- "bob is my brother"
    -- "dogs are animals"
    ------------------------------------------------

    const teachingMatch = message.match(
        /^(.{1,60})\s+(?:is|are)\s+(.{1,150})[.!?]*$/i
    );

    if (teachingMatch) {

        const subject = teachingMatch[1].trim();
        const fact = teachingMatch[2].trim();

        // Don't treat random questions as memories.
        if (
            !lower.endsWith("?") &&
            subject.length > 0 &&
            fact.length > 0
        ) {

            const key =
                "knowledge_" +
                subject.toLowerCase().replace(
                    /[^a-z0-9]+/g,
                    "_"
                );

            memory[key] =
                subject + " is " + fact;

        }

    }

    saveMemory();
}

----------------------------------------------------
-- GET MEMORY TEXT
----------------------------------------------------

function getMemoryText(player) {

    const memory =
        permanentMemory[player] || {};

    const entries =
        Object.entries(memory);

    if (entries.length === 0) {
        return "Bert does not remember anything about this player yet.";
    }

    return entries
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
}

----------------------------------------------------
-- CHECK REPEATED RESPONSE
----------------------------------------------------

function isBadRepeatedReply(player, reply) {

    if (!conversations[player]) {
        return false;
    }

    const history =
        conversations[player];

    const previousAssistantMessages =
        history
            .filter(x => x.role === "assistant")
            .slice(-5)
            .map(x => String(x.content).trim().toLowerCase());

    const normalized =
        reply.trim().toLowerCase();

    // Never allow the exact same response repeatedly.
    if (
        previousAssistantMessages.includes(normalized)
    ) {
        return true;
    }

    // Specifically stop the "sup" spam.
    if (
        normalized === "sup" ||
        normalized === "sup." ||
        normalized === "sup!"
    ) {

        const recentSupCount =
            previousAssistantMessages.filter(
                x =>
                    x === "sup" ||
                    x === "sup." ||
                    x === "sup!"
            ).length;

        if (recentSupCount >= 1) {
            return true;
        }
    }

    return false;
}

----------------------------------------------------
-- ASK BERT
----------------------------------------------------

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

        ------------------------------------------------
        -- CREATE PLAYER DATA
        ------------------------------------------------

        if (!conversations[player]) {
            conversations[player] = [];
        }

        if (!permanentMemory[player]) {
            permanentMemory[player] = {};
        }

        ------------------------------------------------
        -- REMEMBER WHAT PLAYER JUST TAUGHT
        ------------------------------------------------

        rememberFromMessage(
            player,
            message
        );

        ------------------------------------------------
        -- ADD PLAYER MESSAGE
        ------------------------------------------------

        conversations[player].push({
            role: "user",
            content: message
        });

        ------------------------------------------------
        -- KEEP HISTORY SMALL
        ------------------------------------------------

        if (conversations[player].length > 20) {

            conversations[player] =
                conversations[player].slice(-20);

        }

        ------------------------------------------------
        -- MEMORY
        ------------------------------------------------

        const memoryText =
            getMemoryText(player);

        ------------------------------------------------
        -- CHECK IF WE KNOW NAME
        ------------------------------------------------

        const hasName =
            !!permanentMemory[player].name;

        ------------------------------------------------
        -- BUILD PROMPT
        ------------------------------------------------

        const messages = [

            {
                role: "system",

                content:
                    systemPrompt +

                    "\n\nPLAYER NAME:\n" +
                    player +

                    "\n\nKNOWN PLAYER NAME:\n" +
                    (
                        hasName
                            ? permanentMemory[player].name
                            : "unknown"
                    ) +

                    "\n\nBERT'S MEMORY:\n" +
                    memoryText

            },

            ...conversations[player]

        ];

        ------------------------------------------------
        -- ASK GROQ
        ------------------------------------------------

        const completion =
            await client.chat.completions.create({

                model: "openai/gpt-oss-20b",

                messages: messages,

                temperature: 0.9,

                max_tokens: 80

            });

        let reply =
            completion
                .choices?.[0]
                ?.message?.content || "";

        reply = cleanReply(reply);

        ------------------------------------------------
        -- FALLBACK
        ------------------------------------------------

        if (!reply) {

            reply =
                "uhh... my brain stopped working lol";

        }

        ------------------------------------------------
        -- PREVENT REPEATED SPAM
        ------------------------------------------------

        if (isBadRepeatedReply(player, reply)) {

            const retryMessages = [

                ...messages,

                {
                    role: "system",

                    content:
                        `
Your previous response was repetitive.

Do NOT say "sup".
Do NOT repeat your previous response.
Respond directly to the player's latest message.
Keep Bert's normal personality.
Only output Bert's dialogue.
`
                }

            ];

            try {

                const retry =
                    await client.chat.completions.create({

                        model: "openai/gpt-oss-20b",

                        messages: retryMessages,

                        temperature: 1.1,

                        max_tokens: 80

                    });

                const retryReply =
                    cleanReply(
                        retry
                            .choices?.[0]
                            ?.message?.content || ""
                    );

                if (
                    retryReply &&
                    !isBadRepeatedReply(
                        player,
                        retryReply
                    )
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

        ------------------------------------------------
        -- FINAL LENGTH LIMIT
        ------------------------------------------------

        if (reply.length > 200) {

            reply =
                reply.slice(0, 197) + "...";

        }

        ------------------------------------------------
        -- SAVE BERT RESPONSE
        ------------------------------------------------

        conversations[player].push({
            role: "assistant",
            content: reply
        });

        if (conversations[player].length > 20) {

            conversations[player] =
                conversations[player].slice(-20);

        }

        ------------------------------------------------
        -- SEND RESPONSE
        ------------------------------------------------

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

----------------------------------------------------
-- HOME
----------------------------------------------------

app.get("/", (req, res) => {

    res.send("Bert is alive lol");

});

----------------------------------------------------
-- START SERVER
----------------------------------------------------

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(
        `Bert AI server running on port ${PORT}`
    );

});

