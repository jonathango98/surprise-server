import { Router } from 'express';
import { unlink } from 'fs/promises';
import { join } from 'path';
import os from 'os';
import { randomBytes } from 'crypto';

import jwt from 'jsonwebtoken';
import archiver from 'archiver';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { Submission } from '../models/Submission.js';
import { Setting } from '../models/Setting.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { adminAuth } from '../middleware/auth.js';
import { getPresignedGetUrl, listObjects, getObjectStream, deleteObject, uploadFile } from '../s3.js';
import { logActivity } from '../activityLog.js';

ffmpeg.setFfmpegPath(ffmpegPath);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(mp4|mov|webm)$/i.test(file.originalname) || ['video/mp4', 'video/quicktime', 'video/webm'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only .mp4, .mov, and .webm files are allowed'));
    }
  },
});

const uploadPhoto = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(jpe?g|png|webp|heic)$/i.test(file.originalname) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (jpg, png, webp, heic)'));
    }
  },
});

const router = Router();

// ---------------------------------------------------------------------------
// POST /admin/login  (no auth required)
// ---------------------------------------------------------------------------

router.post('/login', async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'password is required' });
  }

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = jwt.sign(
    { role: 'admin' },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: '24h' }
  );

  await logActivity('admin_login', 'admin', 'Admin');

  return res.json({ token });
});

// ---------------------------------------------------------------------------
// All routes below require admin JWT
// ---------------------------------------------------------------------------

router.use(adminAuth);

// ---------------------------------------------------------------------------
// GET /admin/deadline
// ---------------------------------------------------------------------------

router.get('/deadline', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'deadline' }).lean();
    return res.json({ deadline: setting ? setting.value : null });
  } catch (err) {
    console.error('GET /admin/deadline error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/deadline
// ---------------------------------------------------------------------------

router.post('/deadline', async (req, res) => {
  const { deadline } = req.body;

  if (!deadline) {
    return res.status(400).json({ error: 'deadline is required' });
  }

  if (isNaN(new Date(deadline).getTime())) {
    return res.status(400).json({ error: 'deadline must be a valid ISO 8601 date string' });
  }

  try {
    await Setting.findOneAndUpdate(
      { key: 'deadline' },
      { key: 'deadline', value: deadline },
      { upsert: true, new: true }
    );

    return res.json({ success: true, deadline });
  } catch (err) {
    console.error('POST /admin/deadline error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/submissions
// ---------------------------------------------------------------------------

router.get('/submissions', async (req, res) => {
  try {
    const submissions = await Submission.find({ status: { $ne: 'deleted' } }).lean();

    const result = submissions.map((s) => ({
      identifier: s.identifier,
      firstName: s.firstName,
      lastName: s.lastName,
      location: s.location,
      submittedAt: s.submittedAt,
      lastActivityAt: s.lastActivityAt || s.submittedAt,
      completedPrompts: s.completedPrompts,
      photoCount: Array.isArray(s.photos) ? s.photos.length : 0,
    }));

    return res.json(result);
  } catch (err) {
    console.error('GET /admin/submissions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/submission/:identifier
// ---------------------------------------------------------------------------

router.get('/submission/:identifier', async (req, res) => {
  const { identifier } = req.params;

  try {
    const submission = await Submission.findOne({ identifier }).lean();

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Generate presigned GET URLs for all clips
    const clipsRaw = submission.clips || {};
    const clipsWithUrls = {};

    for (const [key, s3Key] of Object.entries(clipsRaw)) {
      if (s3Key) {
        try {
          clipsWithUrls[key] = await getPresignedGetUrl(s3Key, 3600);
        } catch (urlErr) {
          console.error(`Failed to generate presigned URL for clip ${key}:`, urlErr);
          clipsWithUrls[key] = null;
        }
      }
    }

    // Generate presigned GET URLs for all photos
    const photosWithUrls = [];
    for (const photo of submission.photos || []) {
      try {
        const url = await getPresignedGetUrl(photo.url, 3600);
        photosWithUrls.push({ url, wish: photo.wish });
      } catch (urlErr) {
        console.error(`Failed to generate presigned URL for photo ${photo.url}:`, urlErr);
        photosWithUrls.push({ url: null, wish: photo.wish });
      }
    }

    return res.json({
      identifier: submission.identifier,
      firstName: submission.firstName,
      lastName: submission.lastName,
      location: submission.location,
      submittedAt: submission.submittedAt,
      completedPrompts: submission.completedPrompts,
      clips: clipsWithUrls,
      photos: photosWithUrls,
    });
  } catch (err) {
    console.error('GET /admin/submission/:identifier error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/submission/:identifier/clip/:prompt
// ---------------------------------------------------------------------------

router.delete('/submission/:identifier/clip/:prompt', async (req, res) => {
  const { identifier, prompt } = req.params;

  try {
    const sub = await Submission.findOne({ identifier });
    if (!sub) return res.status(404).json({ message: 'Submission not found' });

    const clipKey = `p${prompt}`;
    const s3Key = sub.clips?.get(clipKey);

    if (!s3Key) return res.status(404).json({ message: 'Clip not found' });

    // Delete from S3
    try {
      await deleteObject(s3Key);
    } catch (err) {
      console.error('S3 delete failed:', err);
    }

    // Update DB
    sub.clips.delete(clipKey);
    sub.completedPrompts = sub.completedPrompts.filter(n => n !== Number(prompt));
    await sub.save();

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /admin/submission/:identifier/clip/:prompt error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/submission/:identifier/photo/:index
// ---------------------------------------------------------------------------

router.delete('/submission/:identifier/photo/:index', async (req, res) => {
  const { identifier, index } = req.params;
  const photoIndex = parseInt(index, 10);

  try {
    const sub = await Submission.findOne({ identifier });
    if (!sub) return res.status(404).json({ message: 'Submission not found' });

    if (isNaN(photoIndex) || photoIndex < 0 || photoIndex >= sub.photos.length) {
      return res.status(404).json({ message: 'Photo not found' });
    }

    const s3Key = sub.photos[photoIndex].url;

    // Delete from S3
    try {
      await deleteObject(s3Key);
    } catch (err) {
      console.error('S3 delete failed:', err);
    }

    // Remove from DB
    sub.photos.splice(photoIndex, 1);
    await sub.save();

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /admin/submission/:identifier/photo/:index error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/submission/:identifier
// ---------------------------------------------------------------------------

router.delete('/submission/:identifier', async (req, res) => {
  try {
    const sub = await Submission.findOne({ identifier: req.params.identifier });
    if (!sub) return res.status(404).json({ message: 'Submission not found' });

    // Delete all clips from S3
    for (const s3Key of (sub.clips || new Map()).values()) {
      try { await deleteObject(s3Key); } catch (err) { console.error('S3 clip delete failed:', err); }
    }

    // Delete all photos from S3
    for (const photo of sub.photos || []) {
      try { await deleteObject(photo.url); } catch (err) { console.error('S3 photo delete failed:', err); }
    }

    // Soft-delete the submission
    sub.status = 'deleted';
    sub.clips = new Map();
    sub.photos = [];
    sub.completedPrompts = [];
    await sub.save();

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /admin/submission/:identifier error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/bucket
// ---------------------------------------------------------------------------

router.get('/bucket', async (req, res) => {
  try {
    const raw = await listObjects('');

    const objects = await Promise.all(
      raw
        .filter((obj) => obj.Key && !obj.Key.endsWith('/'))
        .map(async (obj) => {
          let url = null;
          try {
            url = await getPresignedGetUrl(obj.Key, 3600);
          } catch (err) {
            console.error(`Failed to generate presigned URL for ${obj.Key}:`, err);
          }
          return {
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified,
            url,
          };
        })
    );

    return res.json({ objects });
  } catch (err) {
    console.error('GET /admin/bucket error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/bucket/file
// ---------------------------------------------------------------------------

router.delete('/bucket/file', async (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ error: 'key is required' });
  }

  try {
    await deleteObject(key);
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/bucket/file error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/download
// ---------------------------------------------------------------------------

router.get('/download', async (req, res) => {
  const { prompt, all } = req.query;

  let prefix;
  let filename;

  if (all === 'true') {
    prefix = 'sharon-bday/';
    filename = 'sharon-bday-all.zip';
  } else if (prompt === 'photos') {
    prefix = 'sharon-bday/photos/';
    filename = 'sharon-bday-photos.zip';
  } else if (prompt) {
    const promptNum = parseInt(prompt, 10);
    if (isNaN(promptNum) || promptNum < 1) {
      return res.status(400).json({ error: 'prompt must be a positive integer or "photos"' });
    }
    prefix = `sharon-bday/prompt-${promptNum}/`;
    filename = `sharon-bday-prompt-${promptNum}.zip`;
  } else {
    return res.status(400).json({ error: 'Provide ?prompt=<n>, ?prompt=photos, or ?all=true' });
  }

  try {
    const objects = await listObjects(prefix);

    if (objects.length === 0) {
      return res.status(404).json({ error: 'No files found for the specified prefix' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('error', (err) => {
      console.error('Archiver error:', err);
      // Headers already sent, just destroy the response
      res.destroy(err);
    });

    archive.pipe(res);

    for (const obj of objects) {
      if (!obj.Key || obj.Key.endsWith('/')) {
        // Skip directory-like keys
        continue;
      }

      try {
        const stream = await getObjectStream(obj.Key);
        const rawEntryName = obj.Key.replace(prefix, '');

        archive.append(stream, { name: rawEntryName });
      } catch (streamErr) {
        console.error(`Failed to stream object ${obj.Key}:`, streamErr);
        // Skip failed objects rather than aborting the whole ZIP
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('GET /admin/download error:', err);

    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    res.destroy(err);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/upload-clip  — upload .mp4/.mov, convert to webm, save as clip
// ---------------------------------------------------------------------------

router.post('/upload-clip', (req, res, next) => {
  console.log('[upload-clip] multer: receiving file...');
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.message === 'Request aborted') {
        console.log('[upload-clip] multer: request aborted by client');
        return;
      }
      console.error('[upload-clip] multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    console.log('[upload-clip] multer: file received ok');
    next();
  });
}, async (req, res) => {
  const { identifier, prompt } = req.body;
  const file = req.file;

  console.log('[upload-clip] body:', { identifier, prompt });
  console.log('[upload-clip] file:', file ? { originalname: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path } : 'MISSING');

  if (!identifier || !prompt || !file) {
    if (file) await unlink(file.path).catch(() => {});
    return res.status(400).json({ error: 'identifier, prompt, and file are required' });
  }

  const promptNum = parseInt(prompt, 10);
  if (isNaN(promptNum) || promptNum < 1 || promptNum > 4) {
    await unlink(file.path).catch(() => {});
    return res.status(400).json({ error: 'prompt must be 1–4' });
  }

  const outputPath = join(os.tmpdir(), `${randomBytes(8).toString('hex')}.webm`);

  try {
    console.log('[upload-clip] looking up submission:', identifier);
    const sub = await Submission.findOne({ identifier });
    if (!sub) {
      console.log('[upload-clip] submission not found:', identifier);
      await unlink(file.path).catch(() => {});
      return res.status(404).json({ error: 'Submission not found' });
    }
    console.log('[upload-clip] submission found:', sub.identifier);

    const isWebm = /\.webm$/i.test(file.originalname) || file.mimetype === 'video/webm';
    const uploadPath = isWebm ? file.path : outputPath;
    console.log('[upload-clip] isWebm:', isWebm, '| uploadPath:', uploadPath);

    if (!isWebm) {
      console.log('[upload-clip] starting ffmpeg conversion...');
      await new Promise((resolve, reject) => {
        ffmpeg(file.path)
          .outputFormat('webm')
          .videoCodec('libvpx')
          .audioCodec('libopus')
          .outputOptions(['-cpu-used 5', '-deadline realtime', '-crf 10', '-b:v 1M'])
          .on('start', (cmd) => console.log('[upload-clip] ffmpeg command:', cmd))
          .on('progress', (p) => console.log(`[upload-clip] ffmpeg progress: ${JSON.stringify(p)}`))
          .on('end', () => { console.log('[upload-clip] ffmpeg conversion done'); resolve(); })
          .on('error', (err) => { console.error('[upload-clip] ffmpeg error:', err.message); reject(err); })
          .save(outputPath);
      });
      await unlink(file.path).catch(() => {});
    }

    const clipKey = `p${promptNum}`;
    const existingKey = sub.clips?.get(clipKey);
    if (existingKey) {
      console.log('[upload-clip] deleting old S3 clip:', existingKey);
      await deleteObject(existingKey).catch((err) => console.error('[upload-clip] failed to delete old clip:', err));
    }

    const s3Key = `sharon-bday/prompt-${promptNum}/${identifier}-p${promptNum}.webm`;
    console.log('[upload-clip] uploading to S3:', s3Key, '| from:', uploadPath);
    await uploadFile(s3Key, uploadPath, 'video/webm');
    console.log('[upload-clip] S3 upload done');

    await unlink(uploadPath).catch(() => {});

    console.log('[upload-clip] saving to DB...');
    sub.clips.set(clipKey, s3Key);
    sub.markModified('clips');
    if (!sub.completedPrompts.includes(promptNum)) {
      sub.completedPrompts.push(promptNum);
    }
    sub.lastActivityAt = new Date();
    await sub.save();
    console.log('[upload-clip] DB save done, responding success');

    await logActivity('clip_upload', identifier, `${sub.firstName} ${sub.lastName}`, `Prompt ${promptNum} (admin upload)`);

    return res.json({ success: true, s3Key });
  } catch (err) {
    console.error('[upload-clip] caught error:', err);
    await unlink(file.path).catch(() => {});
    await unlink(outputPath).catch(() => {});
    return res.status(500).json({ error: 'Failed to process video: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/upload-photo  — upload an image and add it to a submission
// ---------------------------------------------------------------------------

router.post('/upload-photo', (req, res, next) => {
  console.log('[upload-photo] multer: receiving file...');
  uploadPhoto.single('file')(req, res, (err) => {
    if (err) {
      if (err.message === 'Request aborted') { console.log('[upload-photo] request aborted'); return; }
      console.error('[upload-photo] multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    console.log('[upload-photo] multer: file received ok');
    next();
  });
}, async (req, res) => {
  const { identifier, wish } = req.body;
  const file = req.file;

  console.log('[upload-photo] body:', { identifier, wish });
  console.log('[upload-photo] file:', file ? { originalname: file.originalname, mimetype: file.mimetype, size: file.size } : 'MISSING');

  if (!identifier || !file) {
    if (file) await unlink(file.path).catch(() => {});
    return res.status(400).json({ error: 'identifier and file are required' });
  }

  try {
    const sub = await Submission.findOne({ identifier });
    if (!sub) {
      await unlink(file.path).catch(() => {});
      return res.status(404).json({ error: 'Submission not found' });
    }

    const photoIndex = (sub.photos?.length ?? 0) + 1;
    const ext = file.originalname.split('.').pop().toLowerCase() || 'jpg';
    const s3Key = `sharon-bday/photos/${identifier}-${photoIndex}.${ext}`;

    console.log('[upload-photo] uploading to S3:', s3Key);
    await uploadFile(s3Key, file.path, file.mimetype);
    await unlink(file.path).catch(() => {});
    console.log('[upload-photo] S3 upload done');

    sub.photos.push({ url: s3Key, wish: wish || '' });
    sub.lastActivityAt = new Date();
    await sub.save();
    console.log('[upload-photo] DB save done');

    await logActivity('photo_upload', identifier, `${sub.firstName} ${sub.lastName}`, 'admin upload');

    return res.json({ success: true, s3Key });
  } catch (err) {
    console.error('[upload-photo] error:', err);
    await unlink(file.path).catch(() => {});
    return res.status(500).json({ error: 'Failed to upload photo: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/activity-log
// ---------------------------------------------------------------------------

router.get('/activity-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const logs = await ActivityLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json(logs);
  } catch (err) {
    console.error('GET /admin/activity-log error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
