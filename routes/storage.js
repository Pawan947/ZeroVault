const express = require("express");
const router = express.Router();
const { ref, set, push, get, update } = require("firebase/database");
const { db } = require("../config/firebase");
const { s3, BUCKET } = require("../config/aws");
const { ensureFolderExists, listFilesAndFolders } = require("../utils/s3Helpers");
const { getUserBaseFolder, getCurrentPath, parseExpiry } = require("../utils/appHelpers");
const { requireLogin, checkSharedAccess } = require("../middleware/auth");
const { universalApiKey } = require("../config/webauthn");
const { getCryptoStream } = require("../utils/cryptoHelpers");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// ---------------- File Browser ----------------
router.get("/", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        let prefix = req.sharedEntry ? req.sharedEntry.folderPath + (req.query.path || "") : getCurrentPath(req);
        await ensureFolderExists(prefix);

        const { files, folders } = await listFilesAndFolders(prefix);

        let combinedFolders = folders.map(f => ({ name: f, isShared: false }));

        if (!req.sharedEntry) {
            const sharedSnapshot = await get(ref(db, "Access"));
            if (sharedSnapshot.exists()) {
                const now = Math.floor(Date.now() / 1000);
                for (const [key, entry] of Object.entries(sharedSnapshot.val())) {
                    if (entry.expiryTime <= now) {
                        // Lazy cleanup
                        set(ref(db, `Access/${key}`), null).catch(console.error);
                        continue;
                    }
                    if (entry.accessTo === req.session.user.email) {
                        combinedFolders.push({
                            shareId: key,
                            folderPath: entry.folderPath,
                            owner: entry.owner,
                            permissions: entry.permissions,
                            isShared: true,
                            name: entry.folderPath.split("/").filter(Boolean).pop() || "Shared Folder",
                        });
                    }
                }
            }
        }

        res.render("index", {
            files,
            folders: combinedFolders,
            currentPath: req.query.path || "",
            userEmail: req.session.user.email,
            sharedId: req.query.sharedId || "",
            firebaseConfig: {
                apiKey: process.env.FIREBASE_API_KEY,
                authDomain: process.env.FIREBASE_AUTH_DOMAIN,
                databaseURL: process.env.FIREBASE_DATABASE_URL,
                projectId: process.env.FIREBASE_PROJECT_ID
            }
        });
    } catch (err) {
        console.error("List Files Error:", err);
        res.status(500).send("Failed to list folders/files");
    }
});

router.post("/upload/multipart/create", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        const { fileName, contentType, fileSize } = req.body;
        if (!fileName || !fileSize) return res.status(400).json({ error: "Missing parameters" });
        if (fileSize > 50 * 1024 * 1024 * 1024) return res.status(400).json({ error: "File too large (Max 50GB)" });

        const folderPath = req.sharedEntry ? req.sharedEntry.folderPath + (req.query.path || "") : getCurrentPath(req);
        if (req.sharedEntry && !req.sharedEntry.permissions.upload) return res.status(403).send("No upload permission");

        const sanitizedName = fileName.replace(/\.{2}/g, "");
        const key = folderPath + sanitizedName;

        const multipartUpload = await s3.createMultipartUpload({
            Bucket: BUCKET,
            Key: key,
            ContentType: contentType || "application/octet-stream",
            Metadata: { encrypted: "true", mode: "AES-256-CTR", version: "2" }
        }).promise();

        const CHUNK_SIZE = 10 * 1024 * 1024;
        const parts = Math.ceil(fileSize / CHUNK_SIZE);
        if (parts > 10000) return res.status(400).json({ error: "Too many parts required." });

        const preSignedUrls = [];
        for (let i = 1; i <= parts; i++) {
            const url = s3.getSignedUrl('uploadPart', {
                Bucket: BUCKET,
                Key: key,
                PartNumber: i,
                UploadId: multipartUpload.UploadId,
                Expires: 3600 // 1 hour per part
            });
            preSignedUrls.push(url);
        }

        const { getFileKey } = require("../utils/cryptoHelpers");
        const fileKeyHex = getFileKey(key).toString('hex');

        res.json({ uploadId: multipartUpload.UploadId, key, preSignedUrls, fileKeyHex });
    } catch (err) {
        console.error("Create Multipart Error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/upload/multipart/complete", requireLogin, async (req, res) => {
    try {
        const { key, uploadId, parts, hmac } = req.body;
        if (!key || !uploadId || !parts) return res.status(400).json({ error: "Missing parameters" });

        await s3.completeMultipartUpload({
            Bucket: BUCKET,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts } // Array of {ETag, PartNumber}
        }).promise();

        // Save HMAC array signature for streaming validation later
        const filename = key.split("/").pop();
        await set(ref(db, "signatures/" + Buffer.from(key).toString('base64')), {
            hmacSha256: hmac,
            createdAt: Math.floor(Date.now() / 1000)
        });

        res.json({ success: true });
    } catch (err) {
        console.error("Complete Multipart Error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/upload/complete", requireLogin, async (req, res) => {
    try {
        const { key } = req.body;
        console.log(`[Upload] Complete - Key: ${key}, Path: ${req.query.path}, SharedId: ${req.query.sharedId}`);
        if (!key) return res.status(400).json({ error: "Key missing" });

        const videoId = key.split("/").pop().split(".")[0];
        const location = [getUserBaseFolder(req), key].map(p => p.replace(/^\/+|\/+$/g, "")).join("/");

        await set(ref(db, "hlsQueue/" + videoId), {
            videoId,
            status: "pending",
            location,
            createdAt: Math.floor(Date.now() / 1000),
        });

        res.json({ success: true });
    } catch (err) {
        console.error("Upload Complete Error:", err);
        res.json({ success: false, error: err.message });
    }
});

// ---------------- Create Folder ----------------
router.post("/folder/create", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        const folderName = req.body.folderName.replace(/\.\./g, "");
        if (!folderName) return res.status(400).send("Folder name required");

        const folderPath = (req.sharedEntry ? req.sharedEntry.folderPath : getCurrentPath(req)) + folderName + "/";
        if (req.sharedEntry && !req.sharedEntry.permissions.upload) return res.status(403).send("No permission");

        await ensureFolderExists(folderPath);
        res.sendStatus(200);
    } catch (err) {
        console.error("Create Folder Error:", err);
        res.status(500).send("Failed to create folder");
    }
});

// ---------------- Move ----------------
router.get("/api/all-folders", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        const baseFolder = req.sharedEntry ? req.sharedEntry.folderPath : getUserBaseFolder(req);
        const list = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: baseFolder }).promise();
        const folders = list.Contents.filter(o => o.Key.endsWith('/')).map(o => o.Key.replace(baseFolder, ""));
        res.json({ folders: ["", ...folders.filter(f => f !== "")] });
    } catch (err) {
        console.error("List All Folders Error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/move", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        const { filename, destinationPath } = req.body;
        if (!filename) return res.status(400).json({ error: "Missing filename" });
        if (destinationPath === undefined) return res.status(400).json({ error: "Missing destination folder" });

        const folderPath = req.sharedEntry ? req.sharedEntry.folderPath + (req.query.path || "") : getCurrentPath(req);
        if (req.sharedEntry && (!req.sharedEntry.permissions.delete || !req.sharedEntry.permissions.upload)) {
            return res.status(403).json({ error: "No move permission" });
        }

        const sourceKey = folderPath + filename;
        const ownerBase = getUserBaseFolder(req);

        let targetPrefix = ownerBase + destinationPath;
        if (req.sharedEntry) {
            targetPrefix = req.sharedEntry.folderPath + destinationPath;
        }

        const destKey = targetPrefix + filename;
        if (sourceKey === destKey) return res.status(400).json({ error: "Source and destination are the same" });

        const head = await s3.headObject({ Bucket: BUCKET, Key: sourceKey }).promise();

        if (head.ContentLength > 5 * 1024 * 1024 * 1024) {
            return res.status(400).json({ error: "File too large to move (Max 5GB). Please download and re-upload." });
        }

        const originalKey = head.Metadata && head.Metadata.originalkey ? head.Metadata.originalkey : sourceKey;
        const newMetadata = { ...head.Metadata, originalkey: originalKey };

        await s3.copyObject({
            Bucket: BUCKET,
            CopySource: encodeURIComponent(BUCKET + '/' + sourceKey),
            Key: destKey,
            MetadataDirective: 'REPLACE',
            ContentType: head.ContentType,
            Metadata: newMetadata
        }).promise();

        await s3.deleteObject({ Bucket: BUCKET, Key: sourceKey }).promise();

        res.json({ success: true });
    } catch (err) {
        console.error("Move Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------- Delete ----------------
router.get("/delete/:name", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        const folderPath = (req.sharedEntry ? req.sharedEntry.folderPath : getCurrentPath(req)) + req.params.name;
        if (req.sharedEntry && !req.sharedEntry.permissions.delete) return res.status(403).send("No delete permission");

        const list = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: folderPath }).promise();
        if (list.Contents.length > 0) {
            await s3.deleteObjects({ Bucket: BUCKET, Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) } }).promise();
        }
        res.redirect(req.headers.referer || "/");
    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).send("Failed to delete");
    }
});

// ---------------- Download ----------------
router.get("/download/:filename", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        const folderPath = req.sharedEntry ? req.sharedEntry.folderPath + (req.query.path || "") : getCurrentPath(req);
        if (req.sharedEntry && !req.sharedEntry.permissions.download) return res.status(403).send("No download permission");

        const filename = decodeURIComponent(req.params.filename);
        const key = folderPath + filename;

        const head = await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
        const isEncrypted = head.Metadata && head.Metadata.encrypted === "true";
        const version = head.Metadata && head.Metadata.version ? head.Metadata.version : "1";
        const cryptoKey = head.Metadata && head.Metadata.originalkey ? head.Metadata.originalkey : key;

        res.attachment(filename);
        const s3Stream = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();

        if (isEncrypted) {
            s3Stream.pipe(getCryptoStream(cryptoKey, 0, version)).pipe(res);
        } else {
            s3Stream.pipe(res);
        }
    } catch (err) {
        console.error("Download Error:", err);
        res.status(500).send("Download failed");
    }
});

// ---------------- Universal API Key Upload ----------------
router.post("/api/universal-upload", upload.single("file"), async (req, res) => {
    try {
        const { apiKey, userFolder } = req.query;
        if (!apiKey || apiKey !== universalApiKey) return res.status(403).json({ error: "Invalid API key" });
        if (!req.file) return res.status(400).json({ error: "File required" });
        if (!userFolder) return res.status(400).json({ error: "Target folder required" });

        const folderPath = userFolder.replace(/^\//, "").replace(/\/$/, "") + "/";
        await ensureFolderExists(folderPath);
        const filename = req.file.originalname.replace(/\.{2}/g, "");
        const key = folderPath + filename;

        const cipher = getCryptoStream(key, 0);
        let bodyStream = require("stream").Readable.from(req.file.buffer).pipe(cipher);

        await s3.upload({ Bucket: BUCKET, Key: key, Body: bodyStream, Metadata: { encrypted: "true" } }).promise();
        res.json({ message: "File uploaded successfully", key });
    } catch (err) {
        console.error("API Upload Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------- Access (Folder Sharing) ----------------
router.get("/api/access/:folderName", requireLogin, async (req, res) => {
    try {
        const { expiryValue, expiryUnit, accessEmail, permDownload, permUpload, permDelete, userLat, userLng, radiusKm } = req.query;
        const folderName = decodeURIComponent(req.params.folderName);

        if (accessEmail === req.session.user.email) return res.status(400).json({ error: "Cannot share with yourself" });

        const ownerBase = getUserBaseFolder(req);
        const folderPath = ownerBase + (req.query.path || "") + folderName + "/";

        const expirySeconds = parseExpiry(expiryValue, expiryUnit, 60);
        const expiryTime = Math.floor(Date.now() / 1000) + expirySeconds;

        const accessData = {
            folderPath,
            owner: req.session.user.email,
            accessTo: accessEmail,
            permissions: {
                download: permDownload === "true",
                upload: permUpload === "true",
                delete: permDelete === "true",
            },
            expiryTime,
            geofence: userLat && userLng ? {
                latitude: parseFloat(userLat),
                longitude: parseFloat(userLng),
                radiusKm: parseFloat(radiusKm) || 5
            } : null
        };

        const accessRef = push(ref(db, "Access"));
        await set(accessRef, accessData);

        res.json({ message: "Folder access created", shareId: accessRef.key });
    } catch (err) {
        console.error("Share Folder Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------- Share File Link ----------------
router.get("/api/share/:filename", requireLogin, async (req, res) => {
    try {
        const { expiryValue, expiryUnit, max, perIpLimit, userLat, userLng, radiusKm } = req.query;
        const folderPath = getCurrentPath(req);
        const filename = decodeURIComponent(req.params.filename);
        const key = folderPath + filename;

        try { await s3.headObject({ Bucket: BUCKET, Key: key }).promise(); }
        catch { return res.status(404).json({ error: "File not found" }); }

        const expirySeconds = parseExpiry(expiryValue || 60, expiryUnit || "m");
        const expiryTime = Math.floor(Date.now() / 1000) + expirySeconds;

        const linkData = {
            filePath: key,
            owner: req.session.user.email,
            maxDownloads: parseInt(max, 10) || 3,
            downloadsUsed: 0,
            perIpLimit: parseInt(perIpLimit, 10) || 2,
            ipDownloads: {},
            expiryTime,
            geofence: userLat && userLng ? {
                latitude: parseFloat(userLat),
                longitude: parseFloat(userLng),
                radiusKm: parseFloat(radiusKm) || 5
            } : null
        };

        const linkRef = push(ref(db, "links"));
        await set(linkRef, linkData);

        res.json({ message: "Share link created", shareId: linkRef.key, expiresIn: expirySeconds });
    } catch (err) {
        console.error("Share File Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------- Video Streaming ----------------
router.get("/video/:filename", requireLogin, checkSharedAccess, async (req, res) => {
    try {
        const folderPath = req.sharedEntry ? req.sharedEntry.folderPath + (req.query.path || "") : getCurrentPath(req);
        const filename = decodeURIComponent(req.params.filename);
        const key = folderPath + filename;

        try { await s3.headObject({ Bucket: BUCKET, Key: key }).promise(); }
        catch { return res.status(404).send("Video not found"); }

        const head = await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
        const total = head.ContentLength;
        const range = req.headers.range;
        const isEncrypted = head.Metadata && head.Metadata.encrypted === "true";
        const version = head.Metadata && head.Metadata.version ? head.Metadata.version : "1";
        const cryptoKey = head.Metadata && head.Metadata.originalkey ? head.Metadata.originalkey : key;

        if (!range) {
            res.writeHead(200, { "Content-Length": total, "Content-Type": "video/mp4" });
            const s3Stream = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
            if (isEncrypted) s3Stream.pipe(getCryptoStream(cryptoKey, 0, version)).pipe(res);
            else s3Stream.pipe(res);
        } else {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Accept-Ranges": "bytes",
                "Content-Length": (end - start + 1),
                "Content-Type": "video/mp4",
            });
            const s3Stream = s3.getObject({ Bucket: BUCKET, Key: key, Range: `bytes=${start}-${end}` }).createReadStream();
            if (isEncrypted) s3Stream.pipe(getCryptoStream(cryptoKey, start, version)).pipe(res);
            else s3Stream.pipe(res);
        }
    } catch (err) {
        console.error("Stream Video Error:", err);
        res.status(500).send("Failed to stream video");
    }
});

// ---------------- Permission Check ----------------
router.get("/api/check-permissions", requireLogin, checkSharedAccess, (req, res) => {
    if (req.sharedEntry) {
        res.json(req.sharedEntry.permissions);
    } else {
        res.json({ download: true, upload: true, delete: true });
    }
});

// ---------------- Share Management ----------------
router.get("/api/my-shares", requireLogin, async (req, res) => {
    try {
        const userEmail = req.session.user.email;
        const folders = [];
        const links = [];

        // Fetch shared folders
        const accessSnap = await get(ref(db, "Access"));
        if (accessSnap.exists()) {
            const now = Math.floor(Date.now() / 1000);
            for (const [key, entry] of Object.entries(accessSnap.val())) {
                if (entry.expiryTime && entry.expiryTime <= now) {
                    set(ref(db, `Access/${key}`), null).catch(console.error);
                    continue;
                }
                if (entry.owner === userEmail) {
                    folders.push({ id: key, ...entry });
                }
            }
        }

        // Fetch shared links
        const linksSnap = await get(ref(db, "links"));
        if (linksSnap.exists()) {
            const now = Math.floor(Date.now() / 1000);
            for (const [key, entry] of Object.entries(linksSnap.val())) {
                if ((entry.expiryTime && entry.expiryTime <= now) || (entry.maxDownloads && entry.downloadsUsed >= entry.maxDownloads)) {
                    set(ref(db, `links/${key}`), null).catch(console.error);
                    continue;
                }
                if (entry.owner === userEmail) {
                    links.push({ id: key, ...entry });
                }
            }
        }

        res.json({ folders, links });
    } catch (err) {
        console.error("Fetch My Shares Error:", err);
        res.status(500).json({ error: "Failed to fetch shares" });
    }
});

router.put("/api/my-shares/folder/:id", requireLogin, async (req, res) => {
    try {
        const { expiryValue, expiryUnit, permissions } = req.body;
        const snap = await get(ref(db, "Access/" + req.params.id));
        if (!snap.exists()) return res.status(404).json({ error: "Share not found" });
        if (snap.val().owner !== req.session.user.email) return res.status(403).json({ error: "Unauthorized" });

        const updateData = {};
        if (permissions) updateData.permissions = permissions;
        if (expiryValue && expiryUnit) {
            const expirySeconds = parseExpiry(expiryValue, expiryUnit, 60);
            updateData.expiryTime = Math.floor(Date.now() / 1000) + expirySeconds;
        }

        await update(ref(db, "Access/" + req.params.id), updateData);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put("/api/my-shares/link/:id", requireLogin, async (req, res) => {
    try {
        const { expiryValue, expiryUnit, maxDownloads, perIpLimit } = req.body;
        const snap = await get(ref(db, "links/" + req.params.id));
        if (!snap.exists()) return res.status(404).json({ error: "Link not found" });
        if (snap.val().owner !== req.session.user.email) return res.status(403).json({ error: "Unauthorized" });

        const updateData = {};
        if (maxDownloads) updateData.maxDownloads = parseInt(maxDownloads, 10);
        if (perIpLimit) updateData.perIpLimit = parseInt(perIpLimit, 10);
        if (expiryValue && expiryUnit) {
            const expirySeconds = parseExpiry(expiryValue, expiryUnit, 3600);
            updateData.expiryTime = Math.floor(Date.now() / 1000) + expirySeconds;
        }

        await update(ref(db, "links/" + req.params.id), updateData);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete("/api/my-shares/folder/:id", requireLogin, async (req, res) => {
    try {
        const snap = await get(ref(db, "Access/" + req.params.id));
        if (!snap.exists()) return res.status(404).json({ error: "Not found" });
        if (snap.val().owner !== req.session.user.email) return res.status(403).json({ error: "Unauthorized" });

        await set(ref(db, "Access/" + req.params.id), null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete("/api/my-shares/link/:id", requireLogin, async (req, res) => {
    try {
        const snap = await get(ref(db, "links/" + req.params.id));
        if (!snap.exists()) return res.status(404).json({ error: "Not found" });
        if (snap.val().owner !== req.session.user.email) return res.status(403).json({ error: "Unauthorized" });

        await set(ref(db, "links/" + req.params.id), null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
