importScripts('https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js');

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

self.onmessage = async function (e) {
    const { file, uploadId, key, preSignedUrls, fileKeyHex } = e.data;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Convert the unique hexadecimal per-file security key derived from the server into AES WordArray
    const aesKey = CryptoJS.enc.Hex.parse(fileKeyHex);

    try {
        const etags = [];
        let hmacContext = CryptoJS.algo.HMAC.create(CryptoJS.algo.SHA256, aesKey);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunkBlob = file.slice(start, end);

            // Read blob to ArrayBuffer
            const arrayBuffer = await chunkBlob.arrayBuffer();
            const wordArray = CryptoJS.lib.WordArray.create(arrayBuffer);

            // Calculate exact IV for this specific chunk offset to mimic cryptoDecipheriv('aes-256-ctr')
            const baseIvHex = CryptoJS.MD5(key + "default").toString();
            // The python/node AES-CTR calculates counter mathematically. 
            // In CryptoJS, CTR mode handles block-level counting internally AFTER the initial IV is set.
            // We just need to give it the exact IV that corresponds to the 'start' byte offset.

            // To properly resume CTR offset, we generate the exact IV block
            const blockIndex = Math.floor(start / 16);

            // Construct padded hex
            let bigIv = BigInt('0x' + baseIvHex) + BigInt(blockIndex);
            let targetIvHex = bigIv.toString(16).padStart(32, '0').slice(-32);
            const iv = CryptoJS.enc.Hex.parse(targetIvHex);

            // Encrypt Chunk
            const encrypted = CryptoJS.AES.encrypt(wordArray, aesKey, {
                iv: iv,
                mode: CryptoJS.mode.CTR,
                padding: CryptoJS.pad.NoPadding
            });

            // Update file-level HMAC
            hmacContext.update(encrypted.ciphertext);

            // Convert back to ArrayBuffer/Blob for upload
            // CryptoJS returns Base64, we need raw binary for S3
            const encryptedWordArr = encrypted.ciphertext;
            const encryptedBytes = new Uint8Array(encryptedWordArr.sigBytes);
            for (let j = 0; j < encryptedWordArr.sigBytes; j++) {
                encryptedBytes[j] = (encryptedWordArr.words[j >>> 2] >>> (24 - (j % 4) * 8)) & 0xff;
            }

            // Upload to S3 directly via Presigned URL
            self.postMessage({ type: 'progress', chunk: i + 1, total: totalChunks, status: 'uploading' });

            const presignedUrl = preSignedUrls[i];

            const etag = await uploadChunkToS3(presignedUrl, encryptedBytes);
            etags.push({ PartNumber: i + 1, ETag: etag });

            self.postMessage({ type: 'progress', chunk: i + 1, total: totalChunks, status: 'done' });
        }

        const finalHmac = hmacContext.finalize().toString();

        self.postMessage({ type: 'complete', etags, hmac: finalHmac });

    } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
    }
};

async function uploadChunkToS3(url, data) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url, true);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");

        xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 204) {
                // S3 returns ETag in headers
                const etag = xhr.getResponseHeader("ETag") || "";
                resolve(etag.replace(/"/g, ''));
            } else {
                reject(new Error("S3 Upload Chunk Failed: " + xhr.status));
            }
        };
        xhr.onerror = () => reject(new Error("Network Error"));
        xhr.send(data);
    });
}
