// ─── Auth Store ────────────────────────────────────────────────────────
// In-memory user store & session management (no external deps).
// For production: replace with a proper DB + bcrypt + JWT/express-session.

const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleOAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ── Users ──────────────────────────────────────────────────────────────
const users = []; // { id, email, passwordHash, name, createdAt }

// ── Sessions ───────────────────────────────────────────────────────────
const sessions = {}; // token → { userId, expiresAt }

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
    if (users.find(u => u.email === emailLower)) {
        return { ok: false, error: "Bu e-posta zaten kayıtlı." };
    }
    if (!password || password.length < 6) {
        return { ok: false, error: "Şifre en az 6 karakter olmalıdır." };
    }
    const user = {
        id: generateUserId(),
        email: emailLower,
        name: name?.trim() || emailLower.split("@")[0],
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
    };
    users.push(user);
    console.log(`👤 User registered: ${user.name} (${user.email})`);
    return { ok: true, user: safeUser(user) };
}

function loginUser({ email, password }) {
    const emailLower = email.toLowerCase().trim();
    const user = users.find(u => u.email === emailLower);
    if (!user) return { ok: false, error: "E-posta veya şifre hatalı." };
    if (user.passwordHash !== hashPassword(password)) {
        return { ok: false, error: "E-posta veya şifre hatalı." };
    }
    const token = generateToken();
    sessions[token] = {
        userId: user.id,
        expiresAt: Date.now() + SESSION_TTL_MS,
    };
    console.log(`🔑 User logged in: ${user.name} (${user.id})`);
    return { ok: true, token, user: safeUser(user) };
}

function getUserByToken(token) {
    if (!token) return null;
    const session = sessions[token];
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        delete sessions[token];
        return null;
    }
    return users.find(u => u.id === session.userId) || null;
}

function logoutToken(token) {
    delete sessions[token];
}

function safeUser(user) {
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

    // Find existing user or create new one
    let user = users.find(u => u.email === emailLower);
    if (!user) {
        user = {
            id: generateUserId(),
            email: emailLower,
            name: payload.name || emailLower.split("@")[0],
            passwordHash: null,
            googleId: payload.sub,
            picture: payload.picture || null,
            createdAt: new Date().toISOString(),
        };
        users.push(user);
        console.log(`👤 Google user registered: ${user.name} (${user.email})`);
    } else if (!user.googleId) {
        // Link Google to existing account
        user.googleId = payload.sub;
        user.picture = payload.picture || user.picture || null;
        console.log(`🔗 Google linked to existing account: ${user.email}`);
    }

    const token = generateToken();
    sessions[token] = {
        userId: user.id,
        expiresAt: Date.now() + SESSION_TTL_MS,
    };
    console.log(`🔑 Google user logged in: ${user.name} (${user.id})`);
    return { ok: true, token, user: safeUser(user) };
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
    // Check Authorization header: "Bearer <token>"
    const auth = req.headers["authorization"];
    if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
    // Check cookie: va_token=<token>
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
