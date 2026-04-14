import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectDB } from './db.js';
import publicRouter from './routes/public.js';
import adminRouter from './routes/admin.js';
import galleryRouter from './routes/gallery.js';

// ---------------------------------------------------------------------------
// CORS configuration
// Allow any *.netlify.app origin plus localhost for development
// ---------------------------------------------------------------------------

const CORS_OPTIONS = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, Postman)
    if (!origin) {
      return callback(null, true);
    }

    const isNetlify = /^https:\/\/[a-zA-Z0-9-]+\.netlify\.app$/.test(origin);
    const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(origin);

    if (isNetlify || isLocalhost) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

app.set('trust proxy', 1); // Trust Railway / reverse proxy for IP detection

app.use(cors(CORS_OPTIONS));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Public routes
app.use('/', publicRouter);

// Gallery route (no auth)
app.use('/', galleryRouter);

// Admin routes
app.use('/admin', adminRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
