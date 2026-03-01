const express = require("express");
const router = express.Router();
const { signInWithEmailAndPassword, createUserWithEmailAndPassword } = require("firebase/auth");
const { ref, get, update, increment } = require("firebase/database");
const { auth, db } = require("../config/firebase");

router.get("/login", (req, res) => res.render("login", {
    error: null,
    firebaseConfig: {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN
    }
}));

router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        const userAuthenticatorsRef = ref(db, `users/${user.uid}/authenticators`);
        const snapshot = await get(userAuthenticatorsRef);
        const hasAuthenticators = snapshot.exists() && snapshot.size > 0;

        if (hasAuthenticators) {
            req.session.partialLogin = {
                uid: user.uid,
                email: user.email,
                lat: req.body.lat,
                lng: req.body.lng
            };
            req.session.save(() => {
                if (req.headers.accept && req.headers.accept.includes("application/json")) {
                    return res.json({ mfaRequired: true, email: user.email });
                }
                res.render("mfa", { email: user.email });
            });
        } else {
            req.session.user = {
                uid: user.uid,
                email: user.email,
                lat: req.body.lat,
                lng: req.body.lng
            };

            // Update counter and location on successful login
            await update(ref(db, `users/${user.uid}`), {
                lastLoginLocation: { lat: req.body.lat || null, lng: req.body.lng || null },
                loginCount: increment(1),
                lastLoginAt: Math.floor(Date.now() / 1000)
            });

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

router.get("/register", (req, res) => res.render("register", {
    error: null,
    firebaseConfig: {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN
    }
}));

router.post("/register", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email.toLowerCase().endsWith("@gmail.com")) {
            const errorMessage = "Only @gmail.com addresses are allowed to register.";
            if (req.headers.accept && req.headers.accept.includes("application/json")) {
                return res.status(400).json({ error: errorMessage });
            }
            return res.render("register", {
                error: errorMessage,
                firebaseConfig: {
                    apiKey: process.env.FIREBASE_API_KEY,
                    authDomain: process.env.FIREBASE_AUTH_DOMAIN
                }
            });
        }

        const emailValidator = require('deep-email-validator');
        const validationResult = await emailValidator.validate(email);

        if (!validationResult.valid) {
            const errorMessage = "Email verification failed: This email address does not appear to exist or be active.";
            if (req.headers.accept && req.headers.accept.includes("application/json")) {
                return res.status(400).json({ error: errorMessage });
            }
            return res.render("register", {
                error: errorMessage,
                firebaseConfig: {
                    apiKey: process.env.FIREBASE_API_KEY,
                    authDomain: process.env.FIREBASE_AUTH_DOMAIN
                }
            });
        }

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

router.post("/auth/google", async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) return res.status(400).json({ error: "Missing ID Token" });

        const https = require('https');

        const verifyIdToken = (token) => {
            return new Promise((resolve, reject) => {
                const data = JSON.stringify({ idToken: token });
                const options = {
                    hostname: 'identitytoolkit.googleapis.com',
                    path: `/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': data.length
                    }
                };

                const request = https.request(options, (response) => {
                    let body = '';
                    response.on('data', d => body += d);
                    response.on('end', () => resolve(JSON.parse(body)));
                });

                request.on('error', reject);
                request.write(data);
                request.end();
            });
        };

        const verifyData = await verifyIdToken(idToken);

        if (verifyData.error) {
            throw new Error(verifyData.error.message);
        }

        const user = verifyData.users[0];
        const uid = user.localId;
        const email = user.email;

        if (req.body.isRegister && !email.toLowerCase().endsWith("@gmail.com")) {
            return res.status(400).json({ error: "Only @gmail.com addresses are allowed to register." });
        }

        // Same MFA logic as regular login
        const userAuthenticatorsRef = ref(db, `users/${uid}/authenticators`);
        const snapshot = await get(userAuthenticatorsRef);
        const hasAuthenticators = snapshot.exists() && snapshot.size > 0;

        if (req.body.isRegister && !hasAuthenticators) {
            // Act like regular registration response
            req.session.user = { uid, email, lat: req.body.lat, lng: req.body.lng };
            req.session.save(() => res.json({ success: true, newRegistration: true }));
        } else if (hasAuthenticators) {
            req.session.partialLogin = { uid, email };
            req.session.save(() => res.json({ mfaRequired: true, email }));
        } else {
            req.session.user = { uid, email, lat: req.body.lat, lng: req.body.lng };

            // Update counter and location on successful Google login
            await update(ref(db, `users/${uid}`), {
                lastLoginLocation: { lat: req.body.lat || null, lng: req.body.lng || null },
                loginCount: increment(1),
                lastLoginAt: Math.floor(Date.now() / 1000)
            });

            req.session.save(() => res.json({ success: true }));
        }
    } catch (err) {
        console.error("Google Auth Error:", err);
        res.status(401).json({ error: "Google Authentication failed: " + err.message });
    }
});

module.exports = router;
