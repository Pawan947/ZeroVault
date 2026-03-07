const { s3, BUCKET } = require("./config/aws");
const { db } = require("./config/firebase");
const { ref, get } = require("firebase/database");

async function test() {
    console.log("Starting diagnostics...");

    // Test Firebase
    console.log("Testing Firebase connectivity...");
    try {
        const start = Date.now();
        await get(ref(db, "test_connection"));
        console.log(`Firebase OK (${Date.now() - start}ms)`);
    } catch (err) {
        console.error("Firebase FAILED:", err.message);
    }

    // Test Wasabi
    console.log(`Testing Wasabi connectivity to bucket: ${BUCKET}...`);
    try {
        const start = Date.now();
        await s3.headBucket({ Bucket: BUCKET }).promise();
        console.log(`Wasabi Bucket Access OK (${Date.now() - start}ms)`);

        console.log("Testing Signed URL generation...");
        const urlStart = Date.now();
        const url = await s3.getSignedUrlPromise("putObject", {
            Bucket: BUCKET,
            Key: "diag_test.txt",
            Expires: 60,
            ContentType: "text/plain"
        });
        console.log(`Signed URL generated in ${Date.now() - urlStart}ms`);

        console.log("Testing direct PUT with Signed URL...");
        const putStart = Date.now();
        const putRes = await fetch(url, {
            method: 'PUT',
            body: "Diagnostic Test Content",
            headers: { "Content-Type": "text/plain" }
        });

        if (putRes.ok) {
            console.log(`S3 PUT OK (${Date.now() - putStart}ms)`);
        } else {
            const errorText = await putRes.text();
            console.error(`S3 PUT FAILED: ${putRes.status} ${putRes.statusText}`);
            console.error("Response:", errorText);
        }
    } catch (err) {
        console.error("FAILED:", err.message);
    }

    process.exit();
}

test();
