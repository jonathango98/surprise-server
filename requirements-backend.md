# requirements-backend.md
# Sharon Birthday Surprise — Backend

## Stack
- Node.js + Express
- Hosted on Railway
- MongoDB (existing instance)
- AWS S3 (1 bucket)
- No email service

---

## Environment Variables
```
PORT=3000
MONGODB_URI=mongodb+srv://...
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-southeast-1
S3_BUCKET_NAME=sharon-bday
ADMIN_PASSWORD=
ADMIN_JWT_SECRET=
```

---

## MongoDB

### Database: `sharon-bday`

#### Collection: `submissions`
```json
{
  "_id": "ObjectId",
  "firstName": "John",
  "lastName": "Doe",
  "location": "Jakarta",
  "identifier": "john-doe-jakarta",
  "submittedAt": "2025-03-18T10:00:00Z",
  "completedPrompts": [1, 2, 3],
  "clips": {
    "p1": "sharon-bday/prompt-1/john-doe-jakarta-p1.mp4",
    "p2": "sharon-bday/prompt-2/john-doe-jakarta-p2.mp4",
    "p3": "sharon-bday/prompt-3/john-doe-jakarta-p3.mp4",
    "p4": "sharon-bday/prompt-4/john-doe-jakarta-p4.mp4"
  },
  "photos": [
    { "url": "sharon-bday/photos/john-doe-jakarta-1.jpg", "wish": "Miss you!" },
    { "url": "sharon-bday/photos/john-doe-jakarta-2.jpg", "wish": "" }
  ]
}
```

#### Collection: `settings`
```json
{
  "_id": "ObjectId",
  "key": "deadline",
  "value": "2025-04-21T23:59:00-07:00"
}
```
Single document, upserted on update.

---

## S3 Structure
```
sharon-bday/
  prompt-1/
    john-doe-jakarta-p1.mp4
    john-doe-jakarta-p1-2.mp4   ← retake version
  prompt-2/
    john-doe-jakarta-p2.mp4
  prompt-3/
    john-doe-jakarta-p3.mp4
  prompt-4/
    john-doe-jakarta-p4.mp4
  photos/
    john-doe-jakarta-1.jpg
    john-doe-jakarta-2.jpg
```

**Retake logic:** append `-{n}` suffix to new version. MongoDB `clips.p{n}` always points to the latest key.

---

## API Routes

### Public Routes

#### `GET /deadline`
Returns current deadline.
```json
{ "deadline": "2025-04-21T23:59:00-07:00" }
```

---

#### `POST /session`
Check or create a submission session.

**Request:**
```json
{ "firstName": "John", "lastName": "Doe", "location": "Jakarta" }
```

**Logic:**
- Normalize: lowercase, trim, build `identifier = john-doe-jakarta`
- Query `submissions` by `identifier`
- If found → return existing progress
- If not found → create new document

**Response:**
```json
{
  "isReturning": true,
  "completedPrompts": [1, 2],
  "identifier": "john-doe-jakarta"
}
```

---

#### `POST /presign`
Generate S3 presigned PUT URL for a video clip.

**Request:**
```json
{
  "identifier": "john-doe-jakarta",
  "prompt": 1
}
```

**Logic:**
- Check deadline — reject if past
- Build S3 key: `sharon-bday/prompt-{n}/{identifier}-p{n}.mp4`
- If retake (prompt already in `completedPrompts`): append `-{retakeCount+1}` suffix
- Generate presigned PUT URL (expires 15 min)
- Return key + URL

**Response:**
```json
{
  "uploadUrl": "https://s3.amazonaws.com/...",
  "s3Key": "sharon-bday/prompt-1/john-doe-jakarta-p1-2.mp4"
}
```

**Rate limit:** 10 requests per IP per 10 minutes.
**File size:** enforced via S3 presigned URL `Content-Length` condition (max 50MB).

---

#### `POST /submit-clip`
Mark a clip as submitted after successful S3 upload.

**Request:**
```json
{
  "identifier": "john-doe-jakarta",
  "prompt": 1,
  "s3Key": "sharon-bday/prompt-1/john-doe-jakarta-p1.mp4"
}
```

**Logic:**
- Update `submissions.clips.p{n}` to new S3 key
- Add prompt number to `completedPrompts` if not already present

**Response:**
```json
{ "success": true, "completedPrompts": [1] }
```

---

#### `POST /presign-photo`
Generate S3 presigned PUT URL for a photo.

**Request:**
```json
{ "identifier": "john-doe-jakarta" }
```

**Logic:**
- Check deadline — reject if past
- Count existing photos for identifier to determine suffix
- Build S3 key: `sharon-bday/photos/{identifier}-{n}.jpg`
- Generate presigned PUT URL (expires 15 min)

**Response:**
```json
{
  "uploadUrl": "https://s3.amazonaws.com/...",
  "s3Key": "sharon-bday/photos/john-doe-jakarta-3.jpg"
}
```

**File size:** max 10MB via presigned URL condition.

---

#### `POST /submit-photo`
Save photo entry to MongoDB after successful S3 upload.

**Request:**
```json
{
  "identifier": "john-doe-jakarta",
  "s3Key": "sharon-bday/photos/john-doe-jakarta-3.jpg",
  "wish": "Happy birthday Sharon!"
}
```

**Logic:**
- Push `{ url: s3Key, wish }` to `submissions.photos` array

**Response:**
```json
{ "success": true }
```

---

### Admin Routes

All admin routes require `Authorization: Bearer {token}` header.

#### `POST /admin/login`
**Request:**
```json
{ "password": "yourpassword" }
```
**Logic:** Compare against `ADMIN_PASSWORD` env var. Return signed JWT.

**Response:**
```json
{ "token": "eyJ..." }
```

---

#### `GET /admin/deadline`
Returns current deadline (same as public `/deadline` but authenticated).

---

#### `POST /admin/deadline`
Set or update deadline.

**Request:**
```json
{ "deadline": "2025-04-21T23:59:00-07:00" }
```
**Logic:** Upsert `settings` collection document where `key = "deadline"`.

---

#### `GET /admin/submissions`
Returns all submissions with metadata.

**Response:**
```json
[
  {
    "identifier": "john-doe-jakarta",
    "firstName": "John",
    "lastName": "Doe",
    "location": "Jakarta",
    "submittedAt": "2025-03-18T10:00:00Z",
    "completedPrompts": [1, 2, 3, 4],
    "photoCount": 3
  }
]
```

---

#### `GET /admin/submission/:identifier`
Returns full detail for one submission including presigned GET URLs for all clips and photos.

**Logic:**
- Fetch submission from MongoDB
- Generate presigned GET URLs (expires 1 hr) for each clip and photo S3 key

**Response:**
```json
{
  "identifier": "john-doe-jakarta",
  "clips": {
    "p1": "https://presigned-url...",
    "p2": "https://presigned-url..."
  },
  "photos": [
    { "url": "https://presigned-url...", "wish": "Miss you!" }
  ]
}
```

---

#### `GET /admin/download`
Stream a ZIP of clips or photos.

**Query params:**
- `?prompt=1` — ZIP all clips in `sharon-bday/prompt-1/`
- `?prompt=photos` — ZIP all photos in `sharon-bday/photos/`
- `?all=true` — ZIP entire `sharon-bday/` bucket

**Logic:**
- List S3 objects by prefix
- Stream each object into a ZIP using `archiver`
- Pipe ZIP to response

**Response:** `Content-Type: application/zip`, streamed download.

---

## Middleware

- **CORS** — allow Netlify frontend origin only
- **Rate Limiter** — `express-rate-limit`, 10 req/10min per IP on `/presign` and `/presign-photo`
- **Admin Auth** — JWT verification middleware on all `/admin/*` routes
- **Deadline Guard** — reusable middleware checking `settings` collection, applied to `/presign` and `/presign-photo`

---

## Dependencies
```json
{
  "express": "^4.18",
  "mongoose": "^7",
  "@aws-sdk/client-s3": "^3",
  "@aws-sdk/s3-request-presigner": "^3",
  "archiver": "^6",
  "jsonwebtoken": "^9",
  "express-rate-limit": "^7",
  "cors": "^2",
  "dotenv": "^16"
}
```
