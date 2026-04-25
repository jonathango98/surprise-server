import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    identifier: { type: String, required: true },
    name: { type: String, required: true },
    detail: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

export const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
