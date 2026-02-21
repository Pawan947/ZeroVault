function getUserBaseFolder(req) {
    if (!req.session.user || !req.session.user.email) return null;
    return req.session.user.email.replace(/[@.]/g, "_") + "/";
}

function getCurrentPath(req) {
    const base = getUserBaseFolder(req);
    if (!base) return null;
    const path = req.query.path || "";
    return base + path;
}

function parseExpiry(value = 60, unit = "m", min = 60, max = 1209600) {
    const num = Number(value);
    if (isNaN(num)) return min;
    const units = { m: 60, h: 3600, d: 86400 };
    const seconds = (units[unit] || 60) * num;
    return Math.min(Math.max(seconds, min), max);
}

module.exports = { getUserBaseFolder, getCurrentPath, parseExpiry };
