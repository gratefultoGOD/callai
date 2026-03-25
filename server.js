require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { getProperties, searchProperties, getPropertyById, addReservation, getReservations } = require("./data");
require("./db"); // Ensure DB is initialized and WAL mode is set on startup
const {
    DEFAULT_AGENT,
    createAgent,
    getAllAgents,
    getAgentsForUser,
    getAgentById,
    getAgentByPhoneNumber,
    updateAgent,
    deleteAgent,
} = require("./agents");
const {
    registerUser,
    loginUser,
    loginOrRegisterGoogleUser,
    logoutToken,
    safeUser,
    requireAuth,
    extractToken,
    getUserByToken,
    GOOGLE_CLIENT_ID,
} = require("./auth");
const gcal = require("./google-calendar");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();

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
    },
    {
        type: "function",
        name: "check_calendar_availability",
        description: "Check the business owner's Google Calendar for available appointment slots on a specific date. Returns busy times and available 30-minute slots during working hours (9 AM - 6 PM).",
        parameters: {
            type: "object",
            properties: {
                date: { type: "string", description: "Date to check availability, format: YYYY-MM-DD, e.g. 2026-03-15" }
            },
            required: ["date"]
        }
    },
    {
        type: "function",
        name: "schedule_calendar_appointment",
        description: "Schedule an appointment on the business owner's Google Calendar. Use this after confirming available slots with check_calendar_availability.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "Appointment title/summary, e.g. 'Property viewing with John' " },
                date: { type: "string", description: "Date for the appointment, format: YYYY-MM-DD" },
                start_time: { type: "string", description: "Start time in HH:MM format, e.g. 14:00" },
                duration_minutes: { type: "number", description: "Duration in minutes, default 30" },
                customer_name: { type: "string", description: "Customer name" },
                customer_phone: { type: "string", description: "Customer phone number" },
                notes: { type: "string", description: "Additional notes or description" }
            },
            required: ["title", "date", "start_time", "customer_name"]
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
        case "check_calendar_availability": {
            // This function is async; we return a promise-like wrapper
            // Actually, executeFunction needs to be sync for the current flow.
            // We'll handle this specially — return a placeholder and process async.
            return JSON.stringify({ async: true, function: "check_calendar_availability", args });
        }
        case "schedule_calendar_appointment": {
            return JSON.stringify({ async: true, function: "schedule_calendar_appointment", args });
        }
        default:
            return JSON.stringify({ error: "Unknown function." });
    }
}

// ─── Async Function Execution (for Google Calendar) ───────────────────
async function executeFunctionAsync(name, args, agentOwnerId) {
    switch (name) {
        case "check_calendar_availability": {
            if (!agentOwnerId) return JSON.stringify({ error: "No agent owner configured for calendar access." });
            try {
                const result = await gcal.checkAvailability(agentOwnerId, args.date);
                if (!result.hasAvailability) {
                    return JSON.stringify({ available: false, message: `No available slots on ${args.date}. All times are booked.`, busySlots: result.busySlots });
                }
                return JSON.stringify({
                    available: true,
                    date: result.date,
                    availableSlots: result.availableSlots.slice(0, 10), // limit to 10 for context
                    totalAvailable: result.availableSlots.length,
                    busyCount: result.busySlots.length,
                });
            } catch (err) {
                return JSON.stringify({ error: "Calendar error: " + err.message });
            }
        }
        case "schedule_calendar_appointment": {
            if (!agentOwnerId) return JSON.stringify({ error: "No agent owner configured for calendar access." });
            try {
                const duration = args.duration_minutes || 30;
                const startDateTime = `${args.date}T${args.start_time}:00Z`;
                const endDate = new Date(new Date(startDateTime).getTime() + duration * 60 * 1000);
                const endDateTime = endDate.toISOString();

                const description = [
                    args.customer_name ? `Customer: ${args.customer_name}` : "",
                    args.customer_phone ? `Phone: ${args.customer_phone}` : "",
                    args.notes || "",
                ].filter(Boolean).join("\n");

                const event = await gcal.createEvent(agentOwnerId, {
                    summary: args.title,
                    description,
                    startDateTime,
                    endDateTime,
                });

                return JSON.stringify({
                    success: true,
                    message: `Appointment "${event.summary}" scheduled on ${args.date} at ${args.start_time} (${duration} min).`,
                    eventId: event.id,
                    link: event.htmlLink,
                });
            } catch (err) {
                return JSON.stringify({ error: "Calendar error: " + err.message });
            }
        }
        default:
            return JSON.stringify({ error: "Unknown async function." });
    }
}

// ─── Analytics Middleware (track all page requests) ──────────────────
const SKIP_ANALYTICS = /^\/(api|_|favicon|robots|sitemap|manifest)/;
app.use((req, res, next) => {
    if (SKIP_ANALYTICS.test(req.path)) return next();
    const start = Date.now();
    res.on("finish", () => {
        try {
            const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
            const ua = req.headers["user-agent"] || "";
            const ref = req.headers["referer"] || req.headers["referrer"] || "";
            const ms = Date.now() - start;
            const { stmts } = require("./db");
            stmts.pageViewInsert.run(req.path, req.method, res.statusCode, ip, ua, ref, ms);
        } catch (_) { }
    });
    next();
});

// ─── Admin-only middleware ────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const token = extractToken(req);
    const user = getUserByToken(token);
    if (!user) return res.status(401).sendFile(pub("login.html"));
    if (!ADMIN_EMAIL || user.email.toLowerCase() !== ADMIN_EMAIL) {
        return res.status(403).send("<h2>403 Yasak &#x1F6AB;</h2><p>Bu sayfaya eri&#351;im yetkiniz yok.</p>");
    }
    req.currentUser = user;
    next();
}

app.use(express.json());

// ─── Page Routes (clean URLs) — must come BEFORE static ───────────────
const pub = (file) => path.join(__dirname, "public", file);

app.get("/", (req, res) => res.sendFile(pub("index.html")));
app.get("/login", (req, res) => res.sendFile(pub("login.html")));
app.get("/dashboard", (req, res) => res.sendFile(pub("dashboard.html")));
app.get("/wizard", (req, res) => res.sendFile(pub("wizard.html")));
app.get("/analytics", (req, res) => res.sendFile(pub("analytics.html")));
app.get("/demo", (req, res) => res.sendFile(pub("demo.html")));

// Redirect legacy .html URLs → clean URLs (301 permanent)
app.get("/index.html", (req, res) => res.redirect(301, "/"));
app.get("/login.html", (req, res) => res.redirect(301, "/login"));
app.get("/dashboard.html", (req, res) => res.redirect(301, "/dashboard"));
app.get("/wizard.html", (req, res) => res.redirect(301, "/wizard"));
app.get("/analytics.html", (req, res) => res.redirect(301, "/analytics"));

// Static assets (js, css, images, fonts...) — index:false so "/" is handled above
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ─── Analytics API (admin only) ───────────────────────────────────────
app.get("/api/analytics/summary", requireAdmin, (req, res) => {
    const { stmts } = require("./db");
    res.json({
        total: stmts.pageViewsTotal.get().count,
        today: stmts.pageViewsToday.get().count,
        last7Days: stmts.pageViewsLast7Days.get().count,
        uniqueIPs: stmts.pageViewsUniqueIPs.get().count,
        avgResponse: Math.round(stmts.pageViewsAvgResponse.get().avg || 0),
    });
});

app.get("/api/analytics/by-path", requireAdmin, (req, res) => res.json(require("./db").stmts.pageViewsByPath.all()));
app.get("/api/analytics/by-day", requireAdmin, (req, res) => res.json(require("./db").stmts.pageViewsByDay.all()));
app.get("/api/analytics/by-hour", requireAdmin, (req, res) => res.json(require("./db").stmts.pageViewsByHour.all()));
app.get("/api/analytics/by-referer", requireAdmin, (req, res) => res.json(require("./db").stmts.pageViewsByReferer.all()));
app.get("/api/analytics/by-ua", requireAdmin, (req, res) => res.json(require("./db").stmts.pageViewsByUserAgent.all()));
app.get("/api/analytics/recent", requireAdmin, (req, res) => res.json(require("./db").stmts.pageViewsRecent.all()));

// ─── Auth API ─────────────────────────────────────────────────────────
app.post("/api/auth/register", (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "E-posta ve şifre zorunludur." });
    }
    const result = registerUser({ email, password, name });
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Auto-login after register
    const loginResult = loginUser({ email, password });
    res.status(201).json({ token: loginResult.token, user: loginResult.user });
});

app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "E-posta ve şifre zorunludur." });
    }
    const result = loginUser({ email, password });
    if (!result.ok) return res.status(401).json({ error: result.error });
    res.json({ token: result.token, user: result.user });
});

app.post("/api/auth/logout", (req, res) => {
    const token = extractToken(req);
    if (token) logoutToken(token);
    res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: safeUser(req.currentUser) });
});

app.post("/api/auth/google", async (req, res) => {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "Google credential eksik." });
    const result = await loginOrRegisterGoogleUser(credential);
    if (!result.ok) return res.status(401).json({ error: result.error });
    res.json({ token: result.token, user: result.user });
});

app.get("/api/auth/google-client-id", (req, res) => {
    res.json({ clientId: GOOGLE_CLIENT_ID || null });
});

// ─── Google Calendar API ──────────────────────────────────────────────
app.get("/api/calendar/status", requireAuth, (req, res) => {
    res.json({
        configured: gcal.isConfigured(),
        connected: gcal.isCalendarConnected(req.currentUser.id),
    });
});

app.get("/api/calendar/auth-url", requireAuth, (req, res) => {
    if (!gcal.isConfigured()) {
        return res.status(400).json({ error: "Google Calendar OAuth is not configured. Add GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET to .env" });
    }
    const url = gcal.getAuthUrl(req.currentUser.id);
    res.json({ url });
});

app.get("/api/calendar/callback", async (req, res) => {
    const { code, state: userId } = req.query;
    if (!code || !userId) {
        return res.status(400).send("Missing code or state parameter.");
    }
    try {
        const tokens = await gcal.exchangeCode(code);
        gcal.saveTokens(userId, tokens);
        // Redirect to dashboard with success message
        res.redirect("/dashboard?calendar=connected");
    } catch (err) {
        console.error("❌ Google Calendar callback error:", err.message);
        res.redirect("/dashboard?calendar=error");
    }
});

app.get("/api/calendar/events", requireAuth, async (req, res) => {
    if (!gcal.isCalendarConnected(req.currentUser.id)) {
        return res.status(400).json({ error: "Google Calendar not connected." });
    }
    try {
        const { timeMin, timeMax } = req.query;
        const events = await gcal.getEvents(req.currentUser.id, timeMin, timeMax);
        res.json(events);
    } catch (err) {
        console.error("❌ Calendar events error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/calendar/events", requireAuth, async (req, res) => {
    if (!gcal.isCalendarConnected(req.currentUser.id)) {
        return res.status(400).json({ error: "Google Calendar not connected." });
    }
    try {
        const event = await gcal.createEvent(req.currentUser.id, req.body);
        res.status(201).json(event);
    } catch (err) {
        console.error("❌ Calendar create error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/calendar/disconnect", requireAuth, (req, res) => {
    gcal.disconnectCalendar(req.currentUser.id);
    res.json({ ok: true });
});

app.get("/api/calendar/availability", requireAuth, async (req, res) => {
    if (!gcal.isCalendarConnected(req.currentUser.id)) {
        return res.status(400).json({ error: "Google Calendar not connected." });
    }
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ error: "date query parameter required (YYYY-MM-DD)" });
        const result = await gcal.checkAvailability(req.currentUser.id, date);
        res.json(result);
    } catch (err) {
        console.error("❌ Calendar availability error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── API Endpoints (original) ─────────────────────────────────────────
app.get("/api/properties", (req, res) => res.json(getProperties()));
app.get("/api/reservations", requireAuth, (req, res) => res.json(getReservations()));
// Public demo reservations endpoint (no auth needed — shown on demo page)
app.get("/api/demo/reservations", (req, res) => res.json(getReservations()));
app.get("/api/properties/:id", (req, res) => {
    const p = getPropertyById(req.params.id);
    p ? res.json(p) : res.status(404).json({ error: "Not found" });
});

// ─── Agent CRUD API (requires auth) ───────────────────────────────────
app.get("/api/agents", requireAuth, (req, res) => {
    res.json(getAgentsForUser(req.currentUser.id));
});

app.get("/api/agents/:id", requireAuth, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    // Allow access to default agent or own agents
    if (agent.id !== "agent_default" && agent.ownerId !== req.currentUser.id) {
        return res.status(403).json({ error: "Bu agent'a erişim izniniz yok." });
    }
    res.json(agent);
});

app.post("/api/agents", requireAuth, async (req, res) => {
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
                const searchParams = { limit: 1, voiceEnabled: true };
                if (areaCode) searchParams.areaCode = areaCode;

                const availableNumbers = await client.availablePhoneNumbers("US")
                    .local.list(searchParams);

                if (availableNumbers.length === 0) {
                    return res.status(400).json({ error: "No available US phone numbers found. Try a different area code." });
                }

                const chosenNumber = availableNumbers[0].phoneNumber;
                const host = req.headers.host;
                const protocol = req.headers["x-forwarded-proto"] || req.protocol;
                const baseUrl = `${protocol}://${host}`;

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
            ownerId: req.currentUser.id,
        });

        res.status(201).json(agent);
    } catch (err) {
        console.error("❌ Create agent error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/agents/:id", requireAuth, async (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.id === "agent_default") return res.status(400).json({ error: "Cannot delete the default test agent." });
    if (agent.ownerId !== req.currentUser.id) {
        return res.status(403).json({ error: "Bu agent'ı silme yetkiniz yok." });
    }

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
app.get("/api/twilio/available-numbers", requireAuth, async (req, res) => {
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
// Audio pipeline: Twilio ↔ OpenAI (NO server-side transcoding)
//   Twilio: G.711 μ-law (PCMU), 8kHz — we tell OpenAI to use audio/pcmu too
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const agentId = url.searchParams.get("agentId");
    let agent = agentId ? getAgentById(agentId) : DEFAULT_AGENT;
    if (!agent) agent = DEFAULT_AGENT;

    console.log(`🔌 Twilio Media Stream connected → Agent: ${agent.name} (${agent.id})`);

    let streamSid = null;
    let openaiWs = null;
    let audioBufferQueue = [];
    let isResponseActive = false;

    const sessionTools = agent.enableTools ? ALL_TOOLS.filter(t => agent.tools.includes(t.name)) : [];

    // ── Connect to OpenAI Realtime ──────────────────────────────────────
    const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini";
    openaiWs = new WebSocket(openaiUrl, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    openaiWs.on("open", () => {
        console.log(`✅ OpenAI connected for agent: ${agent.name}`);

        // ── session.update — schema verified from live API responses ──────
        // output_modalities: ["audio"] (top-level, NOT modalities)
        // audio.input.format:  { type: "audio/pcmu" } → G.711 μ-law 8kHz (Twilio native)
        // audio.output.format: { type: "audio/pcmu" } → same, no transcoding needed
        // turn_detection fields from live session.created schema
        const sessionUpdate = {
            type: "session.update",
            session: {
                type: "realtime",
                model: "gpt-realtime-mini",
                output_modalities: ["audio"],
                instructions: agent.systemPrompt,
                tools: sessionTools,
                tool_choice: sessionTools.length > 0 ? "auto" : "none",
                audio: {
                    input: {
                        format: { type: "audio/pcmu" },
                        turn_detection: {
                            type: "server_vad",
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 200,
                            idle_timeout_ms: null,
                            create_response: true,
                            interrupt_response: true,
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
        console.log(`📋 Session update sent — ${sessionTools.length} tools, voice: ${agent.voice}`);

        // ── Greeting ────────────────────────────────────────────────────
        if (agent.greeting) {
            openaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: agent.greeting }],
                },
            }));
            openaiWs.send(JSON.stringify({ type: "response.create" }));
        }

        for (const chunk of audioBufferQueue) openaiWs.send(JSON.stringify(chunk));
        audioBufferQueue = [];
    });

    openaiWs.on("message", (data) => {
        try {
            const event = JSON.parse(data.toString());

            switch (event.type) {
                case "session.created":
                    console.log("🎉 Session created:", event.session?.id);
                    console.log("   └ input format :", event.session?.audio?.input?.format);
                    console.log("   └ output format:", event.session?.audio?.output?.format);
                    console.log("   └ voice        :", event.session?.audio?.output?.voice);
                    break;

                case "session.updated":
                    console.log("⚙️  Session updated — output format:", event.session?.audio?.output?.format?.type);
                    break;

                case "response.output_audio.delta":
                    // OpenAI returns audio/pcmu → pass directly to Twilio (no transcoding)
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

                case "response.function_call_arguments.done": {
                    const fnName = event.name;
                    let fnArgs = {};
                    try { fnArgs = JSON.parse(event.arguments || "{}"); } catch { }

                    console.log(`🔧 Function call: ${fnName}(${JSON.stringify(fnArgs)})`);

                    // Check if this is an async function (calendar)
                    const isAsyncFn = ["check_calendar_availability", "schedule_calendar_appointment"].includes(fnName);

                    if (isAsyncFn) {
                        // Execute async function
                        const callId = event.call_id;
                        executeFunctionAsync(fnName, fnArgs, agent.ownerId).then((result) => {
                            console.log(`✅ Async Result: ${result}`);
                            if (openaiWs?.readyState === WebSocket.OPEN) {
                                openaiWs.send(JSON.stringify({
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: callId,
                                        output: result,
                                    },
                                }));
                                openaiWs.send(JSON.stringify({ type: "response.create" }));
                            }
                        }).catch((err) => {
                            console.error(`❌ Async function error:`, err);
                            if (openaiWs?.readyState === WebSocket.OPEN) {
                                openaiWs.send(JSON.stringify({
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: callId,
                                        output: JSON.stringify({ error: err.message }),
                                    },
                                }));
                                openaiWs.send(JSON.stringify({ type: "response.create" }));
                            }
                        });
                    } else {
                        const result = executeFunction(fnName, fnArgs);
                        console.log(`✅ Result: ${result}`);

                        openaiWs.send(JSON.stringify({
                            type: "conversation.item.create",
                            item: {
                                type: "function_call_output",
                                call_id: event.call_id,
                                output: result,
                            },
                        }));
                        openaiWs.send(JSON.stringify({ type: "response.create" }));
                    }
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
    openaiWs.on("close", (code) => console.log(`🔒 OpenAI closed: ${code}`));

    twilioWs.on("message", (message) => {
        try {
            const msg = JSON.parse(message.toString());
            switch (msg.event) {
                case "start":
                    streamSid = msg.start.streamSid;
                    console.log(`📞 Call started — Stream: ${streamSid}`);
                    break;
                case "media":
                    // Twilio sends audio/pcmu → pass directly to OpenAI (no transcoding)
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
║    • Landing:     http://localhost:${String(PORT).padEnd(26)}║
║    • Login:       http://localhost:${String(PORT + "/login").padEnd(26)}║
║    • Dashboard:   http://localhost:${String(PORT + "/dashboard").padEnd(26)}║
║    • Wizard:      http://localhost:${String(PORT + "/wizard").padEnd(26)}║
║    • API:         /api/agents, /api/properties               ║
║    • Auth:        /api/auth/register, /api/auth/login        ║
║    • Twilio:      /incoming-call                             ║
║    • WebSocket:   /media-stream                              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

