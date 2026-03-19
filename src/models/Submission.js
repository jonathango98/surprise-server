import mongoose from 'mongoose';

const photoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    wish: { type: String, default: '' },
  },
  { _id: false }
);

const submissionSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },
    identifier: { type: String, required: true, unique: true, index: true },
    submittedAt: { type: Date, default: Date.now },
    completedPrompts: { type: [Number], default: [] },
    clips: {
      type: Map,
      of: String,
      default: {},
    },
    photos: { type: [photoSchema], default: [] },
    status: { type: String, default: 'active' },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

export const Submission = mongoose.model('Submission', submissionSchema);
