// ─── Agents Store ─────────────────────────────────────────────────────
// In-memory store for AI voice agents created via the wizard.
// Each agent gets its own system prompt, voice, tools, and Twilio number.

const crypto = require("crypto");

const agents = [];

// ─── Default (test) agent — preserves original functionality ──────────
const DEFAULT_AGENT = {
    id: "agent_default",
    name: "Sophia — PrestigeAI",
    description: "PrestigeAI real estate voice assistant",
    systemPrompt: `You are the AI voice assistant for "PrestigeAI" real estate company. Your name is Sophia.
Your job is to provide property information, help with property searches, schedule appointments, and take reservations.

Rules:
- Always speak in English and be polite.
- Keep your answers short and clear — don't ramble.
- State prices in US dollars.
- Be friendly yet professional with clients.
- Actively use the tools at your disposal — when a client asks about properties, call search_properties.
- When they request an appointment or reservation, ask for the necessary details (name, phone, date) and call the tool.
- When availability is asked, use the check_availability tool.
- When property details are requested, use the get_property_details tool.`,
    greeting: "Greet the caller warmly. Introduce yourself as 'Sophia', the PrestigeAI real estate assistant. Ask how you can help. Keep it to 2-3 sentences.",
    voice: "coral",
    language: "en-US",
    firstMessage: "Hello, you are being connected to the PrestigeAI real estate assistant. Please hold on.",
    phoneNumber: null, // Will be set from env or Twilio
    phoneNumberSid: null,
    enableTools: true,
    tools: ["search_properties", "get_property_details", "check_availability", "book_viewing", "make_reservation"],
    status: "active",
    createdAt: new Date().toISOString(),
};

// ─── CRUD Functions ───────────────────────────────────────────────────

function generateId() {
    return "agent_" + crypto.randomBytes(6).toString("hex");
}

function createAgent({
    name,
    description,
    systemPrompt,
    greeting,
    voice = "coral",
    language = "en-US",
    firstMessage = "",
    enableTools = false,
    tools = [],
    phoneNumber = null,
    phoneNumberSid = null,
}) {
    const agent = {
        id: generateId(),
        name,
        description: description || "",
        systemPrompt,
        greeting: greeting || `Greet the caller warmly. Introduce yourself as the AI assistant for ${name}. Ask how you can help. Keep it to 2-3 sentences.`,
        voice,
        language,
        firstMessage: firstMessage || `Hello, you are being connected to ${name}. Please wait.`,
        phoneNumber,
        phoneNumberSid,
        enableTools,
        tools,
        status: "active",
        createdAt: new Date().toISOString(),
    };
    agents.push(agent);
    console.log(`🤖 Agent created: ${agent.name} (${agent.id}) → ${agent.phoneNumber || "no number"}`);
    return agent;
}

function getAgents() {
    return [DEFAULT_AGENT, ...agents];
}

function getAgentById(id) {
    if (id === DEFAULT_AGENT.id) return DEFAULT_AGENT;
    return agents.find(a => a.id === id) || null;
}

function getAgentByPhoneNumber(phoneNumber) {
    // Normalize: strip spaces, dashes
    const normalized = phoneNumber.replace(/[\s\-()]/g, "");
    if (DEFAULT_AGENT.phoneNumber && DEFAULT_AGENT.phoneNumber.replace(/[\s\-()]/g, "") === normalized) {
        return DEFAULT_AGENT;
    }
    return agents.find(a => a.phoneNumber && a.phoneNumber.replace(/[\s\-()]/g, "") === normalized) || null;
}

function updateAgent(id, updates) {
    if (id === DEFAULT_AGENT.id) {
        Object.assign(DEFAULT_AGENT, updates);
        return DEFAULT_AGENT;
    }
    const agent = agents.find(a => a.id === id);
    if (!agent) return null;
    Object.assign(agent, updates);
    return agent;
}

function deleteAgent(id) {
    if (id === DEFAULT_AGENT.id) return false; // Can't delete default
    const idx = agents.findIndex(a => a.id === id);
    if (idx === -1) return false;
    agents.splice(idx, 1);
    return true;
}

module.exports = {
    DEFAULT_AGENT,
    createAgent,
    getAgents,
    getAgentById,
    getAgentByPhoneNumber,
    updateAgent,
    deleteAgent,
};
