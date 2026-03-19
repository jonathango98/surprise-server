import { Router } from 'express';
import { Submission } from '../models/Submission.js';
import { Setting } from '../models/Setting.js';
import { getPresignedPutUrl } from '../s3.js';
import { deadlineGuard } from '../middleware/deadline.js';
import { presignRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a raw string field: lowercase + trim.
 */
function normalise(str) {
  return String(str).toLowerCase().trim();
}

/**
 * Build the submission identifier from name parts.
 * e.g. "John", "Doe", "Jakarta" → "john-doe-jakarta"
 */
function buildIdentifier(firstName, lastName, location) {
  return [firstName, lastName, location]
    .map((s) => normalise(s).replace(/\s+/g, '-'))
    .join('-');
}

/**
 * Determine the retake suffix for a new clip key.
 *
 * The current key stored in clips.p{n} follows the pattern:
 *   sharon-bday/prompt-1/identifier-p1.mp4          (first upload)
 *   sharon-bday/prompt-1/identifier-p1-2.mp4        (first retake)
 *   sharon-bday/prompt-1/identifier-p1-3.mp4        (second retake)
 *
 * If the prompt has not been completed yet → no suffix (first upload).
 * If it has been completed → suffix is current retake number + 1,
 *   where the current retake number is extracted from the existing key,
 *   defaulting to 1 (i.e. the base file) when no numeric suffix is present.
 *
 * @param {object|null} submission - Mongoose document or null
 * @param {number} prompt
 * @param {string} baseKey - e.g. "sharon-bday/prompt-1/identifier-p1" (no .mp4)
 * @returns {string} full S3 key including .mp4 extension
 */
function resolveClipKey(submission, prompt, baseKey) {
  if (!submission) {
    return `${baseKey}.webm`;
  }

  const isCompleted = submission.completedPrompts.includes(prompt);
  if (!isCompleted) {
    return `${baseKey}.webm`;
  }

  // Prompt already completed — this is a retake
  const existingKey = submission.clips.get ? submission.clips.get(`p${prompt}`) : submission.clips[`p${prompt}`];

  if (!existingKey) {
    // Completed but no key stored — treat as fresh
    return `${baseKey}.webm`;
  }

  // Strip .mp4 extension, then look for trailing -<number>
  const withoutExt = existingKey.replace(/\.webm$/, '');
  const match = withoutExt.match(/-(\d+)$/);

  const currentRetakeNumber = match ? parseInt(match[1], 10) : 1;
  const newRetakeNumber = currentRetakeNumber + 1;

  return `${baseKey}-${newRetakeNumber}.mp4`;
}

// ---------------------------------------------------------------------------
// GET /deadline
// ---------------------------------------------------------------------------

router.get('/deadline', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'deadline' }).lean();
    return res.json({ deadline: setting ? setting.value : null });
  } catch (err) {
    console.error('GET /deadline error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /session
// ---------------------------------------------------------------------------

router.post('/session', async (req, res) => {
  const { firstName, lastName, location } = req.body;

  if (!firstName || !lastName || !location) {
    return res.status(400).json({ error: 'firstName, lastName, and location are required' });
  }

  const identifier = buildIdentifier(firstName, lastName, location);

  try {
    let submission = await Submission.findOne({ identifier });

    if (submission) {
      return res.json({
        isReturning: true,
        completedPrompts: submission.completedPrompts,
        identifier: submission.identifier,
      });
    }

    // Create new submission
    submission = await Submission.create({
      firstName: normalise(firstName),
      lastName: normalise(lastName),
      location: normalise(location),
      identifier,
      completedPrompts: [],
      clips: {},
      photos: [],
    });

    return res.status(201).json({
      isReturning: false,
      completedPrompts: [],
      identifier: submission.identifier,
    });
  } catch (err) {
    console.error('POST /session error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /presign — generate presigned PUT URL for a video clip
// ---------------------------------------------------------------------------

router.post('/presign', presignRateLimiter, deadlineGuard, async (req, res) => {
  const { identifier, prompt } = req.body;

  if (!identifier || prompt === undefined || prompt === null) {
    return res.status(400).json({ error: 'identifier and prompt are required' });
  }

  const promptNum = parseInt(prompt, 10);
  if (isNaN(promptNum) || promptNum < 1) {
    return res.status(400).json({ error: 'prompt must be a positive integer' });
  }

  try {
    const submission = await Submission.findOne({ identifier });

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found. Please start a session first.' });
    }

    const baseKey = `sharon-bday/prompt-${promptNum}/${identifier}-p${promptNum}`;
    const s3Key = resolveClipKey(submission, promptNum, baseKey);

    const uploadUrl = await getPresignedPutUrl(s3Key, 'video/webm', 50 * 1024 * 1024);

    return res.json({ uploadUrl, s3Key });
  } catch (err) {
    console.error('POST /presign error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /submit-clip — confirm clip upload, update MongoDB
// ---------------------------------------------------------------------------

router.post('/submit-clip', async (req, res) => {
  const { identifier, prompt, s3Key } = req.body;

  if (!identifier || prompt === undefined || prompt === null || !s3Key) {
    return res.status(400).json({ error: 'identifier, prompt, and s3Key are required' });
  }

  const promptNum = parseInt(prompt, 10);
  if (isNaN(promptNum) || promptNum < 1) {
    return res.status(400).json({ error: 'prompt must be a positive integer' });
  }

  try {
    const clipField = `clips.p${promptNum}`;

    const submission = await Submission.findOneAndUpdate(
      { identifier },
      {
        $set: { [clipField]: s3Key },
        $addToSet: { completedPrompts: promptNum },
      },
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    return res.json({ success: true, completedPrompts: submission.completedPrompts });
  } catch (err) {
    console.error('POST /submit-clip error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /presign-photo — generate presigned PUT URL for a photo
// ---------------------------------------------------------------------------

router.post('/presign-photo', presignRateLimiter, deadlineGuard, async (req, res) => {
  const { identifier } = req.body;

  if (!identifier) {
    return res.status(400).json({ error: 'identifier is required' });
  }

  try {
    const submission = await Submission.findOne({ identifier });

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found. Please start a session first.' });
    }

    const photoCount = submission.photos ? submission.photos.length : 0;
    const photoIndex = photoCount + 1;

    const s3Key = `sharon-bday/photos/${identifier}-${photoIndex}.jpg`;

    const uploadUrl = await getPresignedPutUrl(s3Key, 'image/jpeg', 10 * 1024 * 1024);

    return res.json({ uploadUrl, s3Key });
  } catch (err) {
    console.error('POST /presign-photo error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /submit-photo — confirm photo upload, update MongoDB
// ---------------------------------------------------------------------------

router.post('/submit-photo', async (req, res) => {
  const { identifier, s3Key, wish } = req.body;

  if (!identifier || !s3Key) {
    return res.status(400).json({ error: 'identifier and s3Key are required' });
  }

  try {
    const submission = await Submission.findOneAndUpdate(
      { identifier },
      {
        $push: { photos: { url: s3Key, wish: wish || '' } },
      },
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('POST /submit-photo error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
