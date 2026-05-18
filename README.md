# Core JS — Chunked Video Upload with Cloudinary

A production-quality demo of chunked video uploads, an AI-powered gallery, and Cloudinary asset management — built with **vanilla TypeScript** and **no framework or backend**.

---

## Features

### Upload page

| Feature | Detail |
|---|---|
| **Chunked upload** | Files split into 10 MB pieces, each sent with `X-Unique-Upload-Id` + `Content-Range` headers |
| **Live progress** | Animated bar with transferred bytes, upload speed, and ETA |
| **Pause / Resume / Cancel** | Cooperative between-chunk control; safe to pause mid-upload |
| **Auto-retry** | Failed chunks retry up to 3× with exponential back-off |
| **Addon quota fallback** | On HTTP 420 (addon limit reached), automatically retries as a signed upload — video still lands in Cloudinary, just without tags/transcript |
| **Video preview** | HTML5 player streams the Cloudinary asset immediately after upload |
| **Drag & drop** | Full drag-and-drop zone with visual feedback |
| **File validation** | MIME type + extension check before upload starts |

### Gallery page

| Feature | Detail |
|---|---|
| **Video cards** | Thumbnail, duration, format badge, file size, resolution |
| **Inline playback** | Click the play button to stream the video directly in the card |
| **AI tags** | Google Video Tagging labels displayed as pills; auto-refreshed via the Admin API since tagging is async |
| **Transcripts** | Collapsible panel fetched from Cloudinary's `.transcript` JSON |
| **Word-level sync** | Each transcript word is clickable — click to seek the video; active word highlights and scrolls as the video plays |
| **Native captions** | VTT subtitle track injected into the `<video>` element for browser CC controls |
| **Rename** | Inline form that renames the video on Cloudinary and also renames all supplementary raw files (`.vtt`, `.en-US.vtt`, `.srt`, `.en-US.srt`, `.transcript`) |
| **Delete** | Permanently removes the video and all its supplementary files from Cloudinary + clears localStorage |
| **Search / filter** | Filter cards by filename or tag in real time |
| **Addon quota badge** | Cards uploaded when the tagging quota was exceeded show a clear "quota reached" notice instead of "processing…" |

---

## Prerequisites

- [Node.js](https://nodejs.org) ≥ 18
- A free [Cloudinary account](https://cloudinary.com/users/register_free)

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env
# Fill in your values — see "Environment variables" below

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment variables

Copy `.env.example` to `.env` and fill in your values:

```env
# Your Cloudinary cloud name (Dashboard → Cloud name)
VITE_CLOUDINARY_CLOUD_NAME=your-cloud-name

# An unsigned upload preset (Settings → Upload → Upload presets)
VITE_CLOUDINARY_UPLOAD_PRESET=cld_video_upload

# Admin API credentials — required for rename, delete, and tag refresh
# ⚠️  DEMO ONLY: never expose API_SECRET in a production frontend
VITE_CLOUDINARY_API_KEY=your-api-key
VITE_CLOUDINARY_API_SECRET=your-api-secret
```

---

## Cloudinary setup

### 1. Create an unsigned upload preset

1. Open [Cloudinary Console → Settings → Upload → Upload presets](https://console.cloudinary.com/settings/upload).
2. Click **Add upload preset**.
3. Set **Signing Mode** to **Unsigned**.
4. Set **Folder** to `cld_video_upload` (must match `VITE_CLOUDINARY_UPLOAD_PRESET`).
5. Save and copy the preset name into `.env`.

### 2. Enable AI addons (optional but recommended)

Both addons are configured **in the preset**, not in the upload code, because unsigned uploads cannot carry addon parameters directly.

#### Google Video Tagging (AI labels)

1. Enable the [Google AI Video Labeling Add-On](https://cloudinary.com/addons/google_video_intelligence) in your Cloudinary account.
2. In your upload preset → **Google Video Tagging** → enable and save.

> **Note:** Results are delivered **asynchronously**. Tags will not appear in the upload response. Use the **↻ Refresh tags** button in the gallery once Cloudinary finishes processing (usually within a few minutes). The free tier allows **5 operations per month**; when the quota is reached the upload still completes via a signed fallback.

#### Google Video Transcription (captions + transcript)

1. Enable the [Google AI Video Transcription Add-On](https://cloudinary.com/addons/google_automatic_video_tagging) in your Cloudinary account.
2. In your upload preset → **Auto transcription** → enable both **SRT** and **VTT** output formats → save.

> This generates `.vtt`, `.en-US.vtt`, `.srt`, `.en-US.srt`, and `.transcript` files alongside every uploaded video, used for native captions and the word-level transcript panel.

### 3. Copy API credentials

Find your **API Key** and **API Secret** under [Cloudinary Console → Dashboard → API Keys](https://console.cloudinary.com) and add them to `.env`. These are required for rename, delete, and the tag-refresh feature.

---

## How chunked uploads work

```
Browser                                   Cloudinary
  │                                            │
  │── POST /video/upload ───────────────────▶ │
  │   X-Unique-Upload-Id: <uuid>               │
  │   Content-Range: bytes 0–9 999 999/total   │
  │   body: chunk 1                            │
  │                                            │
  │◀─ { done: false } ───────────────────────│
  │                                            │
  │── POST /video/upload ───────────────────▶ │
  │   X-Unique-Upload-Id: <uuid>  ← same!      │
  │   Content-Range: bytes 10 000 000–…/total  │
  │   body: chunk 2 (last)                     │
  │                                            │
  │◀─ { done: true, secure_url: … } ─────────│
  │       full asset metadata returned once    │
  │       all chunks are assembled             │
```

On failure, the chunk is retried up to 3 times with exponential back-off (500 ms → 1 s → 2 s). If Cloudinary returns HTTP 420 (addon quota exceeded), the upload is automatically restarted as a **signed request** without the addon preset — the video is saved successfully and marked `addonLimitReached` in the gallery.

---

## Addon quota fallback

```
First attempt (unsigned preset — has addon)
  └─ 420 Quota exceeded
       │
       └─ Signed fallback (no preset, no addon)
            ├─ Video uploaded ✓
            ├─ Tags: unavailable (shown in gallery)
            └─ Transcript: unavailable (shown in gallery)
```

No additional preset is required for the fallback. The signed request uses `VITE_CLOUDINARY_API_KEY` + `VITE_CLOUDINARY_API_SECRET` directly with the `folder` parameter.

---

## Project structure

```
├── index.html              Upload page
├── gallery.html            Gallery page (video cards + transcript + tags)
├── vite.config.ts          Vite config + CORS proxy for Cloudinary Admin API
├── tsconfig.json           Strict TypeScript settings
├── .env.example            Environment variable template
└── src/
    ├── types.ts            All TypeScript interfaces and type aliases
    ├── utils.ts            Pure helpers: UUID, formatBytes, sha1Hex, file validation
    ├── uploader.ts         ChunkUploader class — upload engine with addon fallback
    ├── main.ts             Upload page controller: drag-drop, progress, result
    ├── cloudinary-admin.ts Admin API client: rename, delete, fetch tags
    ├── gallery.ts          Gallery controller: cards, transcripts, word sync
    ├── styles.css          Global design tokens, layout, components
    └── gallery.css         Gallery-specific styles: cards, transcript panel, word highlight
```

---

## Scripts

| Command | Action |
|---|---|
| `npm run dev` | Start Vite dev server on port 3000 |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run type-check` | Run TypeScript without emitting output |

---

## Architecture notes

### No backend

All upload, rename, and delete operations run directly from the browser using:
- **Unsigned uploads** via Cloudinary's Upload API (no secret required)
- **Signed Admin API calls** using `VITE_CLOUDINARY_API_SECRET` (acceptable for demos; use a backend proxy in production)
- A **Vite dev-server proxy** (`/api/cloudinary → https://api.cloudinary.com`) to avoid CORS errors on Admin API calls

### localStorage

Uploaded video metadata (public ID, URL, tags, duration, etc.) is persisted to `localStorage` under the key `cld_uploads`. The gallery reads from this store on load. Rename and delete keep it in sync.

### Cloudinary signature

Admin API calls (rename, delete, fetch tags) are signed using SHA-1 via the **Web Crypto API** (`crypto.subtle.digest`). Parameters are sorted alphabetically, concatenated as `key=value&…`, and the API secret is appended before hashing — matching Cloudinary's signature spec exactly.

---

## Security note

> `VITE_CLOUDINARY_API_SECRET` is embedded in the browser bundle. This is intentional for this **demo** — it mirrors the pattern used in Cloudinary's own SDK examples for local development. For a production app, move rename/delete/fetch calls to a server-side route so the secret never leaves your infrastructure.

---

## Built with

- [Vite](https://vitejs.dev) — dev server and bundler
- [TypeScript](https://www.typescriptlang.org) — strict types and TSDoc
- [Cloudinary Upload API](https://cloudinary.com/documentation/image_upload_api_reference) — chunked upload, video delivery
- [Cloudinary Admin API](https://cloudinary.com/documentation/admin_api) — rename, destroy, resource metadata
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) — SHA-1 signatures, UUID generation
