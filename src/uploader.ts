/**
 * @fileoverview Chunked video upload engine for Cloudinary.
 *
 * ## How chunked uploads work
 *
 * Large files are split into fixed-size blobs. Each blob is sent as a separate
 * HTTP POST to `https://api.cloudinary.com/v1_1/{cloudName}/video/upload` with
 * two custom headers that Cloudinary uses to stitch them back together:
 *
 * - `X-Unique-Upload-Id`: a UUID shared across all chunks of the same file.
 * - `Content-Range`: `bytes <start>-<end>/<total>` (RFC 7233 format).
 *
 * Cloudinary returns `{ done: false }` for intermediate chunks and the full
 * asset metadata once the final chunk is received.
 *
 * ## Pause / Resume / Cancel
 *
 * The engine is cooperative: it checks a `_state` flag between chunks.
 * Pause blocks the loop on a `Promise` that resolves when `resume()` is called.
 * Cancel rejects that same promise immediately.
 */

import type {
  CloudinaryConfig,
  UploadOptions,
  UploadCallbacks,
  UploadResult,
  UploadError,
  UploadStatus,
  ChunkDescriptor,
  CloudinaryApiResponse,
} from './types.js';

import { generateUploadId, backoffDelay, sleep, sha1Hex } from './utils.js';

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** Default chunk size: 10 MB (Cloudinary minimum is 5 MB). */
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;

const DEFAULT_OPTIONS: UploadOptions = {
  chunkSize: DEFAULT_CHUNK_SIZE,
  maxRetries: 3,
  retryDelayMs: 500,
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when Cloudinary returns HTTP 420 — addon quota exhausted, never retry. */
class AddonRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonRateLimitError';
  }
}

// ─── ChunkUploader ────────────────────────────────────────────────────────────

/**
 * Stateful engine that uploads a single `File` to Cloudinary in chunks.
 *
 * @example
 * ```ts
 * const uploader = new ChunkUploader(
 *   { cloudName: 'my-cloud', uploadPreset: 'my-preset' },
 *   { chunkSize: 10 * 1024 * 1024 }
 * );
 *
 * await uploader.upload(file, {
 *   onProgress: (p) => console.log(`${p.currentChunk}/${p.totalChunks}`),
 *   onComplete: (r) => console.log(r.secureUrl),
 * });
 * ```
 */
export class ChunkUploader {
  private readonly _config: CloudinaryConfig;
  private readonly _options: UploadOptions;

  private _status: UploadStatus = 'idle';
  /** Resolves the pause-gate when `resume()` is called; rejects on `cancel()`. */
  private _resumeSignal: { resolve: () => void; reject: (e: UploadError) => void } | null = null;

  // Speed tracking — rolling window over last N chunk timings.
  private _speedSamples: number[] = [];
  private _lastChunkStartTime = 0;

  constructor(config: CloudinaryConfig, options: Partial<UploadOptions> = {}) {
    this._config = config;
    this._options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Current lifecycle status of the uploader. */
  get status(): UploadStatus {
    return this._status;
  }

  /**
   * Begins the chunked upload for `file`.
   *
   * When an addon quota error (HTTP 420) is returned by Cloudinary, the upload
   * is automatically retried as a signed request without the addon preset, so
   * the video still lands in Cloudinary. The result will have `addonLimitReached: true`
   * and the gallery will show appropriate quota messages for tags and transcript.
   *
   * @param file - The video `File` to upload.
   * @param callbacks - Optional event listeners; see {@link UploadCallbacks}.
   * @throws {UploadError} on network failure, Cloudinary API error, or cancellation.
   */
  async upload(file: File, callbacks: UploadCallbacks = {}): Promise<UploadResult> {
    try {
      return await this._doUpload(file, callbacks);
    } catch (err) {
      if ((err as UploadError).code === 'ADDON_RATE_LIMIT') {
        const apiKey = import.meta.env.VITE_CLOUDINARY_API_KEY as string | undefined;
        const apiSecret = import.meta.env.VITE_CLOUDINARY_API_SECRET as string | undefined;

        if (apiKey && apiSecret) {
          console.warn('[Uploader] Addon quota exceeded — restarting as signed upload (no addon)');
          this._status = 'uploading';
          this._speedSamples = [];
          return await this._doUpload(file, callbacks, { apiKey, apiSecret });
        }
      }
      throw err;
    }
  }

  private async _doUpload(
    file: File,
    callbacks: UploadCallbacks,
    signedCreds?: { apiKey: string; apiSecret: string },
  ): Promise<UploadResult> {
    this._status = 'uploading';
    this._speedSamples = [];

    const uploadId = generateUploadId();
    const chunks = this._buildChunks(file);
    const totalChunks = chunks.length;

    // Pre-compute a signed param bundle when doing the fallback upload.
    type SignedParams = { apiKey: string; signature: string; timestamp: number; folder?: string };
    let signed: SignedParams | undefined;
    if (signedCreds) {
      const timestamp = Math.floor(Date.now() / 1000);
      const folder = this._options.params?.folder;
      const parts = [folder ? `folder=${folder}` : null, `timestamp=${timestamp}`]
        .filter(Boolean).join('&');
      const signature = await sha1Hex(`${parts}${signedCreds.apiSecret}`);
      signed = { apiKey: signedCreds.apiKey, signature, timestamp, folder };
    }

    let bytesUploaded = 0;
    let result: UploadResult | null = null;

    for (let i = 0; i < totalChunks; i++) {
      await this._waitIfPaused(callbacks);

      if (this.status === 'cancelled') {
        const err: UploadError = { code: 'CANCELLED', message: 'Upload cancelled by user.' };
        callbacks.onError?.(err);
        throw err;
      }

      const chunk = chunks[i];
      this._lastChunkStartTime = performance.now();

      const apiResponse = await this._uploadChunkWithRetry(chunk, uploadId, callbacks, signed);

      bytesUploaded += chunk.blob.size;
      this._recordSpeedSample(chunk.blob.size);

      const speed = this._rollingSpeed();
      const remaining = file.size - bytesUploaded;
      const etaSeconds = speed > 0 ? remaining / speed : -1;

      callbacks.onProgress?.({
        currentChunk: i + 1,
        totalChunks,
        bytesUploaded,
        totalBytes: file.size,
        percentage: Math.round((bytesUploaded / file.size) * 100),
        speedBytesPerSec: speed,
        etaSeconds,
        status: this._status,
      });

      if (i === totalChunks - 1) {
        result = this._toUploadResult(apiResponse, !!signed);
      }
    }

    this._status = 'complete';
    if (result) {
      callbacks.onComplete?.(result);
      return result;
    }

    const err: UploadError = { code: 'UNKNOWN', message: 'No result received from Cloudinary.' };
    callbacks.onError?.(err);
    throw err;
  }

  /**
   * Pauses the upload after the current chunk finishes.
   * The upload loop blocks until {@link resume} or {@link cancel} is called.
   */
  pause(): void {
    if (this._status === 'uploading') {
      this._status = 'paused';
    }
  }

  /**
   * Resumes a paused upload.
   * No-op if the uploader is not currently paused.
   */
  resume(): void {
    if (this._status === 'paused') {
      this._status = 'uploading';
      this._resumeSignal?.resolve();
      this._resumeSignal = null;
    }
  }

  /**
   * Permanently cancels the upload.
   * The `upload()` promise will reject with `{ code: 'CANCELLED' }`.
   */
  cancel(): void {
    if (this._status === 'uploading' || this._status === 'paused') {
      this._status = 'cancelled';
      this._resumeSignal?.reject({ code: 'CANCELLED', message: 'Upload cancelled by user.' });
      this._resumeSignal = null;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Slices `file` into an ordered array of {@link ChunkDescriptor}s.
   *
   * @param file - Source file to slice.
   */
  private _buildChunks(file: File): ChunkDescriptor[] {
    const { chunkSize } = this._options;
    const chunks: ChunkDescriptor[] = [];
    let start = 0;
    let index = 0;

    while (start < file.size) {
      const end = Math.min(start + chunkSize - 1, file.size - 1);
      chunks.push({
        index,
        start,
        end,
        totalBytes: file.size,
        blob: file.slice(start, end + 1),
      });
      start = end + 1;
      index++;
    }

    return chunks;
  }

  /**
   * Uploads a single chunk, retrying on transient failures with exponential back-off.
   * Non-retryable errors (e.g. addon rate limits) surface immediately.
   *
   * @param chunk - The chunk to send.
   * @param uploadId - The session-scoped upload ID header value.
   * @param callbacks - For surfacing per-chunk errors during retry attempts.
   * @throws {UploadError} when all retry attempts are exhausted or a fatal error occurs.
   */
  private async _uploadChunkWithRetry(
    chunk: ChunkDescriptor,
    uploadId: string,
    callbacks: UploadCallbacks,
    signed?: { apiKey: string; signature: string; timestamp: number; folder?: string },
  ): Promise<CloudinaryApiResponse> {
    const { maxRetries, retryDelayMs } = this._options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._sendChunk(chunk, uploadId, signed);
      } catch (rawError) {
        // Non-retryable errors (rate limits, invalid credentials, etc.) bubble up immediately.
        if (rawError instanceof AddonRateLimitError) {
          const err: UploadError = { code: 'ADDON_RATE_LIMIT', message: rawError.message };
          callbacks.onError?.(err);
          throw err;
        }

        const isLastAttempt = attempt === maxRetries;
        if (isLastAttempt) {
          const err: UploadError = {
            code: 'CHUNK_FAILED',
            message: `Chunk ${chunk.index + 1} failed after ${maxRetries + 1} attempts.`,
            chunkIndex: chunk.index,
          };
          callbacks.onError?.(err);
          throw err;
        }

        // Transient failure — wait with exponential back-off, then retry.
        await sleep(backoffDelay(attempt, retryDelayMs));
      }
    }

    // Unreachable; TypeScript requires an explicit return path.
    throw new Error('Unreachable');
  }

  /**
   * Performs a single HTTP POST to the Cloudinary upload endpoint.
   *
   * Uses `XMLHttpRequest` instead of `fetch` so the request is cancellable
   * and the Cloudinary endpoint sees multipart/form-data correctly.
   *
   * @param chunk - The chunk to send.
   * @param uploadId - The `X-Unique-Upload-Id` header value.
   */
  private _sendChunk(
    chunk: ChunkDescriptor,
    uploadId: string,
    signed?: { apiKey: string; signature: string; timestamp: number; folder?: string },
  ): Promise<CloudinaryApiResponse> {
    return new Promise((resolve, reject) => {
      const { cloudName, uploadPreset } = this._config;
      const url = `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`;

      const form = new FormData();
      form.append('file', chunk.blob);

      if (!signed) {
        // Unsigned upload — preset carries addon config.
        form.append('upload_preset', uploadPreset);
        if (chunk.index === 0 && this._options.params) {
          for (const [key, value] of Object.entries(this._options.params)) {
            form.append(key, value);
          }
          console.group('[Uploader] Chunk 0 — extra params');
          console.table(this._options.params);
          console.groupEnd();
        }
      } else if (chunk.index === 0) {
        // Signed fallback — no preset, no addon, just folder + auth.
        form.append('api_key', signed.apiKey);
        form.append('signature', signed.signature);
        form.append('timestamp', String(signed.timestamp));
        if (signed.folder) form.append('folder', signed.folder);
        console.warn('[Uploader] Chunk 0 — signed fallback (no addon, tags/transcript unavailable)');
      }

      console.log(
        `[Uploader] Sending chunk ${chunk.index + 1} | bytes ${chunk.start}–${chunk.end} of ${chunk.totalBytes}`,
      );

      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);

      xhr.setRequestHeader('X-Unique-Upload-Id', uploadId);
      xhr.setRequestHeader(
        'Content-Range',
        `bytes ${chunk.start}-${chunk.end}/${chunk.totalBytes}`,
      );

      xhr.onload = () => {
        let body: CloudinaryApiResponse;
        try {
          body = JSON.parse(xhr.responseText) as CloudinaryApiResponse;
        } catch {
          console.error('[Uploader] Non-JSON response:', xhr.responseText);
          reject(new Error(`Non-JSON response (HTTP ${xhr.status})`));
          return;
        }

        if (xhr.status === 420) {
          const msg = body.error?.message ?? 'Addon rate limit exceeded';
          console.warn('[Uploader] Rate limit (HTTP 420):', msg);
          reject(new AddonRateLimitError(msg));
          return;
        }

        if (xhr.status >= 400 || body.error) {
          console.error(
            `[Uploader] Cloudinary error (HTTP ${xhr.status}):`,
            body.error?.message ?? xhr.statusText,
            '\nFull response:',
            body,
          );
          reject(new Error(body.error?.message ?? `HTTP ${xhr.status}: ${xhr.statusText}`));
          return;
        }

        console.log(`[Uploader] Chunk ${chunk.index + 1} OK — done:`, !!(body as unknown as Record<string, unknown>).done);
        resolve(body);
      };

      xhr.onerror = () => {
        console.error('[Uploader] Network error on chunk', chunk.index + 1);
        reject(new Error('Network error during chunk upload.'));
      };
      xhr.ontimeout = () => {
        console.error('[Uploader] Timeout on chunk', chunk.index + 1);
        reject(new Error('Chunk upload timed out.'));
      };

      // 5-minute per-chunk timeout; generous for very large chunks on slow links.
      xhr.timeout = 5 * 60 * 1000;

      xhr.send(form);
    });
  }

  /**
   * Blocks execution if the upload is paused.
   * Returns immediately when resumed or cancelled.
   *
   * @param callbacks - Fired to surface pause/resume state changes to the UI.
   */
  private _waitIfPaused(callbacks: UploadCallbacks): Promise<void> {
    if (this._status !== 'paused') return Promise.resolve();

    callbacks.onPause?.();

    return new Promise<void>((resolve, reject) => {
      this._resumeSignal = {
        resolve: () => {
          callbacks.onResume?.();
          resolve();
        },
        reject,
      };
    });
  }

  // ─── Speed tracking ──────────────────────────────────────────────────────────

  /**
   * Records the throughput for the chunk that just completed.
   * Maintains a rolling window of the last 5 samples to smooth jitter.
   *
   * @param bytesSent - Bytes in the completed chunk.
   */
  private _recordSpeedSample(bytesSent: number): void {
    const elapsed = (performance.now() - this._lastChunkStartTime) / 1000; // seconds
    if (elapsed > 0) {
      this._speedSamples.push(bytesSent / elapsed);
      if (this._speedSamples.length > 5) this._speedSamples.shift();
    }
  }

  /**
   * Returns the rolling-average upload speed in bytes per second.
   * Returns 0 when no samples have been recorded yet.
   */
  private _rollingSpeed(): number {
    if (this._speedSamples.length === 0) return 0;
    const total = this._speedSamples.reduce((a, b) => a + b, 0);
    return total / this._speedSamples.length;
  }

  // ─── Response mapping ────────────────────────────────────────────────────────

  /**
   * Maps the raw Cloudinary API response to the cleaner {@link UploadResult} shape.
   *
   * @param raw - Raw JSON body from the final chunk response.
   */
  private _toUploadResult(raw: CloudinaryApiResponse, addonLimitReached = false): UploadResult {
    const tags = raw.tags ?? [];
    // Tags from Google Video Tagging are delivered asynchronously — they won't appear here.
    // Use the "Refresh tags" button in the gallery once Cloudinary finishes processing.
    console.group('[Uploader] Upload complete — asset info');
    console.log('public_id :', raw.public_id);
    console.log('tags (sync):', tags.length ? tags : '[] — addon processes async, refresh in gallery');
    console.log('info       :', (raw as unknown as Record<string, unknown>).info ?? 'not present in response');
    console.groupEnd();

    return {
      publicId: raw.public_id,
      secureUrl: raw.secure_url,
      duration: raw.duration ?? 0,
      width: raw.width ?? 0,
      height: raw.height ?? 0,
      format: raw.format,
      bytes: raw.bytes,
      createdAt: raw.created_at,
      tags,
      addonLimitReached: addonLimitReached || undefined,
    };
  }
}
