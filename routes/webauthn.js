const express = require("express");
const router = express.Router();
const { ref, get, push, update, increment } = require("firebase/database");
const { db } = require("../config/firebase");
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require("@simplewebauthn/server");
const base64url = require("base64url");
const { rpName, rpID, origin } = require("../config/webauthn");
const { requireLogin } = require("../middleware/auth");

// 1. Generate Registration Options
router.get("/register-options", requireLogin, async (req, res) => {
    try {
        const user = req.session.user;
        const userAuthenticatorsRef = ref(db, `users/${user.uid}/authenticators`);
        const snapshot = await get(userAuthenticatorsRef);
        const userAuthenticators = snapshot.val() ? Object.values(snapshot.val()) : [];

        const opts = {
            rpName,
            rpID,
            userID: new Uint8Array(Buffer.from(user.uid)),
            userName: user.email,
            timeout: 60000,
            attestationType: "none",
            excludeCredentials: userAuthenticators.map(auth => ({
                id: auth.credentialID,
                type: "public-key",
                transports: auth.transports,
            })),
            authenticatorSelection: {
                residentKey: "required",
                userVerification: "required",
                authenticatorAttachment: "platform",
            },
        };

        const options = await generateRegistrationOptions(opts);
        req.session.currentChallenge = options.challenge;
        res.json(options);
    } catch (err) {
        console.error("WebAuthn Registration Options Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify Registration
router.post("/register-verify", requireLogin, async (req, res) => {
    try {
        const { body } = req;
        const user = req.session.user;
        const expectedChallenge = req.session.currentChallenge;

        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: body,
                expectedChallenge,
                expectedOrigin: origin,
                expectedRPID: rpID,
            });
        } catch (error) {
            console.error(error);
            return res.status(400).json({ error: error.message });
        }

        const { verified, registrationInfo } = verification;

        if (verified && registrationInfo) {
            const { credential } = registrationInfo;
            const { id: credentialID, publicKey: credentialPublicKey, counter, transports } = credential;

            const newAuthenticator = {
                credentialID: credentialID,
                credentialPublicKey: base64url.encode(Buffer.from(credentialPublicKey)),
                counter,
                transports: transports || body.response.transports || [],
            };

            await push(ref(db, `users/${user.uid}/authenticators`), newAuthenticator);
            await update(ref(db, `users/${user.uid}`), { email: user.email });

            req.session.currentChallenge = undefined;
            res.json({ verified: true });
        } else {
            res.status(400).json({ verified: false });
        }
    } catch (err) {
        console.error("WebAuthn Registration Verify Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Generate Authentication Options
router.get("/login-options", async (req, res) => {
    try {
        const opts = {
            timeout: 60000,
            userVerification: "preferred",
            rpID,
        };

        const uid = req.session.partialLogin?.uid || req.session.user?.uid;
        if (uid) {
            const snapshot = await get(ref(db, `users/${uid}/authenticators`));
            if (snapshot.exists()) {
                const authenticators = Object.values(snapshot.val());
                opts.allowCredentials = authenticators.map(auth => ({
                    id: auth.credentialID,
                    type: "public-key",
                    transports: auth.transports || [],
                }));
            }
        }

        const options = await generateAuthenticationOptions(opts);
        req.session.currentChallenge = options.challenge;
        req.session.save((err) => {
            if (err) console.error("Session save error in options:", err);
            res.json(options);
        });
    } catch (err) {
        console.error("WebAuthn Login Options Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 4. Verify Authentication
router.post("/login-verify", async (req, res) => {
    try {
        const { body } = req;
        const expectedChallenge = req.session.currentChallenge;
        const credentialID = body.id;

        let foundAuth = null;
        let foundUid = null;
        let foundAuthKey = null;

        if (req.session.partialLogin) {
            foundUid = req.session.partialLogin.uid;
            const authSnap = await get(ref(db, `users/${foundUid}/authenticators`));
            if (authSnap.exists()) {
                Object.entries(authSnap.val()).forEach(([key, a]) => {
                    if (a.credentialID === credentialID) {
                        foundAuth = a;
                        foundAuthKey = key;
                    }
                });
            }
        } else {
            const usersSnap = await get(ref(db, "users"));
            if (usersSnap.exists()) {
                usersSnap.forEach(uSnap => {
                    const auths = uSnap.val().authenticators;
                    if (auths) {
                        Object.entries(auths).forEach(([key, a]) => {
                            if (a.credentialID === credentialID) {
                                foundAuth = a;
                                foundUid = uSnap.key;
                                foundAuthKey = key;
                            }
                        });
                    }
                });
            }
        }

        if (!foundAuth || !foundUid) {
            return res.status(400).json({ error: "Authenticator not found" });
        }

        const userRef = ref(db, `users/${foundUid}`);
        const userSnap = await get(userRef);
        const userData = userSnap.val();
        const userEmail = userData?.email || req.session.partialLogin?.email;

        if (!userEmail) {
            return res.status(400).json({ error: "User email not found." });
        }

        const opts = {
            response: body,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            credential: {
                id: foundAuth.credentialID,
                publicKey: base64url.toBuffer(foundAuth.credentialPublicKey),
                counter: foundAuth.counter,
                transports: foundAuth.transports,
            },
        };

        const verification = await verifyAuthenticationResponse(opts);
        const { verified, authenticationInfo } = verification;

        if (verified) {
            const { newCounter } = authenticationInfo;
            if (foundAuthKey) {
                await update(ref(db, `users/${foundUid}/authenticators/${foundAuthKey}`), { counter: newCounter });
            }

            req.session.user = {
                uid: foundUid,
                email: userEmail,
                lat: req.session.partialLogin?.lat,
                lng: req.session.partialLogin?.lng
            };
            req.session.currentChallenge = undefined;
            req.session.partialLogin = undefined;

            await update(ref(db, `users/${foundUid}`), {
                lastLoginLocation: { lat: req.session.user.lat || null, lng: req.session.user.lng || null },
                loginCount: increment(1),
                lastLoginAt: Math.floor(Date.now() / 1000)
            });

            req.session.save((err) => {
                if (err) return res.status(500).json({ error: "Failed to save session" });
                res.json({ verified: true });
            });
        } else {
            res.status(400).json({ verified: false });
        }
    } catch (err) {
        console.error("WebAuthn Login Verify Error:", err);
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
