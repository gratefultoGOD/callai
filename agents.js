// ─── Agents Store ─────────────────────────────────────────────────────
// In-memory store for AI voice agents created via the wizard.
// Each agent is owned by a userId; the default agent is global.

const crypto = require("crypto");

// Per-user agents: userId → Agent[]
const agentsByUser = {}; // { [userId]: Agent[] }

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
    phoneNumber: null,
    phoneNumberSid: null,
    enableTools: true,
    tools: ["search_properties", "get_property_details", "check_availability", "book_viewing", "make_reservation"],
    status: "active",
    ownerId: null, // global default
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
    ownerId,
}) {
    if (!ownerId) throw new Error("ownerId is required to create an agent.");

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
        ownerId,
        createdAt: new Date().toISOString(),
    };

    if (!agentsByUser[ownerId]) agentsByUser[ownerId] = [];
    agentsByUser[ownerId].push(agent);

    console.log(`🤖 Agent created: ${agent.name} (${agent.id}) for user ${ownerId} → ${agent.phoneNumber || "no number"}`);
    return agent;
}

/** Returns all agents for a specific user (does NOT include DEFAULT_AGENT for normal use) */
function getAgentsByUser(userId) {
    return agentsByUser[userId] || [];
}

/** Returns all agents globally (DEFAULT + all user agents) — for internal/Twilio routing */
function getAllAgents() {
    const all = [];
    for (const agents of Object.values(agentsByUser)) {
        all.push(...agents);
    }
    return [DEFAULT_AGENT, ...all];
}

/** Legacy helper used by dashboard — returns DEFAULT + user's agents */
function getAgentsForUser(userId) {
    return [DEFAULT_AGENT, ...(agentsByUser[userId] || [])];
}

function getAgentById(id) {
    if (id === DEFAULT_AGENT.id) return DEFAULT_AGENT;
    for (const agents of Object.values(agentsByUser)) {
        const found = agents.find(a => a.id === id);
        if (found) return found;
    }
    return null;
}

function getAgentByPhoneNumber(phoneNumber) {
    const normalized = phoneNumber.replace(/[\s\-()]/g, "");
    if (DEFAULT_AGENT.phoneNumber && DEFAULT_AGENT.phoneNumber.replace(/[\s\-()]/g, "") === normalized) {
        return DEFAULT_AGENT;
    }
    for (const agents of Object.values(agentsByUser)) {
        const found = agents.find(a => a.phoneNumber && a.phoneNumber.replace(/[\s\-()]/g, "") === normalized);
        if (found) return found;
    }
    return null;
}

function updateAgent(id, updates) {
    if (id === DEFAULT_AGENT.id) {
        Object.assign(DEFAULT_AGENT, updates);
        return DEFAULT_AGENT;
    }
    const agent = getAgentById(id);
    if (!agent) return null;
    Object.assign(agent, updates);
    return agent;
}

function deleteAgent(id) {
    if (id === DEFAULT_AGENT.id) return false;
    for (const userId of Object.keys(agentsByUser)) {
        const idx = agentsByUser[userId].findIndex(a => a.id === id);
        if (idx !== -1) {
            agentsByUser[userId].splice(idx, 1);
            return true;
        }
    }
    return false;
}

module.exports = {
    DEFAULT_AGENT,
    createAgent,
    getAgentsByUser,
    getAllAgents,
    getAgentsForUser,
    getAgentById,
    getAgentByPhoneNumber,
    updateAgent,
    deleteAgent,
};
