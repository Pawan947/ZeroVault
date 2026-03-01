require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const session = require("cookie-session");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- Middleware -------------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", 1);
app.use(session({
    name: 'session',
    keys: [process.env.SESSION_SECRET || "supersecret"],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === "production",
    httpOnly: true
}));

app.use((req, res, next) => {
    // Mock save function for express-session compatibility
    if (req.session && !req.session.save) {
        req.session.save = (cb) => { if (cb) cb(); };
    }
    next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// CORS and Security Headers
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.header("Cross-Origin-Embedder-Policy", "unsafe-none");
    if (req.method === "OPTIONS") return res.status(200).end();
    next();
});

// ---------------- Routes ----------------
const authRoutes = require("./routes/auth");
const storageRoutes = require("./routes/storage");
const webauthnRoutes = require("./routes/webauthn");
const publicRoutes = require("./routes/public");

app.use("/", authRoutes);
app.use("/", storageRoutes);
app.use("/", publicRoutes);
app.use("/api/webauthn", webauthnRoutes);

// Error Handling (Basic)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send("Something went wrong!");
});

if (process.env.NODE_ENV !== "production" || process.env.VERCEL !== "1") {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
