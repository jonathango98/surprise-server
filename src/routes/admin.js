import { Router } from 'express';
import { spawn } from 'child_process';
import jwt from 'jsonwebtoken';
import archiver from 'archiver';
import { Submission } from '../models/Submission.js';
import { Setting } from '../models/Setting.js';
import { adminAuth } from '../middleware/auth.js';
import { getPresignedGetUrl, listObjects, getObjectStream } from '../s3.js';

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
    const submissions = await Submission.find({}).lean();

    const result = submissions.map((s) => ({
      identifier: s.identifier,
      firstName: s.firstName,
      lastName: s.lastName,
      location: s.location,
      submittedAt: s.submittedAt,
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

    const conversionPromises = [];

    for (const obj of objects) {
      if (!obj.Key || obj.Key.endsWith('/')) {
        // Skip directory-like keys
        continue;
      }

      try {
        const stream = await getObjectStream(obj.Key);
        const rawEntryName = obj.Key.replace(prefix, '');

        if (rawEntryName.endsWith('.webm')) {
          // Convert WebM → MP4 via FFmpeg and collect the full buffer
          // before appending, since archiver needs to know the size or
          // the stream must end cleanly before the next entry.
          const mp4EntryName = rawEntryName.replace(/\.webm$/, '.mp4');
          const promise = new Promise((resolve) => {
            const ffmpeg = spawn('ffmpeg', [
              '-i', 'pipe:0',        // read from stdin
              '-c:v', 'libx264',
              '-preset', 'fast',
              '-crf', '23',
              '-c:a', 'aac',
              '-movflags', 'frag_keyframe+empty_moov', // streamable MP4
              '-f', 'mp4',
              'pipe:1',              // write to stdout
            ], { stdio: ['pipe', 'pipe', 'pipe'] });

            const chunks = [];
            ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
            ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs
            ffmpeg.on('close', (code) => {
              if (code === 0 && chunks.length > 0) {
                archive.append(Buffer.concat(chunks), { name: mp4EntryName });
              } else {
                console.error(`FFmpeg exited with code ${code} for ${obj.Key}`);
              }
              resolve();
            });
            ffmpeg.on('error', (err) => {
              console.error(`FFmpeg spawn error for ${obj.Key}:`, err);
              resolve();
            });

            stream.pipe(ffmpeg.stdin);
            stream.on('error', () => ffmpeg.stdin.destroy());
          });
          conversionPromises.push(promise);
        } else {
          archive.append(stream, { name: rawEntryName });
        }
      } catch (streamErr) {
        console.error(`Failed to stream object ${obj.Key}:`, streamErr);
        // Skip failed objects rather than aborting the whole ZIP
      }
    }

    // Wait for all WebM → MP4 conversions to finish
    await Promise.all(conversionPromises);

    await archive.finalize();
  } catch (err) {
    console.error('GET /admin/download error:', err);

    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    res.destroy(err);
  }
});

export default router;
