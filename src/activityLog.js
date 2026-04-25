import { ActivityLog } from './models/ActivityLog.js';

export async function logActivity(type, identifier, name, detail = '') {
  try {
    await ActivityLog.create({ type, identifier, name, detail });
  } catch (err) {
    console.error('[activityLog] failed to write log entry:', err);
  }
}
