const express = require("express");
const router = express.Router();
const { signInWithEmailAndPassword, createUserWithEmailAndPassword } = require("firebase/auth");
const { ref, get } = require("firebase/database");
const { auth, db } = require("../config/firebase");

router.get("/login", (req, res) => res.render("login", { error: null }));

router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        const userAuthenticatorsRef = ref(db, `users/${user.uid}/authenticators`);
        const snapshot = await get(userAuthenticatorsRef);
        const hasAuthenticators = snapshot.exists() && snapshot.size > 0;

        if (hasAuthenticators) {
            req.session.partialLogin = { uid: user.uid, email: user.email };
            req.session.save(() => {
                if (req.headers.accept && req.headers.accept.includes("application/json")) {
                    return res.json({ mfaRequired: true, email: user.email });
                }
                res.render("mfa", { email: user.email });
            });
        } else {
            req.session.user = { uid: user.uid, email: user.email };
            req.session.save(() => {
                if (req.headers.accept && req.headers.accept.includes("application/json")) {
                    return res.json({ success: true });
                }
                res.redirect("/");
            });
        }
    } catch (err) {
        console.error("Login Error:", err);
        const errorMessage = err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password'
            ? "Invalid credentials"
            : "Authentication failed";
        if (req.headers.accept && req.headers.accept.includes("application/json")) {
            return res.status(401).json({ error: errorMessage });
        }
        res.render("login", { error: errorMessage });
    }
});

router.get("/register", (req, res) => res.render("register", { error: null }));

router.post("/register", async (req, res) => {
    try {
        const { email, password } = req.body;
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        req.session.user = { uid: user.uid, email: user.email };
        req.session.save(() => {
            if (req.headers.accept && req.headers.accept.includes("application/json")) {
                return res.json({ success: true });
            }
            res.redirect("/");
        });
    } catch (err) {
        console.error("Registration Error:", err);
        let errorMessage = "Registration failed";
        if (err.code === 'auth/email-already-in-use') errorMessage = "Email already in use";
        if (err.code === 'auth/weak-password') errorMessage = "Password is too weak";

        if (req.headers.accept && req.headers.accept.includes("application/json")) {
            return res.status(400).json({ error: errorMessage });
        }
        res.render("register", { error: errorMessage });
    }
});

router.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

module.exports = router;
