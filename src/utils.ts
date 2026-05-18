/**
 * @fileoverview Pure utility functions — no side-effects, no DOM access.
 * Every function here is independently testable and reusable.
 */

import type { ValidationResult } from './types.js';

// ─── Identity ─────────────────────────────────────────────────────────────────

/**
 * Generates a RFC 4122 UUID v4 string used as `X-Unique-Upload-Id`.
 *
 * Uses `crypto.randomUUID()` when available (modern browsers) and falls back
 * to a Math.random-based implementation for broader compatibility.
 *
 * @returns A hyphen-delimited UUID string, e.g. `"550e8400-e29b-41d4-a716-446655440000"`.
 */
export function generateUploadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — adequate entropy for a session-scoped upload ID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Converts a raw byte count into a human-readable string.
 *
 * @param bytes - Number of bytes (must be ≥ 0).
 * @param decimals - Decimal places to show (default 2).
 * @returns Formatted string such as `"12.50 MB"` or `"1.00 GB"`.
 *
 * @example
 * formatBytes(10485760) // "10.00 MB"
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(decimals)} ${units[i]}`;
}

/**
 * Formats a duration given in seconds into a `mm:ss` or `hh:mm:ss` string.
 *
 * @param totalSeconds - Non-negative number of seconds.
 * @returns Human-readable duration, e.g. `"1:23"` or `"1:02:03"`.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/**
 * Formats a remaining-time estimate into a natural-language string.
 *
 * @param seconds - Estimated seconds remaining; -1 means "calculating".
 * @returns E.g. `"about 2 min"`, `"less than a minute"`, or `"Calculating…"`.
 */
export function formatEta(seconds: number): string {
  if (seconds < 0) return 'Calculating…';
  if (seconds < 10) return 'Almost done';
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} min`;
}

/**
 * Converts bytes-per-second into a display-friendly upload speed string.
 *
 * @param bytesPerSec - Throughput in bytes per second.
 * @returns E.g. `"1.50 MB/s"` or `"512.00 KB/s"`.
 */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec, 2)}/s`;
}

// ─── File validation ──────────────────────────────────────────────────────────

/** Accepted MIME types for video uploads. */
const ACCEPTED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',   // AVI
  'video/x-matroska',  // MKV
  'video/mpeg',
  'video/3gpp',
  'video/x-flv',
]);

/** Hard upper limit: 5 GB. Cloudinary's free tier supports up to 10 GB. */
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Validates a `File` object before the upload pipeline starts.
 *
 * Checks are ordered from cheapest to most expensive so we can fail fast.
 *
 * @param file - The `File` selected by the user.
 * @returns A {@link ValidationResult} with `valid: true` on success, or
 *          `valid: false` and a human-readable `reason` on failure.
 */
export function validateVideoFile(file: File): ValidationResult {
  if (!file) {
    return { valid: false, reason: 'No file selected.' };
  }

  // Validate by MIME type, with a filename-extension fallback for browsers
  // that report `application/octet-stream` for unknown types.
  const mimeOk = ACCEPTED_VIDEO_TYPES.has(file.type);
  const extOk = /\.(mp4|webm|ogg|mov|avi|mkv|mpeg|mpg|3gp|flv)$/i.test(file.name);

  if (!mimeOk && !extOk) {
    return {
      valid: false,
      reason: `Unsupported file type "${file.type || 'unknown'}". Please upload a video file (MP4, WebM, MOV, AVI, etc.).`,
    };
  }

  if (file.size === 0) {
    return { valid: false, reason: 'The selected file is empty.' };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      reason: `File too large (${formatBytes(file.size)}). Maximum allowed size is ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
    };
  }

  return { valid: true };
}

// ─── Crypto ───────────────────────────────────────────────────────────────────

/** SHA-1 hex digest via the Web Crypto API. Used for Cloudinary API signatures. */
export async function sha1Hex(message: string): Promise<string> {
  const encoded = new TextEncoder().encode(message);
  const buffer = await crypto.subtle.digest('SHA-1', encoded);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

/**
 * Clamps a number within an inclusive range.
 *
 * @param value - The number to clamp.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns `value` clamped to `[min, max]`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Computes an exponential back-off delay in milliseconds.
 *
 * Formula: `base * 2^attempt` capped at `maxMs`.
 *
 * @param attempt - Zero-based retry attempt number.
 * @param baseMs - Base delay in ms (default 500).
 * @param maxMs - Maximum delay cap in ms (default 30 000).
 * @returns Milliseconds to wait before the next attempt.
 */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  return clamp(baseMs * Math.pow(2, attempt), baseMs, maxMs);
}

/**
 * Returns a promise that resolves after `ms` milliseconds.
 * Used to implement back-off pauses between retries.
 *
 * @param ms - Number of milliseconds to sleep.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
