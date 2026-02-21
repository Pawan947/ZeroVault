const express = require("express");
const router = express.Router();
const { ref, get, update } = require("firebase/database");
const { db } = require("../config/firebase");
const { s3, BUCKET } = require("../config/aws");
const { haversineDistance } = require("../utils/geo");
const { getCryptoStream } = require("../utils/cryptoHelpers");

router.get("/share/:linkId", async (req, res) => {
    try {
        const linkId = req.params.linkId;
        if (!req.query.lat || !req.query.lng) {
            return res.render("download", { linkId });
        }

        const snap = await get(ref(db, "links/" + linkId));
        if (!snap.exists()) return res.status(404).send("Invalid link");

        const linkData = snap.val();
        const now = Math.floor(Date.now() / 1000);
        if (now > linkData.expiryTime) return res.status(410).send("Link expired");

        const { lat: currLat, lng: currLng } = req.query;
        if (linkData.geofence) {
            const distance = haversineDistance(
                { lat: parseFloat(currLat), lng: parseFloat(currLng) },
                { lat: linkData.geofence.latitude, lng: linkData.geofence.longitude }
            );
            if (distance > linkData.geofence.radiusKm) {
                return res.status(403).send(`Access denied: outside ${linkData.geofence.radiusKm} km radius`);
            }
        }

        const clientIp = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
        const ipDownloads = linkData.ipDownloads || {};
        const currentIpCount = ipDownloads[clientIp] || 0;

        if (currentIpCount >= linkData.perIpLimit) return res.status(403).send(`IP download limit reached`);
        if (linkData.downloadsUsed >= linkData.maxDownloads) return res.status(403).send("Total download limit reached");

        const filename = linkData.filePath.split("/").pop();
        const extension = filename.split(".").pop().toLowerCase();

        if (extension === "mp4" || extension === "webm") {
            const head = await s3.headObject({ Bucket: BUCKET, Key: linkData.filePath }).promise();
            const total = head.ContentLength;
            const range = req.headers.range;
            const isEncrypted = head.Metadata && head.Metadata.encrypted === "true";

            if (!range) {
                res.writeHead(200, { "Content-Length": total, "Content-Type": "video/" + extension });
                const s3Stream = s3.getObject({ Bucket: BUCKET, Key: linkData.filePath }).createReadStream();
                if (isEncrypted) s3Stream.pipe(getCryptoStream(linkData.filePath, 0)).pipe(res);
                else s3Stream.pipe(res);
            } else {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
                res.writeHead(206, {
                    "Content-Range": `bytes ${start}-${end}/${total}`,
                    "Accept-Ranges": "bytes",
                    "Content-Length": (end - start + 1),
                    "Content-Type": "video/" + extension,
                });
                const s3Stream = s3.getObject({ Bucket: BUCKET, Key: linkData.filePath, Range: `bytes=${start}-${end}` }).createReadStream();
                if (isEncrypted) s3Stream.pipe(getCryptoStream(linkData.filePath, start)).pipe(res);
                else s3Stream.pipe(res);
            }
        } else {
            const head = await s3.headObject({ Bucket: BUCKET, Key: linkData.filePath }).promise();
            const isEncrypted = head.Metadata && head.Metadata.encrypted === "true";

            res.attachment(filename);
            const s3Stream = s3.getObject({ Bucket: BUCKET, Key: linkData.filePath }).createReadStream();
            if (isEncrypted) s3Stream.pipe(getCryptoStream(linkData.filePath, 0)).pipe(res);
            else s3Stream.pipe(res);
        }

        await update(ref(db, "links/" + linkId), {
            downloadsUsed: (linkData.downloadsUsed || 0) + 1,
            ipDownloads: { ...ipDownloads, [clientIp]: currentIpCount + 1 }
        });
    } catch (err) {
        console.error("Shared Link Access Error:", err);
        res.status(500).send("Failed to access shared file");
    }
});

module.exports = router;
