// ─── Auth Store (SQLite-backed) ────────────────────────────────────────
// Users and sessions are now persisted in SQLite via db.js.

const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { stmts, rowToUser } = require("./db");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleOAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Helpers ────────────────────────────────────────────────────────────
function hashPassword(password) {
    return crypto.createHash("sha256").update(password + "voiceagent_salt").digest("hex");
}

function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

function generateUserId() {
    return "user_" + crypto.randomBytes(6).toString("hex");
}

// ── Public API ─────────────────────────────────────────────────────────
function registerUser({ email, password, name }) {
    const emailLower = email.toLowerCase().trim();

    if (stmts.userByEmail.get(emailLower)) {
        return { ok: false, error: "Bu e-posta zaten kayıtlı." };
    }
    if (!password || password.length < 6) {
        return { ok: false, error: "Şifre en az 6 karakter olmalıdır." };
    }

    const user = {
        id: generateUserId(),
        email: emailLower,
        name: (name?.trim() || emailLower.split("@")[0]),
        password_hash: hashPassword(password),
        google_id: null,
        picture: null,
        created_at: new Date().toISOString(),
    };

    stmts.userInsert.run(user);
    console.log(`👤 User registered: ${user.name} (${user.email})`);
    return { ok: true, user: safeUser(rowToUser(user)) };
}

function loginUser({ email, password }) {
    const emailLower = email.toLowerCase().trim();
    const row = stmts.userByEmail.get(emailLower);
    if (!row) return { ok: false, error: "E-posta veya şifre hatalı." };
    if (row.password_hash !== hashPassword(password)) {
        return { ok: false, error: "E-posta veya şifre hatalı." };
    }

    const token = generateToken();
    stmts.sessionInsert.run(token, row.id, Date.now() + SESSION_TTL_MS);

    console.log(`🔑 User logged in: ${row.name} (${row.id})`);
    return { ok: true, token, user: safeUser(rowToUser(row)) };
}

function getUserByToken(token) {
    if (!token) return null;

    const session = stmts.sessionByToken.get(token);
    if (!session) return null;
    if (Date.now() > session.expires_at) {
        stmts.sessionDelete.run(token);
        return null;
    }

    const row = stmts.userById.get(session.user_id);
    return row ? rowToUser(row) : null;
}

function logoutToken(token) {
    stmts.sessionDelete.run(token);
}

function safeUser(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
}

// ── Google OAuth ───────────────────────────────────────────────────────
async function loginOrRegisterGoogleUser(idToken) {
    if (!googleOAuthClient) {
        return { ok: false, error: "Google OAuth yapılandırılmamış. GOOGLE_CLIENT_ID .env dosyasına ekleyin." };
    }

    let payload;
    try {
        const ticket = await googleOAuthClient.verifyIdToken({
            idToken,
            audience: GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
    } catch (e) {
        return { ok: false, error: "Google token doğrulanamadı: " + e.message };
    }

    const emailLower = (payload.email || "").toLowerCase().trim();
    if (!emailLower) return { ok: false, error: "Google hesabında e-posta bulunamadı." };

    let row = stmts.userByEmail.get(emailLower);

    if (!row) {
        // New Google user — register
        const newUser = {
            id: generateUserId(),
            email: emailLower,
            name: payload.name || emailLower.split("@")[0],
            password_hash: null,
            google_id: payload.sub,
            picture: payload.picture || null,
            created_at: new Date().toISOString(),
        };
        stmts.userInsert.run(newUser);
        row = stmts.userByEmail.get(emailLower);
        console.log(`👤 Google user registered: ${newUser.name} (${newUser.email})`);
    } else if (!row.google_id) {
        // Link Google to existing email account
        stmts.userLinkGoogle.run(payload.sub, payload.picture || null, row.id);
        row = stmts.userById.get(row.id); // re-fetch updated row
        console.log(`🔗 Google linked to existing account: ${row.email}`);
    }

    const token = generateToken();
    stmts.sessionInsert.run(token, row.id, Date.now() + SESSION_TTL_MS);

    console.log(`🔑 Google user logged in: ${row.name} (${row.id})`);
    return { ok: true, token, user: safeUser(rowToUser(row)) };
}

// ── Auth Middleware ────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    const token = extractToken(req);
    const user = getUserByToken(token);
    if (!user) {
        return res.status(401).json({ error: "Oturum açmanız gerekiyor." });
    }
    req.currentUser = user;
    req.authToken = token;
    next();
}

function extractToken(req) {
    const auth = req.headers["authorization"];
    if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
    const cookieHeader = req.headers["cookie"] || "";
    const match = cookieHeader.match(/(?:^|;\s*)va_token=([^;]+)/);
    if (match) return match[1];
    return null;
}

module.exports = {
    registerUser,
    loginUser,
    loginOrRegisterGoogleUser,
    getUserByToken,
    logoutToken,
    safeUser,
    requireAuth,
    extractToken,
    GOOGLE_CLIENT_ID,
};
