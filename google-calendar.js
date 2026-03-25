// ─── Google Calendar Integration ──────────────────────────────────────
// OAuth2 flow + Calendar API helpers for the VoiceAgent platform.

const { google } = require("googleapis");
const { stmts } = require("./db");

const SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
];

// ── OAuth2 Client Factory ──────────────────────────────────────────────
function getOAuth2Client() {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI || "http://localhost:3000/api/calendar/callback";

    if (!clientId || !clientSecret) return null;

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ── Generate Auth URL ──────────────────────────────────────────────────
function getAuthUrl(userId) {
    const oauth2Client = getOAuth2Client();
    if (!oauth2Client) return null;

    return oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
        state: userId, // pass userId through OAuth flow
    });
}

// ── Exchange Code for Tokens ───────────────────────────────────────────
async function exchangeCode(code) {
    const oauth2Client = getOAuth2Client();
    if (!oauth2Client) throw new Error("Google Calendar OAuth not configured.");

    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
}

// ── Save Tokens for User ──────────────────────────────────────────────
function saveTokens(userId, tokens) {
    const existing = stmts.gcalTokenByUser.get(userId);
    if (existing) {
        stmts.gcalTokenUpdate.run({
            user_id: userId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || existing.refresh_token,
            expiry_date: tokens.expiry_date || null,
        });
    } else {
        stmts.gcalTokenInsert.run({
            user_id: userId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expiry_date: tokens.expiry_date || null,
        });
    }
    console.log(`📅 Google Calendar tokens saved for user: ${userId}`);
}

// ── Get Authenticated Client for User ──────────────────────────────────
function getAuthenticatedClient(userId) {
    const row = stmts.gcalTokenByUser.get(userId);
    if (!row) return null;

    const oauth2Client = getOAuth2Client();
    if (!oauth2Client) return null;

    oauth2Client.setCredentials({
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expiry_date: row.expiry_date ? parseInt(row.expiry_date, 10) : undefined,
    });

    // Auto-refresh: listen for new tokens
    oauth2Client.on("tokens", (newTokens) => {
        saveTokens(userId, {
            access_token: newTokens.access_token,
            refresh_token: newTokens.refresh_token || row.refresh_token,
            expiry_date: newTokens.expiry_date,
        });
    });

    return oauth2Client;
}

// ── Check if User Has Calendar Connected ───────────────────────────────
function isCalendarConnected(userId) {
    const row = stmts.gcalTokenByUser.get(userId);
    return !!row;
}

// ── Disconnect Calendar ────────────────────────────────────────────────
function disconnectCalendar(userId) {
    stmts.gcalTokenDelete.run(userId);
    console.log(`📅 Google Calendar disconnected for user: ${userId}`);
}

// ── Get Calendar Events ────────────────────────────────────────────────
async function getEvents(userId, timeMin, timeMax) {
    const auth = getAuthenticatedClient(userId);
    if (!auth) throw new Error("Google Calendar not connected.");

    const calendar = google.calendar({ version: "v3", auth });

    const now = new Date();
    const defaultMin = timeMin || now.toISOString();
    const defaultMax = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: defaultMin,
        timeMax: defaultMax,
        maxResults: 50,
        singleEvents: true,
        orderBy: "startTime",
    });

    return (res.data.items || []).map((e) => ({
        id: e.id,
        summary: e.summary || "(No title)",
        description: e.description || "",
        start: e.start?.dateTime || e.start?.date || "",
        end: e.end?.dateTime || e.end?.date || "",
        location: e.location || "",
        status: e.status || "confirmed",
        htmlLink: e.htmlLink || "",
    }));
}

// ── Create Calendar Event ──────────────────────────────────────────────
async function createEvent(userId, { summary, description, startDateTime, endDateTime, location }) {
    const auth = getAuthenticatedClient(userId);
    if (!auth) throw new Error("Google Calendar not connected.");

    const calendar = google.calendar({ version: "v3", auth });

    const event = {
        summary,
        description: description || "",
        location: location || "",
        start: { dateTime: startDateTime, timeZone: "UTC" },
        end: { dateTime: endDateTime, timeZone: "UTC" },
        reminders: {
            useDefault: false,
            overrides: [
                { method: "popup", minutes: 30 },
            ],
        },
    };

    const res = await calendar.events.insert({
        calendarId: "primary",
        resource: event,
    });

    console.log(`📅 Calendar event created: ${res.data.id} — ${summary}`);
    return {
        id: res.data.id,
        summary: res.data.summary,
        start: res.data.start?.dateTime || res.data.start?.date,
        end: res.data.end?.dateTime || res.data.end?.date,
        htmlLink: res.data.htmlLink,
    };
}

// ── Check Availability (for Agent) ─────────────────────────────────────
async function checkAvailability(userId, date, startHour = 9, endHour = 18) {
    const auth = getAuthenticatedClient(userId);
    if (!auth) return { available: false, message: "Google Calendar not connected." };

    const calendar = google.calendar({ version: "v3", auth });

    const dayStart = new Date(date + "T00:00:00Z");
    const dayEnd = new Date(date + "T23:59:59Z");

    const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
    });

    const events = res.data.items || [];

    // Build busy slots
    const busySlots = events
        .filter((e) => e.start?.dateTime && e.end?.dateTime)
        .map((e) => ({
            start: new Date(e.start.dateTime),
            end: new Date(e.end.dateTime),
            summary: e.summary || "(busy)",
        }));

    // Build available 30-min slots between working hours
    const availableSlots = [];
    for (let hour = startHour; hour < endHour; hour++) {
        for (let min = 0; min < 60; min += 30) {
            const slotStart = new Date(date + "T00:00:00Z");
            slotStart.setUTCHours(hour, min, 0, 0);
            const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);

            const isBusy = busySlots.some(
                (b) => slotStart < b.end && slotEnd > b.start
            );

            if (!isBusy) {
                availableSlots.push({
                    start: slotStart.toISOString(),
                    end: slotEnd.toISOString(),
                    label: `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")} - ${String(slotEnd.getUTCHours()).padStart(2, "0")}:${String(slotEnd.getUTCMinutes()).padStart(2, "0")}`,
                });
            }
        }
    }

    return {
        date,
        totalEvents: events.length,
        busySlots: busySlots.map((b) => ({
            start: b.start.toISOString(),
            end: b.end.toISOString(),
            summary: b.summary,
        })),
        availableSlots,
        hasAvailability: availableSlots.length > 0,
    };
}

// ── Is Configured ──────────────────────────────────────────────────────
function isConfigured() {
    return !!(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET);
}

module.exports = {
    getAuthUrl,
    exchangeCode,
    saveTokens,
    getEvents,
    createEvent,
    checkAvailability,
    isCalendarConnected,
    disconnectCalendar,
    isConfigured,
};
