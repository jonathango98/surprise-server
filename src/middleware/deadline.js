import { Setting } from '../models/Setting.js';

/**
 * Deadline guard middleware.
 * Rejects requests with 403 if the current deadline has passed.
 * Applied to /presign and /presign-photo.
 */
export async function deadlineGuard(req, res, next) {
  try {
    const setting = await Setting.findOne({ key: 'deadline' }).lean();

    if (!setting) {
      // No deadline set — allow through
      return next();
    }

    const deadline = new Date(setting.value);

    if (isNaN(deadline.getTime())) {
      // Malformed deadline — allow through to avoid blocking users
      console.warn('Deadline setting has an invalid date value:', setting.value);
      return next();
    }

    if (Date.now() > deadline.getTime()) {
      return res.status(403).json({ error: 'Submission deadline has passed' });
    }

    next();
  } catch (err) {
    console.error('deadlineGuard error:', err);
    // Fail open — do not block users on DB errors
    next();
  }
}
