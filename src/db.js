import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  mongoose.connection.on('connected', () => {
    console.log('MongoDB connected');
  });

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected');
  });

  await mongoose.connect(uri, {
    // Default heartbeat is every 10s, which counts as outbound traffic and
    // keeps resetting Railway's idle-sleep timer. Slow it down so the app
    // can actually go quiet between requests.
    heartbeatFrequencyMS: 10 * 60 * 1000,
    maxPoolSize: 5,
  });
}
