require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { getProperties, searchProperties, getPropertyById, addReservation, getReservations } = require("./data");
const {
    DEFAULT_AGENT,
    createAgent,
    getAgents,
    getAgentById,
    getAgentByPhoneNumber,
    updateAgent,
    deleteAgent,
} = require("./agents");

const app = express();
const server = http.createServer(app);

// ─── Config ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY is required in .env");
    process.exit(1);
}

// ─── Twilio Client (lazy init) ─────────────────────────────────────────
let twilioClient = null;
function getTwilioClient() {
    if (!twilioClient && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
        twilioClient = require("twilio")(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    }
    return twilioClient;
}

// ─── Tool Definitions for OpenAI Realtime ──────────────────────────────
const ALL_TOOLS = [
    {
        type: "function",
        name: "search_properties",
        description: "Search properties by criteria. Applies filters for location, price range, rooms, and type (sale/rent).",
        parameters: {
            type: "object",
            properties: {
                location: { type: "string", description: "Location or district name" },
                min_price: { type: "number", description: "Minimum price" },
                max_price: { type: "number", description: "Maximum price" },
                rooms: { type: "string", description: "Number of rooms, e.g. 3+1, 2+1" },
                type: { type: "string", enum: ["sale", "rent"], description: "sale = for sale, rent = for rent" }
            },
            required: []
        }
    },
    {
        type: "function",
        name: "get_property_details",
        description: "Get full details of a property by its ID.",
        parameters: {
            type: "object",
            properties: {
                property_id: { type: "string", description: "Property ID, e.g. P001" }
            },
            required: ["property_id"]
        }
    },
    {
        type: "function",
        name: "check_availability",
        description: "Check if a property is available for viewing on a specific date.",
        parameters: {
            type: "object",
            properties: {
                property_id: { type: "string", description: "Property ID" },
                date: { type: "string", description: "Requested date, e.g. 2026-02-20" }
            },
            required: ["property_id", "date"]
        }
    },
    {
        type: "function",
        name: "book_viewing",
        description: "Book a property viewing appointment.",
        parameters: {
            type: "object",
            properties: {
                property_id: { type: "string", description: "Property ID" },
                customer_name: { type: "string", description: "Customer full name" },
                customer_phone: { type: "string", description: "Phone number" },
                date: { type: "string", description: "Appointment date" },
                time: { type: "string", description: "Appointment time, e.g. 14:00" }
            },
            required: ["property_id", "customer_name", "customer_phone", "date", "time"]
        }
    },
    {
        type: "function",
        name: "make_reservation",
        description: "Make a purchase or rental reservation for a property.",
        parameters: {
            type: "object",
            properties: {
                property_id: { type: "string", description: "Property ID" },
                customer_name: { type: "string", description: "Customer full name" },
                customer_phone: { type: "string", description: "Phone number" },
                notes: { type: "string", description: "Additional notes" }
            },
            required: ["property_id", "customer_name", "customer_phone"]
        }
    }
];

// ─── Function Execution ───────────────────────────────────────────────
function executeFunction(name, args) {
    console.log(`⚡ Executing function: ${name}`, JSON.stringify(args));
    switch (name) {
        case "search_properties": {
            const results = searchProperties(args);
            if (results.length === 0) return JSON.stringify({ message: "No properties found matching criteria." });
            return JSON.stringify({
                count: results.length,
                properties: results.map(p => ({
                    id: p.id,
                    title: p.title,
                    location: p.location,
                    price: p.price,
                    rooms: p.rooms,
                    area: p.area + " sq ft",
                    type: p.type === "sale" ? "For Sale" : "For Rent"
                }))
            });
        }
        case "get_property_details": {
            const prop = getPropertyById(args.property_id);
            if (!prop) return JSON.stringify({ error: "Property not found." });
            return JSON.stringify({
                ...prop,
                price_formatted: prop.type === "sale"
                    ? "$" + prop.price.toLocaleString("en-US")
                    : "$" + prop.price.toLocaleString("en-US") + "/month",
                type_label: prop.type === "sale" ? "For Sale" : "For Rent"
            });
        }
        case "check_availability": {
            const prop = getPropertyById(args.property_id);
            if (!prop) return JSON.stringify({ available: false, message: "Property not found." });
            return JSON.stringify({
                available: true,
                property: prop.title,
                date: args.date,
                message: `${prop.title} is available for viewing on ${args.date}.`
            });
        }
        case "book_viewing": {
            const prop = getPropertyById(args.property_id);
            if (!prop) return JSON.stringify({ success: false, message: "Property not found." });
            const entry = addReservation({
                type: "viewing",
                property_id: args.property_id,
                property_title: prop.title,
                customer_name: args.customer_name,
                customer_phone: args.customer_phone,
                date: args.date,
                time: args.time
            });
            return JSON.stringify({
                success: true,
                reservation_id: entry.id,
                message: `Viewing booked for ${prop.title} on ${args.date} at ${args.time}. Ref: ${entry.id}`
            });
        }
        case "make_reservation": {
            const prop = getPropertyById(args.property_id);
            if (!prop) return JSON.stringify({ success: false, message: "Property not found." });
            const entry = addReservation({
                type: "reservation",
                property_id: args.property_id,
                property_title: prop.title,
                customer_name: args.customer_name,
                customer_phone: args.customer_phone,
                date: new Date().toLocaleDateString("en-US"),
                notes: args.notes || ""
            });
            return JSON.stringify({
                success: true,
                reservation_id: entry.id,
                message: `Reservation made for ${prop.title}. Ref: ${entry.id}. We will contact you shortly.`
            });
        }
        default:
            return JSON.stringify({ error: "Unknown function." });
    }
}

// ─── Serve static frontend ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── API Endpoints (original) ─────────────────────────────────────────
app.get("/api/properties", (req, res) => res.json(getProperties()));
app.get("/api/reservations", (req, res) => res.json(getReservations()));
app.get("/api/properties/:id", (req, res) => {
    const p = getPropertyById(req.params.id);
    p ? res.json(p) : res.status(404).json({ error: "Not found" });
});

// ─── Agent CRUD API ───────────────────────────────────────────────────
app.get("/api/agents", (req, res) => {
    res.json(getAgents());
});

app.get("/api/agents/:id", (req, res) => {
    const agent = getAgentById(req.params.id);
    agent ? res.json(agent) : res.status(404).json({ error: "Agent not found" });
});

app.post("/api/agents", async (req, res) => {
    try {
        const {
            name,
            description,
            systemPrompt,
            greeting,
            voice,
            language,
            firstMessage,
            enableTools,
            tools,
            areaCode,
        } = req.body;

        if (!name || !systemPrompt) {
            return res.status(400).json({ error: "Name and system prompt are required." });
        }

        // ── Purchase a Twilio phone number ──
        let phoneNumber = null;
        let phoneNumberSid = null;
        const client = getTwilioClient();

        if (client) {
            try {
                // Search for available US numbers
                const searchParams = { limit: 1, voiceEnabled: true };
                if (areaCode) searchParams.areaCode = areaCode;

                const availableNumbers = await client.availablePhoneNumbers("US")
                    .local.list(searchParams);

                if (availableNumbers.length === 0) {
                    return res.status(400).json({ error: "No available US phone numbers found. Try a different area code." });
                }

                const chosenNumber = availableNumbers[0].phoneNumber;

                // Get the public host URL for webhook
                const host = req.headers.host;
                const protocol = req.headers["x-forwarded-proto"] || req.protocol;
                const baseUrl = `${protocol}://${host}`;

                // Purchase the number and configure webhook
                const purchased = await client.incomingPhoneNumbers.create({
                    phoneNumber: chosenNumber,
                    voiceUrl: `${baseUrl}/incoming-call`,
                    voiceMethod: "POST",
                    friendlyName: `AI Agent: ${name}`,
                });

                phoneNumber = purchased.phoneNumber;
                phoneNumberSid = purchased.sid;
                console.log(`📱 Purchased number: ${phoneNumber} (${phoneNumberSid}) for agent: ${name}`);
            } catch (twilioErr) {
                console.error("❌ Twilio error:", twilioErr.message);
                return res.status(500).json({ error: `Twilio error: ${twilioErr.message}` });
            }
        } else {
            console.warn("⚠️ Twilio not configured — agent created without phone number");
        }

        const agent = createAgent({
            name,
            description,
            systemPrompt,
            greeting,
            voice: voice || "coral",
            language: language || "en-US",
            firstMessage: firstMessage || "",
            enableTools: enableTools || false,
            tools: tools || [],
            phoneNumber,
            phoneNumberSid,
        });

        res.status(201).json(agent);
    } catch (err) {
        console.error("❌ Create agent error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/agents/:id", async (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.id === "agent_default") return res.status(400).json({ error: "Cannot delete the default test agent." });

    // Release the Twilio number
    const client = getTwilioClient();
    if (client && agent.phoneNumberSid) {
        try {
            await client.incomingPhoneNumbers(agent.phoneNumberSid).remove();
            console.log(`📱 Released number: ${agent.phoneNumber}`);
        } catch (err) {
            console.error("⚠️ Could not release Twilio number:", err.message);
        }
    }

    deleteAgent(req.params.id);
    res.json({ success: true });
});

// ─── Twilio Number Search API ──────────────────────────────────────────
app.get("/api/twilio/available-numbers", async (req, res) => {
    const client = getTwilioClient();
    if (!client) {
        return res.status(400).json({ error: "Twilio is not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env" });
    }
    try {
        const { areaCode, contains } = req.query;
        const params = { limit: 10, voiceEnabled: true };
        if (areaCode) params.areaCode = areaCode;
        if (contains) params.contains = contains;

        const numbers = await client.availablePhoneNumbers("US").local.list(params);
        res.json(numbers.map(n => ({
            phoneNumber: n.phoneNumber,
            friendlyName: n.friendlyName,
            locality: n.locality,
            region: n.region,
            capabilities: n.capabilities,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Twilio Status Check ──────────────────────────────────────────────
app.get("/api/twilio/status", (req, res) => {
    const configured = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
    res.json({ configured });
});

// ─── Twilio TwiML endpoint (multi-agent) ───────────────────────────────
app.all("/incoming-call", (req, res) => {
    const host = req.headers.host;
    const calledNumber = req.body?.To || req.query?.To || "";

    // Find agent by called number, fall back to default
    let agent = getAgentByPhoneNumber(calledNumber);
    if (!agent) agent = DEFAULT_AGENT;

    console.log(`📞 Incoming call to ${calledNumber} → Agent: ${agent.name} (${agent.id})`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${agent.language}">${agent.firstMessage}</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream?agentId=${agent.id}" />
  </Connect>
</Response>`;
    res.set("Content-Type", "text/xml");
    res.send(twiml);
});

// ─── WebSocket server for Twilio Media Streams ─────────────────────────
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
    // Extract agentId from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const agentId = url.searchParams.get("agentId");
    let agent = agentId ? getAgentById(agentId) : DEFAULT_AGENT;
    if (!agent) agent = DEFAULT_AGENT;

    console.log(`🔌 Twilio Media Stream connected → Agent: ${agent.name} (${agent.id})`);

    let streamSid = null;
    let openaiWs = null;
    let audioBufferQueue = [];
    let isResponseActive = false;

    // ── Build session config from agent ──
    const sessionTools = agent.enableTools ? ALL_TOOLS.filter(t => agent.tools.includes(t.name)) : [];

    // ── Connect to OpenAI Realtime API ──
    const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini";
    openaiWs = new WebSocket(openaiUrl, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    openaiWs.on("open", () => {
        console.log(`✅ OpenAI connected for agent: ${agent.name}`);

        // Configure the session with agent-specific settings
        const sessionUpdate = {
            type: "session.update",
            session: {
                instructions: agent.systemPrompt,
                tools: sessionTools,
                tool_choice: sessionTools.length > 0 ? "auto" : "none",
                output_modalities: ["audio"],
                audio: {
                    input: {
                        format: { type: "audio/pcmu" },
                        turn_detection: {
                            type: "server_vad",
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 500,
                        },
                    },
                    output: {
                        format: { type: "audio/pcmu" },
                        voice: agent.voice || "coral",
                    },
                },
            },
        };
        openaiWs.send(JSON.stringify(sessionUpdate));
        console.log(`📋 Session configured — ${sessionTools.length} tools, voice: ${agent.voice}`);

        // Agent-specific greeting
        openaiWs.send(JSON.stringify({
            type: "response.create",
            response: {
                instructions: agent.greeting,
            },
        }));

        // Flush buffered audio
        for (const chunk of audioBufferQueue) openaiWs.send(JSON.stringify(chunk));
        audioBufferQueue = [];
    });

    openaiWs.on("message", (data) => {
        try {
            const event = JSON.parse(data.toString());

            switch (event.type) {
                case "session.created":
                    console.log("🎉 Session:", event.session?.id);
                    break;

                case "session.updated":
                    console.log("⚙️  Session updated");
                    break;

                case "response.output_audio.delta":
                    if (event.delta && streamSid) {
                        twilioWs.send(JSON.stringify({
                            event: "media",
                            streamSid,
                            media: { payload: event.delta },
                        }));
                    }
                    break;

                case "response.output_audio.done":
                    console.log("🔊 Audio done");
                    break;

                case "response.output_audio_transcript.delta":
                    if (event.delta) process.stdout.write(event.delta);
                    break;

                case "response.output_audio_transcript.done":
                    console.log("\n📝 AI:", event.transcript);
                    break;

                // ── Function Calling ──────────────────────────────
                case "response.function_call_arguments.done": {
                    const fnName = event.name;
                    let fnArgs = {};
                    try { fnArgs = JSON.parse(event.arguments || "{}"); } catch { }

                    console.log(`🔧 Function call: ${fnName}(${JSON.stringify(fnArgs)})`);
                    const result = executeFunction(fnName, fnArgs);
                    console.log(`✅ Result: ${result}`);

                    // Send function output back to OpenAI
                    openaiWs.send(JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: event.call_id,
                            output: result,
                        },
                    }));

                    // Trigger AI to respond with the result
                    openaiWs.send(JSON.stringify({
                        type: "response.create",
                    }));
                    break;
                }

                case "input_audio_buffer.speech_started":
                    console.log("🎤 User speaking");
                    if (isResponseActive) {
                        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
                    }
                    if (streamSid) {
                        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
                    }
                    break;

                case "input_audio_buffer.speech_stopped":
                    console.log("🔇 User stopped");
                    break;

                case "response.created":
                    isResponseActive = true;
                    break;

                case "response.done":
                    isResponseActive = false;
                    if (event.response?.usage) {
                        const u = event.response.usage;
                        console.log(`📊 Tokens — in: ${u.total_tokens || "?"}, out: ${u.output_tokens || "?"}`);
                    }
                    break;

                case "error":
                    console.error("❌ OpenAI error:", JSON.stringify(event.error, null, 2));
                    break;

                default:
                    if (!event.type.includes("delta") &&
                        !["response.output_item.added", "response.output_item.done",
                            "conversation.item.added", "conversation.item.done",
                            "input_audio_buffer.committed"].includes(event.type)) {
                        console.log("📨 Event:", event.type);
                    }
                    break;
            }
        } catch (err) {
            console.error("❌ Parse error:", err.message);
        }
    });

    openaiWs.on("error", (err) => console.error("❌ OpenAI WS error:", err.message));
    openaiWs.on("close", (code, reason) => console.log(`🔒 OpenAI closed: ${code}`));

    // ── Handle Twilio messages ──
    twilioWs.on("message", (message) => {
        try {
            const msg = JSON.parse(message.toString());
            switch (msg.event) {
                case "start":
                    streamSid = msg.start.streamSid;
                    console.log(`📞 Call started — Stream: ${streamSid}`);
                    break;
                case "media":
                    const audioEvent = { type: "input_audio_buffer.append", audio: msg.media.payload };
                    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(audioEvent));
                    else audioBufferQueue.push(audioEvent);
                    break;
                case "stop":
                    console.log("📴 Stream stopped");
                    break;
            }
        } catch (err) {
            console.error("❌ Twilio parse error:", err.message);
        }
    });

    twilioWs.on("close", () => {
        console.log("📴 Twilio disconnected");
        if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
    });
    twilioWs.on("error", (err) => console.error("❌ Twilio WS error:", err.message));
});

// ─── Start ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║      🤖 AI Voice Agent Platform                             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Server: http://localhost:${String(PORT).padEnd(35)}║
║  Tools:  ${String(ALL_TOOLS.length + " function(s) registered").padEnd(51)}║
║  Twilio: ${String(TWILIO_ACCOUNT_SID ? "✅ Configured" : "⚠️ Not configured").padEnd(51)}║
║                                                              ║
║  Endpoints:                                                  ║
║    • Dashboard:   http://localhost:${String(PORT).padEnd(26)}║
║    • Wizard:      http://localhost:${String(PORT + "/wizard.html").padEnd(26)}║
║    • API:         /api/agents, /api/properties               ║
║    • Twilio:      /incoming-call                             ║
║    • WebSocket:   /media-stream                              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
