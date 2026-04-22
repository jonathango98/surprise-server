import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const s3 = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = () => process.env.S3_BUCKET_NAME;

/**
 * Generate a presigned PUT URL for uploading an object.
 * @param {string} key - S3 object key
 * @param {string} contentType - MIME type
 * @param {number} maxBytes - Maximum allowed content length in bytes
 * @param {number} expiresIn - URL expiry in seconds (default 15 min)
 */
export async function getPresignedPutUrl(key, _contentType, _maxBytes, expiresIn = 900) {
  const command = new PutObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    // Note: ContentType is intentionally excluded from the signature so S3 does not
    // enforce a match against the browser's recorded MIME type (e.g. video/webm vs video/mp4).
    // The browser still sends Content-Type with the XHR and S3 stores it on the object.
    // Content-Length enforcement via presigned URL conditions is not natively supported
    // by PutObject presigning in AWS SDK v3; enforced client-side / via bucket policy.
  });

  const url = await getSignedUrl(s3, command, { expiresIn });
  return url;
}

/**
 * Generate a presigned GET URL for reading an object.
 * @param {string} key - S3 object key
 * @param {number} expiresIn - URL expiry in seconds (default 1 hr)
 */
export async function getPresignedGetUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: BUCKET(),
    Key: key,
  });

  const url = await getSignedUrl(s3, command, { expiresIn });
  return url;
}

/**
 * List all S3 objects under a given prefix.
 * Handles pagination automatically.
 * @param {string} prefix
 * @returns {Promise<import('@aws-sdk/client-s3')._Object[]>}
 */
export async function listObjects(prefix) {
  const objects = [];
  let continuationToken;

  do {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET(),
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await s3.send(command);

    if (response.Contents) {
      objects.push(...response.Contents);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * Delete an S3 object by key.
 * @param {string} key - S3 object key
 */
export async function deleteObject(key) {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET(),
    Key: key,
  });
  await s3.send(command);
}

/**
 * Upload a file from disk to S3 by streaming (avoids loading into memory).
 * @param {string} key - S3 object key
 * @param {string} filePath - Local file path to stream
 * @param {string} contentType - MIME type
 */
export async function uploadFile(key, filePath, contentType) {
  const { size } = await stat(filePath);
  console.log(`[s3:uploadFile] starting | key=${key} size=${size} contentType=${contentType}`);
  const command = new PutObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    Body: createReadStream(filePath),
    ContentType: contentType,
    ContentLength: size,
  });
  await s3.send(command);
  console.log(`[s3:uploadFile] done | key=${key}`);
}

/**
 * Stream an S3 object body.
 * @param {string} key
 * @returns {Promise<import('stream').Readable>}
 */
export async function getObjectStream(key) {
  const command = new GetObjectCommand({
    Bucket: BUCKET(),
    Key: key,
  });

  const response = await s3.send(command);
  return response.Body;
}
