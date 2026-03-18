# video-server

Backend API for the Sharon Birthday Surprise project. Handles video clip and photo submissions from guests, storing files in AWS S3 and metadata in MongoDB.

## Stack

- Node.js + Express
- MongoDB (Mongoose)
- AWS S3 (presigned URLs for uploads/downloads)
- Deployed on Railway

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in values:
   ```bash
   cp .env.example .env
   ```

3. Start the server:
   ```bash
   npm start       # production
   npm run dev     # development (watch mode)
   ```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `MONGODB_URI` | MongoDB connection string |
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `AWS_REGION` | S3 bucket region |
| `S3_BUCKET_NAME` | S3 bucket name |
| `ADMIN_PASSWORD` | Password for admin login |
| `ADMIN_JWT_SECRET` | Secret for signing admin JWTs |

## API

### Public

| Method | Route | Description |
|---|---|---|
| `GET` | `/deadline` | Get current submission deadline |
| `POST` | `/session` | Check or create a user session |
| `POST` | `/presign` | Get presigned S3 URL for video upload |
| `POST` | `/submit-clip` | Mark a clip as submitted |
| `POST` | `/presign-photo` | Get presigned S3 URL for photo upload |
| `POST` | `/submit-photo` | Save photo entry to MongoDB |

### Admin

All admin routes require `Authorization: Bearer <token>`.

| Method | Route | Description |
|---|---|---|
| `POST` | `/admin/login` | Authenticate and receive JWT |
| `GET` | `/admin/deadline` | Get deadline |
| `POST` | `/admin/deadline` | Set deadline |
| `GET` | `/admin/submissions` | List all submissions |
| `GET` | `/admin/submission/:identifier` | Get full submission with presigned URLs |
| `GET` | `/admin/download` | Stream ZIP of clips or photos |

`/admin/download` query params: `?prompt=1`, `?prompt=photos`, `?all=true`

## S3 Structure

```
sharon-bday/
  prompt-1/   ← video clips for prompt 1
  prompt-2/
  prompt-3/
  prompt-4/
  photos/     ← guest photos
```
