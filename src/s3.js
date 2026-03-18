import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const s3 = new S3Client({
  region: process.env.AWS_REGION,
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
export async function getPresignedPutUrl(key, contentType, maxBytes, expiresIn = 900) {
  const command = new PutObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    ContentType: contentType,
    // Note: Content-Length enforcement via presigned URL conditions is not
    // natively supported by PutObject presigning in AWS SDK v3.
    // The maxBytes limit is documented and enforced client-side / via bucket policy.
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
