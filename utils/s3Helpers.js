const { s3, BUCKET } = require("../config/aws");

const folderCache = new Set();

async function ensureFolderExists(key) {
    if (folderCache.has(key)) return;
    try {
        await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
    } catch {
        await s3.putObject({ Bucket: BUCKET, Key: key }).promise();
    }
    folderCache.add(key);
}

async function listFilesAndFolders(prefix) {
    const data = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: prefix, Delimiter: "/" }).promise();
    const files = data.Contents.filter(o => o.Key !== prefix).map(o => ({
        name: o.Key.replace(prefix, ""),
        size: (o.Size / 1024).toFixed(2) + " KB",
        lastModified: o.LastModified.toLocaleString(),
    }));
    const folders = (data.CommonPrefixes || []).map(f => f.Prefix.replace(prefix, "").replace(/\/$/, ""));
    return { files, folders };
}

module.exports = { ensureFolderExists, listFilesAndFolders };
