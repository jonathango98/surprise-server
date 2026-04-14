import express from 'express';
import { Submission } from '../models/Submission.js';
import { getPresignedGetUrl } from '../s3.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /gallery
// Returns { cards: [{ id, firstName, wish, photoUrl, submittedAt }, ...] }
// No auth required — public read-only endpoint.
// ---------------------------------------------------------------------------

router.get('/gallery', async (_req, res) => {
  try {
    const submissions = await Submission.find({ status: { $ne: 'deleted' } }).lean();

    const cardPromises = submissions.flatMap((s) =>
      (s.photos || []).map(async (photo, i) => {
        if (!photo.wish || !photo.url) return null;
        const photoUrl = await getPresignedGetUrl(photo.url, 3600);
        return {
          id: `${s.identifier}-${i}`,
          firstName: s.firstName,
          wish: photo.wish,
          photoUrl,
          submittedAt: s.submittedAt,
        };
      })
    );

    const cards = (await Promise.all(cardPromises)).filter(Boolean);

    return res.json({ cards });
  } catch (err) {
    console.error('GET /gallery error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
