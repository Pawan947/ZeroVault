const AWS = require("aws-sdk");
require("dotenv").config();

const s3 = new AWS.S3({
    endpoint: process.env.WASABI_ENDPOINT,
    region: process.env.WASABI_REGION,
    accessKeyId: process.env.WASABI_ACCESS_KEY_ID,
    secretAccessKey: process.env.WASABI_SECRET_ACCESS_KEY,
    s3ForcePathStyle: false, // Use virtual-host style
    signatureVersion: 'v4',
});

const BUCKET = process.env.WASABI_BUCKET;

module.exports = { s3, BUCKET };
