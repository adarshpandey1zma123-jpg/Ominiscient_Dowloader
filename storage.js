const fs = require('fs');
const path = require('path');

let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;
let isS3Configured = false;
let s3Client = null;

try {
    const s3 = require('@aws-sdk/client-s3');
    S3Client = s3.S3Client;
    PutObjectCommand = s3.PutObjectCommand;
    GetObjectCommand = s3.GetObjectCommand;
    DeleteObjectCommand = s3.DeleteObjectCommand;

    isS3Configured = !!(
        process.env.S3_ACCESS_KEY_ID &&
        process.env.S3_SECRET_ACCESS_KEY &&
        process.env.S3_BUCKET_NAME
    );
} catch (e) {
    console.warn('[Storage] @aws-sdk/client-s3 module not found. Falling back to local storage only.');
    isS3Configured = false;
}

if (isS3Configured) {
    try {
        const s3Config = {
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY_ID,
                secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
            }
        };

        if (process.env.S3_ENDPOINT) {
            s3Config.endpoint = process.env.S3_ENDPOINT;
        }

        if (process.env.S3_FORCE_PATH_STYLE === 'true') {
            s3Config.forcePathStyle = true;
        }

        s3Client = new S3Client(s3Config);
        console.log('[Storage] S3 Cloud Storage initialized successfully.');
    } catch (err) {
        console.error('[Storage] Error initializing S3 client:', err.message);
        isS3Configured = false;
    }
}

/**
 * Uploads a local file to Cloud Storage
 * @param {string} localPath - Absolute path to the local file
 * @param {string} s3Key - S3 Object Key
 * @returns {Promise<any>}
 */
async function uploadFile(localPath, s3Key) {
    if (!isS3Configured || !s3Client) {
        return null;
    }

    const fileStream = fs.createReadStream(localPath);
    const stats = fs.statSync(localPath);

    const command = new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: fileStream,
        ContentLength: stats.size
    });

    return s3Client.send(command);
}

/**
 * Gets a read stream for a file in Cloud Storage
 * @param {string} s3Key - S3 Object Key
 * @returns {Promise<import('stream').Readable>}
 */
async function downloadStream(s3Key) {
    if (!isS3Configured || !s3Client) {
        throw new Error('S3 is not configured.');
    }

    const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Key
    });

    const response = await s3Client.send(command);
    return response.Body;
}

/**
 * Deletes a file from Cloud Storage
 * @param {string} s3Key - S3 Object Key
 * @returns {Promise<any>}
 */
async function deleteFile(s3Key) {
    if (!isS3Configured || !s3Client) {
        return null;
    }

    const command = new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Key
    });

    return s3Client.send(command);
}

module.exports = {
    isCloudEnabled: () => isS3Configured,
    uploadFile,
    downloadStream,
    deleteFile
};
