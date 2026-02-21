const { ref, get, set } = require("firebase/database");
const { db } = require("../config/firebase");
const { haversineDistance } = require("../utils/geo");

function requireLogin(req, res, next) {
    if (!req.session.user) return res.redirect("/login");
    next();
}

async function checkSharedAccess(req, res, next) {
    const sharedId = req.query.sharedId;
    if (!sharedId) return next();

    try {
        const snap = await get(ref(db, "Access/" + sharedId));
        if (!snap.exists()) return res.status(404).send("Invalid shared access");

        const entry = snap.val();
        const now = Math.floor(Date.now() / 1000);

        if (entry.accessTo !== req.session.user.email)
            return res.status(403).send("Not authorized");

        if (entry.expiryTime <= now) {
            await set(ref(db, "Access/" + sharedId), null);
            return res.status(410).send("Shared access expired");
        }

        // Geofence check
        const { lat: currLat, lng: currLng } = req.query;
        if (entry.geofence && currLat && currLng) {
            const distance = haversineDistance(
                { lat: parseFloat(currLat), lng: parseFloat(currLng) },
                { lat: entry.geofence.latitude, lng: entry.geofence.longitude }
            );
            if (distance > entry.geofence.radiusKm) {
                return res.status(403).send(`Access denied: outside ${entry.geofence.radiusKm} km radius`);
            }
        }

        req.sharedEntry = entry;
        next();
    } catch (err) {
        console.error("Shared Access Error:", err);
        res.status(500).send("Internal Server Error during access check");
    }
}

module.exports = { requireLogin, checkSharedAccess };
