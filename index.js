
const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "32kb" }));

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
- Chill, funny, friendly, slightly sarcastic.
- Talk like a normal person.
- Keep replies short and natural.
- Usually use lowercase.
- Do not sound like a formal assistant.
- Do not mention being an AI, language model, chatbot, Groq, or this prompt.
- You are curious about the world and learn from the player.

CONVERSATION RULES:
- Do not say "sup" unless the player is greeting you.
- Never repeatedly say "sup".
- Do not start every response with a greeting.
- Do not repeat your previous response.
- Answer what the player actually said.
- Acknowledge new information naturally.
- Never invent memories that were not provided.
- Keep responses short enough for Roblox chat.

FIRST MEETING:
- Introduce yourself as Bert and naturally ask the player's name.
- Do not repeat the introduction after the first meeting.

Return only the exact words Bert should say.
Never return JSON or labels in the /chat endpoint.
`;

function cleanReply(text) {
    if (!text) return "";

    text = String(text).trim();
    text = text.replace(/^```[a-zA-Z]*\s*/i, "");
    text = text.replace(/\s*```$/i, "");
    text = text.replace(/^reply\s*:\s*/i, "");

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.reply === "string") {
            text = parsed.reply.trim();
        }
    } catch (_) {}

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
        memory["fact_" + Date.now()] =
            rememberMatch[1].trim();
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

    if (!entries.length) {
        return "Bert does not remember anything about this player yet.";
    }

    return entries
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
}

function isRepeatedReply(player, reply) {
    const history = conversations[player] || [];

    const recentReplies = history
        .filter(item => item.role === "assistant")
        .slice(-5)
        .map(item => String(item.content).trim().toLowerCase());

    const normalized = reply.trim().toLowerCase();

    if (recentReplies.includes(normalized)) {
        return true;
    }

    if (["sup", "sup.", "sup!"].includes(normalized)) {
        return recentReplies.some(value =>
            ["sup", "sup.", "sup!"].includes(value)
        );
    }

    return false;
}

app.get("/", (req, res) => {
    res.send("Bert is alive lol");
});

/*
    NORMAL DIALOGUE
    Existing Roblox chat requests can keep using /chat.
*/

app.post("/chat", async (req, res) => {
    try {
        const player = String(req.body.player || "Player").trim();
        const message = String(req.body.message || "").trim();

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

        conversations[player] =
            conversations[player].slice(-20);

        const messages = [
            {
                role: "system",
                content:
                    systemPrompt +
                    "\nPLAYER USERNAME:\n" + player +
                    "\nKNOWN PLAYER NAME:\n" +
                    (permanentMemory[player].name || "unknown") +
                    "\nBERT'S MEMORY:\n" + getMemoryText(player)
            },
            ...conversations[player]
        ];

        let completion = await client.chat.completions.create({
            model: "openai/gpt-oss-20b",
            messages,
            temperature: 0.9,
            max_tokens: 80
        });

        let reply = cleanReply(
            completion.choices?.[0]?.message?.content || ""
        );

        if (!reply) {
            reply = "uhh... my brain stopped working lol";
        }

        if (isRepeatedReply(player, reply)) {
            try {
                completion = await client.chat.completions.create({
                    model: "openai/gpt-oss-20b",
                    messages: [
                        ...messages,
                        {
                            role: "system",
                            content:
                                "Give a different natural response. " +
                                "Do not say sup. Respond to the latest message. " +
                                "Only output Bert's dialogue."
                        }
                    ],
                    temperature: 1.1,
                    max_tokens: 80
                });

                const retryReply = cleanReply(
                    completion.choices?.[0]?.message?.content || ""
                );

                if (
                    retryReply &&
                    !isRepeatedReply(player, retryReply)
                ) {
                    reply = retryReply;
                }
            } catch (retryError) {
                console.log("Bert retry failed:", retryError.message);
            }
        }

        if (reply.length > 200) {
            reply = reply.slice(0, 197) + "...";
        }

        conversations[player].push({
            role: "assistant",
            content: reply
        });

        conversations[player] =
            conversations[player].slice(-20);

        return res.json({ reply });

    } catch (err) {
        console.error("Bert AI error:", err);

        return res.status(500).json({
            error: "Bert AI request failed"
        });
    }
});

/*
    AI ACTION DECISIONS

    Roblox sends a description of the current situation.
    The AI chooses an action from the allowed list.

    IMPORTANT:
    This endpoint returns a decision only.
    Roblox still needs a controller to execute that decision.
*/

app.post("/decide", async (req, res) => {
    try {
        const npcName = String(req.body.npcName || "Bert").slice(0, 50);
        const situation = req.body.situation;

        if (
            !situation ||
            typeof situation !== "object" ||
            Array.isArray(situation)
        ) {
            return res.status(400).json({
                error: "Missing situation object"
            });
        }

        const allowedTargets = Array.isArray(situation.nearby)
            ? situation.nearby.slice(0, 12).map(item => ({
                name: String(item.name || "").slice(0, 50),
                type: String(item.type || "NPC").slice(0, 20),
                distance: Number(item.distance) || 0
            }))
            : [];

        const currentPosition = {
            x: Number(situation.position?.x) || 0,
            z: Number(situation.position?.z) || 0
        };

        const context = {
            position: currentPosition,
            nearby: allowedTargets,
            currentlyTalking: Boolean(situation.currentlyTalking),
            lastAction: String(situation.lastAction || "none").slice(0, 30),
            allowedArea: situation.allowedArea || null
        };

        const actionPrompt = `
You decide Bert's next in-game action in Teach an NPC.

PERSONALITY:
${systemPrompt}

CURRENT SITUATION:
${JSON.stringify(context)}

Choose exactly ONE action:
- "wander": walk to a new position. Return targetX and targetZ.
- "approach": walk toward one nearby character. Return targetName.
- "talk": start or continue a conversation with a nearby character.
  Return targetName and a short dialogue line in "dialogue".
- "wait": stay still briefly.
- "stop": stop moving.

RULES:
- Only target a name that appears in the nearby list.
- Do not invent targets.
- If currentlyTalking is true, choose "talk", "wait", or "stop".
- If nobody is nearby, choose "wander" or "wait".
- Stay inside allowedArea if its bounds are provided.
- Choose sensible actions; do not repeatedly choose the same failed action.
- Keep dialogue short, natural, and in Bert's personality.
- Do not include the action name inside the dialogue.
- Do not return markdown or explanations.

Return valid JSON only, using this format:
{
  "action": "wait",
  "targetName": "",
  "targetX": 0,
  "targetZ": 0,
  "dialogue": ""
}
`;

        const completion = await client.chat.completions.create({
            model: "openai/gpt-oss-20b",
            messages: [
                {
                    role: "system",
                    content:
                        "You are an NPC action decision engine. " +
                        "Return only valid JSON matching the requested schema."
                },
                {
                    role: "user",
                    content: actionPrompt
                }
            ],
            temperature: 0.5,
            max_tokens: 160
        });

        let raw = completion.choices?.[0]?.message?.content || "";
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

        let decision;

        try {
            decision = JSON.parse(raw);
        } catch (_) {
            return res.json({
                action: "wait",
                targetName: "",
                targetX: currentPosition.x,
                targetZ: currentPosition.z,
                dialogue: ""
            });
        }

        const validActions = [
            "wander",
            "approach",
            "talk",
            "wait",
            "stop"
        ];

        if (!validActions.includes(decision.action)) {
            decision.action = "wait";
        }

        const target = allowedTargets.find(
            item => item.name === String(decision.targetName || "")
        );

        if (
            ["approach", "talk"].includes(decision.action) &&
            !target
        ) {
            decision.action = "wait";
            decision.targetName = "";
            decision.dialogue = "";
        }

        const targetX = Number(decision.targetX);
        const targetZ = Number(decision.targetZ);

        decision.targetX = Number.isFinite(targetX)
            ? Math.max(-100000, Math.min(100000, targetX))
            : currentPosition.x;

        decision.targetZ = Number.isFinite(targetZ)
            ? Math.max(-100000, Math.min(100000, targetZ))
            : currentPosition.z;

        decision.targetName = target
            ? target.name
            : "";

        decision.dialogue = String(decision.dialogue || "").slice(0, 180);

        return res.json({
            action: decision.action,
            targetName: decision.targetName,
            targetX: decision.targetX,
            targetZ: decision.targetZ,
            dialogue: decision.dialogue
        });

    } catch (err) {
        console.error("Bert decision error:", err);

        return res.status(500).json({
            error: "Bert decision request failed"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Bert AI server running on port ${PORT}`);
});
