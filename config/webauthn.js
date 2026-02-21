require("dotenv").config();

module.exports = {
    rpName: process.env.RP_NAME || "Secure Team Storage",
    rpID: process.env.RP_ID || "storage-v3.vercel.app",
    origin: process.env.ORIGIN || "https://storage-v3.vercel.app",
    universalApiKey: process.env.UNIVERSAL_API_KEY
};
