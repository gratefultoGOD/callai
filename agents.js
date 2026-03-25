// ─── Agents Store (SQLite-backed) ─────────────────────────────────────
// Agent data is persisted in SQLite via db.js.

const crypto = require("crypto");
const { stmts, rowToAgent } = require("./db");

// ─── Default (test) agent — runtime-only, never stored in DB ──────────
// This is the built-in demo agent with no phone number.
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
- When property details are requested, use the get_property_details tool.
- When a client wants to schedule a viewing or appointment, first check calendar availability using check_calendar_availability.
- Then use schedule_calendar_appointment to book on the calendar.
- Always confirm appointment details with the client before scheduling.`,
    greeting: "Greet the caller warmly. Introduce yourself as 'Sophia', the PrestigeAI real estate assistant. Ask how you can help. Keep it to 2-3 sentences.",
    voice: "coral",
    language: "en-US",
    firstMessage: "Hello, you are being connected to the PrestigeAI real estate assistant. Please hold on.",
    phoneNumber: null,
    phoneNumberSid: null,
    enableTools: true,
    tools: ["search_properties", "get_property_details", "check_availability", "book_viewing", "make_reservation", "check_calendar_availability", "schedule_calendar_appointment"],
    status: "active",
    ownerId: null,
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

    const row = {
        id: generateId(),
        owner_id: ownerId,
        name,
        description: description || "",
        system_prompt: systemPrompt,
        greeting: greeting || `Greet the caller warmly. Introduce yourself as the AI assistant for ${name}. Ask how you can help. Keep it to 2-3 sentences.`,
        voice,
        language,
        first_message: firstMessage || `Hello, you are being connected to ${name}. Please wait.`,
        enable_tools: enableTools ? 1 : 0,
        tools: JSON.stringify(tools),
        phone_number: phoneNumber,
        phone_number_sid: phoneNumberSid,
        status: "active",
        created_at: new Date().toISOString(),
    };

    stmts.agentInsert.run(row);
    const agent = rowToAgent(stmts.agentById.get(row.id));
    console.log(`🤖 Agent created: ${agent.name} (${agent.id}) for user ${ownerId} → ${agent.phoneNumber || "no number"}`);
    return agent;
}

/** Returns all agents for a specific user (does NOT include DEFAULT_AGENT) */
function getAgentsByUser(userId) {
    return stmts.agentsByOwner.all(userId).map(rowToAgent);
}

/** Returns all agents globally (DEFAULT + all user agents) — for internal/Twilio routing */
function getAllAgents() {
    return [DEFAULT_AGENT, ...stmts.agentAll.all().map(rowToAgent)];
}

/** Returns DEFAULT + user's own agents — for dashboard display */
function getAgentsForUser(userId) {
    return [DEFAULT_AGENT, ...stmts.agentsByOwner.all(userId).map(rowToAgent)];
}

function getAgentById(id) {
    if (id === DEFAULT_AGENT.id) return DEFAULT_AGENT;
    const row = stmts.agentById.get(id);
    return rowToAgent(row);
}

function getAgentByPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    const normalized = phoneNumber.replace(/[\s\-()]/g, "");

    // Check default agent first
    if (DEFAULT_AGENT.phoneNumber &&
        DEFAULT_AGENT.phoneNumber.replace(/[\s\-()]/g, "") === normalized) {
        return DEFAULT_AGENT;
    }

    // Exact match in DB
    const row = stmts.agentByPhone.get(phoneNumber);
    if (row) return rowToAgent(row);

    // Fallback: normalize and compare all agents
    const all = stmts.agentAll.all();
    const found = all.find(a => a.phone_number &&
        a.phone_number.replace(/[\s\-()]/g, "") === normalized);
    return found ? rowToAgent(found) : null;
}

function updateAgent(id, updates) {
    if (id === DEFAULT_AGENT.id) {
        Object.assign(DEFAULT_AGENT, updates);
        return DEFAULT_AGENT;
    }
    const existing = getAgentById(id);
    if (!existing) return null;

    const merged = {
        id,
        name: updates.name ?? existing.name,
        description: updates.description ?? existing.description,
        system_prompt: updates.systemPrompt ?? existing.systemPrompt,
        greeting: updates.greeting ?? existing.greeting,
        voice: updates.voice ?? existing.voice,
        language: updates.language ?? existing.language,
        first_message: updates.firstMessage ?? existing.firstMessage,
        enable_tools: (updates.enableTools ?? existing.enableTools) ? 1 : 0,
        tools: JSON.stringify(updates.tools ?? existing.tools),
        phone_number: updates.phoneNumber ?? existing.phoneNumber,
        phone_number_sid: updates.phoneNumberSid ?? existing.phoneNumberSid,
        status: updates.status ?? existing.status,
    };

    stmts.agentUpdate.run(merged);
    return getAgentById(id);
}

function deleteAgent(id) {
    if (id === DEFAULT_AGENT.id) return false;
    const result = stmts.agentDelete.run(id);
    return result.changes > 0;
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
