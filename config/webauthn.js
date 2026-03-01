require("dotenv").config();

module.exports = {
    rpName: process.env.RP_NAME || "Secure Team Storage",
    rpID: process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || process.env.RP_ID || "zero-vault-s22z.vercel.app",
    origin: process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.ORIGIN || "https://zero-vault-s22z.vercel.app"),
    universalApiKey: process.env.UNIVERSAL_API_KEY
};
