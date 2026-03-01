require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- Middleware -------------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// CORS and Security Headers
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Cross-Origin-Opener-Policy", "unsafe-none");
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

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
