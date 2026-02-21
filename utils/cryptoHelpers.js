const crypto = require("crypto");

const MASTER_KEY = crypto.scryptSync(process.env.SESSION_SECRET || "default_secret_key_123456", "salt", 32);

function getCryptoStream(filePath, rangeStart = 0) {
    const iv = crypto.createHash("md5").update(filePath + (process.env.SESSION_SECRET || "default")).digest();

    const blockIndex = BigInt(Math.floor(rangeStart / 16));

    let ivHex = iv.toString('hex');
    let ivBigInt = BigInt('0x' + ivHex);
    ivBigInt += blockIndex;

    let newIvHex = ivBigInt.toString(16);
    // pad to 32 chars
    newIvHex = newIvHex.padStart(32, '0');
    // Truncate if overflows
    if (newIvHex.length > 32) newIvHex = newIvHex.slice(newIvHex.length - 32);

    const counterBuffer = Buffer.from(newIvHex, 'hex');

    const cipher = crypto.createDecipheriv("aes-256-ctr", MASTER_KEY, counterBuffer);

    const offsetInBlock = rangeStart % 16;
    if (offsetInBlock > 0) {
        cipher.update(Buffer.alloc(offsetInBlock));
    }

    return cipher;
}

module.exports = { getCryptoStream };
