/**
 * @fileoverview Shared TypeScript type definitions for the video upload application.
 * All domain types live here to keep the rest of the codebase import-clean.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Runtime configuration resolved from environment variables.
 * Set `VITE_CLOUDINARY_CLOUD_NAME` and `VITE_CLOUDINARY_UPLOAD_PRESET` in `.env`.
 */
export interface CloudinaryConfig {
  /** Cloudinary cloud name (e.g. "my-cloud"). */
  cloudName: string;
  /** Unsigned upload preset name configured in the Cloudinary dashboard. */
  uploadPreset: string;
}

/** Options controlling upload behaviour. */
export interface UploadOptions {
  /** Bytes per chunk. Minimum 5 MB per Cloudinary spec; default 10 MB. */
  chunkSize: number;
  /** Max retry attempts per chunk. */
  maxRetries: number;
  /** Base delay (ms) between retries — doubled each attempt. */
  retryDelayMs: number;
  /** Extra key/value pairs appended to every chunk's FormData (folder, addons, etc.). */
  params?: Record<string, string>;
}

// ─── Upload lifecycle ──────────────────────────────────────────────────────────

/** All possible states for a running upload session. */
export type UploadStatus =
  | 'idle'
  | 'uploading'
  | 'paused'
  | 'processing'
  | 'complete'
  | 'error'
  | 'cancelled';

/**
 * Snapshot of upload progress emitted on every chunk completion.
 */
export interface UploadProgress {
  /** 1-based index of the chunk that just finished. */
  currentChunk: number;
  /** Total number of chunks for this file. */
  totalChunks: number;
  /** Bytes successfully transferred so far. */
  bytesUploaded: number;
  /** Total file size in bytes. */
  totalBytes: number;
  /** Overall percentage complete (0–100). */
  percentage: number;
  /** Current throughput in bytes per second. */
  speedBytesPerSec: number;
  /** Estimated seconds remaining (-1 when unknown). */
  etaSeconds: number;
  /** Current lifecycle state. */
  status: UploadStatus;
}

/**
 * Metadata about a single chunk ready to be uploaded.
 */
export interface ChunkDescriptor {
  /** 0-based chunk index. */
  index: number;
  /** Byte offset where this chunk starts. */
  start: number;
  /** Byte offset where this chunk ends (inclusive). */
  end: number;
  /** Total file size — required by the `Content-Range` header. */
  totalBytes: number;
  /** Binary content of this chunk. */
  blob: Blob;
}

// ─── Result ───────────────────────────────────────────────────────────────────

/** Successful upload result returned by Cloudinary after all chunks are assembled. */
export interface UploadResult {
  publicId: string;
  secureUrl: string;
  duration: number;
  width: number;
  height: number;
  format: string;
  bytes: number;
  createdAt: string;
  /** Auto-assigned tags from Google Video Tagging addon (empty when addon is off). */
  tags: string[];
  /** True when the upload fell back to a signed request due to an addon quota limit. */
  addonLimitReached?: boolean;
}

/** Shape persisted to localStorage so the gallery can reconstruct videos. */
export interface StoredVideo {
  publicId: string;
  secureUrl: string;
  duration: number;
  width: number;
  height: number;
  format: string;
  bytes: number;
  createdAt: string;
  tags: string[];
  /** Browser-side timestamp recorded at upload completion. */
  savedAt: string;
  /** User-defined friendly name; overrides the raw public ID in the gallery. */
  displayName?: string;
  /** True when addon quota was reached at upload time — tags and transcript unavailable. */
  addonLimitReached?: boolean;
}

// ─── Callbacks ────────────────────────────────────────────────────────────────

/**
 * Event callbacks wired into the uploader.
 * All are optional — attach only the ones you need.
 */
export interface UploadCallbacks {
  /** Fired after every chunk completes with a fresh progress snapshot. */
  onProgress?: (progress: UploadProgress) => void;
  /** Fired once when the final chunk is confirmed and Cloudinary returns the asset. */
  onComplete?: (result: UploadResult) => void;
  /** Fired if an unrecoverable error terminates the upload. */
  onError?: (error: UploadError) => void;
  /** Fired when the upload is paused by the user. */
  onPause?: () => void;
  /** Fired when the upload resumes after being paused. */
  onResume?: () => void;
  /** Fired when the upload is cancelled. */
  onCancel?: () => void;
}

// ─── Error ────────────────────────────────────────────────────────────────────

/** Granular error categories to allow targeted UI messaging. */
export type UploadErrorCode =
  | 'INVALID_FILE'
  | 'NETWORK_ERROR'
  | 'CHUNK_FAILED'
  | 'CLOUDINARY_ERROR'
  | 'ADDON_RATE_LIMIT'
  | 'CANCELLED'
  | 'UNKNOWN';

/**
 * Structured error thrown by the upload engine.
 */
export interface UploadError {
  code: UploadErrorCode;
  message: string;
  /** HTTP status code when the error comes from the Cloudinary API. */
  httpStatus?: number;
  /** The chunk index that triggered the failure, if applicable. */
  chunkIndex?: number;
}

// ─── File validation ──────────────────────────────────────────────────────────

/** Result of client-side file validation before upload begins. */
export interface ValidationResult {
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
}

// ─── Raw Cloudinary API response ──────────────────────────────────────────────

/**
 * Shape of the JSON body returned by Cloudinary's upload endpoint.
 * Only the fields we actually use are declared.
 *
 * @internal
 */
/** @internal */
export interface CloudinaryApiResponse {
  public_id: string;
  secure_url: string;
  duration?: number;
  width?: number;
  height?: number;
  format: string;
  bytes: number;
  created_at: string;
  tags?: string[];
  error?: { message: string };
}
