import express from 'express';
import { Submission } from '../models/Submission.js';
import { getPresignedGetUrl } from '../s3.js';

const router = express.Router();

const VIDEO_PROMPT_NUMS = [1, 2, 3]; // prompt 4 is excluded from the gallery

// ---------------------------------------------------------------------------
// GET /gallery
// Returns { cards: [{ id, firstName, wish, photoUrl, submittedAt }, ...] }
// Also includes video clips: { id, firstName, videoUrl, promptNum, submittedAt }
// No auth required — public read-only endpoint.
// ---------------------------------------------------------------------------

router.get('/gallery', async (_req, res) => {
  try {
    const submissions = await Submission.find({ status: { $ne: 'deleted' } }).lean();

    const cardPromises = submissions.flatMap((s) => {
      const photoCards = (s.photos || []).map(async (photo, i) => {
        if (!photo.url) return null;
        const photoUrl = await getPresignedGetUrl(photo.url, 3600);
        return {
          id: `${s.identifier}-${i}`,
          firstName: s.firstName,
          wish: photo.wish,
          photoUrl,
          submittedAt: s.submittedAt,
        };
      });

      const clips = s.clips || {};
      const videoCards = VIDEO_PROMPT_NUMS
        .map((n) => {
          const clipKey = clips[`p${n}`];
          if (!clipKey) return null;
          return getPresignedGetUrl(clipKey, 3600).then((videoUrl) => ({
            id: `${s.identifier}-v${n}`,
            firstName: s.firstName,
            videoUrl,
            promptNum: n,
            submittedAt: s.submittedAt,
          }));
        })
        .filter(Boolean);

      return [...photoCards, ...videoCards];
    });

    const cards = (await Promise.all(cardPromises)).filter(Boolean);

    return res.json({ cards });
  } catch (err) {
    console.error('GET /gallery error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
