/**
 * @fileoverview Application controller — orchestrates the UI and the upload engine.
 *
 * Responsibilities:
 * - Resolving Cloudinary config from environment variables.
 * - Wiring drag-and-drop and file-input events to the upload pipeline.
 * - Translating {@link UploadProgress} snapshots into DOM mutations.
 * - Rendering the video preview and asset metadata after a successful upload.
 */

import { ChunkUploader } from './uploader.js';
import { validateVideoFile, formatBytes, formatSpeed, formatEta, formatDuration } from './utils.js';
import type { UploadProgress, UploadResult, UploadError, CloudinaryConfig, StoredVideo } from './types.js';

const STORAGE_KEY = 'cld_uploads';

// ─── Config resolution ────────────────────────────────────────────────────────

/**
 * Reads Cloudinary credentials from Vite's injected environment variables.
 * Throws a descriptive error when either variable is missing so developers
 * see a clear message instead of a cryptic API rejection.
 */
function resolveConfig(): CloudinaryConfig {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string | undefined;

  if (!cloudName || !uploadPreset) {
    throw new Error(
      'Missing environment variables.\n\n' +
      'Copy .env.example to .env and fill in:\n' +
      '  VITE_CLOUDINARY_CLOUD_NAME=<your-cloud-name>\n' +
      '  VITE_CLOUDINARY_UPLOAD_PRESET=<your-unsigned-preset>',
    );
  }

  return { cloudName, uploadPreset };
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

/**
 * Type-safe querySelector that throws when the element is not found.
 * Avoids scattered null-checks throughout the controller.
 *
 * @param selector - CSS selector string.
 * @param root - Search root (defaults to `document`).
 */
function $<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Element not found: "${selector}"`);
  return el;
}

// ─── VideoUploadApp ───────────────────────────────────────────────────────────

/**
 * Top-level application class.
 *
 * Instantiated once in the module scope after the DOM is ready.
 * Keeps a reference to the active {@link ChunkUploader} so pause/resume/cancel
 * controls can delegate to it.
 */
class VideoUploadApp {
  // Config — set during `init()` once env variables are validated.
  private _config!: CloudinaryConfig;

  // Active uploader session — null when idle.
  private _uploader: ChunkUploader | null = null;

  // Whether an upload is underway (prevents double-starts).
  private _uploading = false;

  // Currently selected file — may be null before user picks one.
  private _selectedFile: File | null = null;

  // ─── DOM elements (resolved in `_bindElements`) ───────────────────────────

  private _dropZone!: HTMLElement;
  private _fileInput!: HTMLInputElement;
  private _fileInfo!: HTMLElement;
  private _fileName!: HTMLElement;
  private _fileSize!: HTMLElement;
  private _fileType!: HTMLElement;

  private _uploadSection!: HTMLElement;
  private _progressBar!: HTMLElement;
  private _progressFill!: HTMLElement;
  private _progressText!: HTMLElement;
  private _chunkLabel!: HTMLElement;
  private _speedLabel!: HTMLElement;
  private _etaLabel!: HTMLElement;
  private _percentLabel!: HTMLElement;

  private _btnUpload!: HTMLButtonElement;
  private _btnPause!: HTMLButtonElement;
  private _btnResume!: HTMLButtonElement;
  private _btnCancel!: HTMLButtonElement;
  private _btnReset!: HTMLButtonElement;

  private _resultSection!: HTMLElement;
  private _videoPlayer!: HTMLVideoElement;
  private _resultUrl!: HTMLAnchorElement;
  private _resultDuration!: HTMLElement;
  private _resultResolution!: HTMLElement;
  private _resultFormat!: HTMLElement;
  private _resultSize!: HTMLElement;
  private _btnCopy!: HTMLButtonElement;

  private _errorBanner!: HTMLElement;
  private _errorMessage!: HTMLElement;
  private _configBanner!: HTMLElement;

  // ─── Boot ─────────────────────────────────────────────────────────────────

  /** Initialises the application. Called once on DOMContentLoaded. */
  init(): void {
    this._bindElements();
    this._bindEvents();

    try {
      this._config = resolveConfig();
      this._configBanner.hidden = true;
    } catch (e) {
      this._showConfigError((e as Error).message);
    }
  }

  // ─── Element binding ─────────────────────────────────────────────────────

  private _bindElements(): void {
    this._dropZone = $<HTMLElement>('#drop-zone');
    this._fileInput = $<HTMLInputElement>('#file-input');
    this._fileInfo = $<HTMLElement>('#file-info');
    this._fileName = $<HTMLElement>('#file-name');
    this._fileSize = $<HTMLElement>('#file-size');
    this._fileType = $<HTMLElement>('#file-type');

    this._uploadSection = $<HTMLElement>('#upload-section');
    this._progressBar = $<HTMLElement>('#progress-bar');
    this._progressFill = $<HTMLElement>('#progress-fill');
    this._progressText = $<HTMLElement>('#progress-text');
    this._chunkLabel = $<HTMLElement>('#chunk-label');
    this._speedLabel = $<HTMLElement>('#speed-label');
    this._etaLabel = $<HTMLElement>('#eta-label');
    this._percentLabel = $<HTMLElement>('#percent-label');

    this._btnUpload = $<HTMLButtonElement>('#btn-upload');
    this._btnPause = $<HTMLButtonElement>('#btn-pause');
    this._btnResume = $<HTMLButtonElement>('#btn-resume');
    this._btnCancel = $<HTMLButtonElement>('#btn-cancel');
    this._btnReset = $<HTMLButtonElement>('#btn-reset');

    this._resultSection = $<HTMLElement>('#result-section');
    this._videoPlayer = $<HTMLVideoElement>('#video-player');
    this._resultUrl = $<HTMLAnchorElement>('#result-url');
    this._resultDuration = $<HTMLElement>('#result-duration');
    this._resultResolution = $<HTMLElement>('#result-resolution');
    this._resultFormat = $<HTMLElement>('#result-format');
    this._resultSize = $<HTMLElement>('#result-size');
    this._btnCopy = $<HTMLButtonElement>('#btn-copy-url');

    this._errorBanner = $<HTMLElement>('#error-banner');
    this._errorMessage = $<HTMLElement>('#error-message');
    this._configBanner = $<HTMLElement>('#config-banner');
  }

  // ─── Event wiring ────────────────────────────────────────────────────────

  private _bindEvents(): void {
    // Drag-and-drop.
    this._dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this._dropZone.classList.add('drag-over');
    });

    this._dropZone.addEventListener('dragleave', (e) => {
      // Only remove the class when leaving the zone entirely (not a child).
      if (!this._dropZone.contains(e.relatedTarget as Node)) {
        this._dropZone.classList.remove('drag-over');
      }
    });

    this._dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this._dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file) this._handleFileSelect(file);
    });

    // Click-to-browse.
    this._dropZone.addEventListener('click', () => this._fileInput.click());
    this._fileInput.addEventListener('change', () => {
      const file = this._fileInput.files?.[0];
      if (file) this._handleFileSelect(file);
    });

    // Upload controls.
    this._btnUpload.addEventListener('click', () => this._startUpload());
    this._btnPause.addEventListener('click', () => this._pause());
    this._btnResume.addEventListener('click', () => this._resume());
    this._btnCancel.addEventListener('click', () => this._cancel());
    this._btnReset.addEventListener('click', () => this._reset());
    this._btnCopy.addEventListener('click', () => this._copyUrl());
  }

  // ─── File selection ──────────────────────────────────────────────────────

  /**
   * Validates a picked or dropped file and updates the UI accordingly.
   *
   * @param file - The `File` object from the input or drop event.
   */
  private _handleFileSelect(file: File): void {
    this._hideError();
    this._resultSection.hidden = true;

    const validation = validateVideoFile(file);
    if (!validation.valid) {
      this._showError(validation.reason ?? 'Invalid file.');
      return;
    }

    this._selectedFile = file;
    this._fileName.textContent = file.name;
    this._fileSize.textContent = formatBytes(file.size);
    this._fileType.textContent = file.type || 'video/*';
    this._fileInfo.hidden = false;
    this._uploadSection.hidden = false;
    this._btnUpload.disabled = false;
    this._setUploadControls('idle');
  }

  // ─── Upload lifecycle ────────────────────────────────────────────────────

  /** Begins the chunked upload for the selected file. */
  private async _startUpload(): Promise<void> {
    if (!this._selectedFile || this._uploading) return;

    this._uploading = true;
    this._hideError();
    this._setUploadControls('uploading');
    this._resetProgress();

    this._uploader = new ChunkUploader(this._config, {
      chunkSize: 10 * 1024 * 1024,
      maxRetries: 3,
      params: {
        folder: 'cld_video_upload',
      },
    });

    try {
      await this._uploader.upload(this._selectedFile, {
        onProgress: (p) => this._updateProgress(p),
        onComplete: (r) => this._showResult(r),
        onPause: () => this._setUploadControls('paused'),
        onResume: () => this._setUploadControls('uploading'),
        onCancel: () => this._handleCancelled(),
        onError: (e) => this._handleUploadError(e),
      });
    } finally {
      this._uploading = false;
    }
  }

  private _pause(): void {
    this._uploader?.pause();
  }

  private _resume(): void {
    this._uploader?.resume();
    this._setUploadControls('uploading');
  }

  private _cancel(): void {
    this._uploader?.cancel();
  }

  // ─── Progress rendering ──────────────────────────────────────────────────

  /**
   * Translates an {@link UploadProgress} snapshot into DOM updates.
   * Called after every chunk completes.
   *
   * @param p - Progress snapshot emitted by the upload engine.
   */
  private _updateProgress(p: UploadProgress): void {
    const pct = p.percentage;

    this._progressFill.style.width = `${pct}%`;
    this._percentLabel.textContent = `${pct}%`;

    // Core UX requirement: "Uploading Part X of Y"
    this._chunkLabel.textContent = `Uploading part ${p.currentChunk} of ${p.totalChunks}`;

    this._progressText.textContent =
      `${formatBytes(p.bytesUploaded)} / ${formatBytes(p.totalBytes)}`;

    this._speedLabel.textContent = p.speedBytesPerSec > 0
      ? formatSpeed(p.speedBytesPerSec)
      : '—';

    this._etaLabel.textContent = formatEta(p.etaSeconds);

    this._progressBar.setAttribute('aria-valuenow', String(pct));
  }

  private _resetProgress(): void {
    this._progressFill.style.width = '0%';
    this._percentLabel.textContent = '0%';
    this._chunkLabel.textContent = 'Preparing upload…';
    this._progressText.textContent = '';
    this._speedLabel.textContent = '—';
    this._etaLabel.textContent = '—';
    this._progressBar.setAttribute('aria-valuenow', '0');
  }

  // ─── Result rendering ────────────────────────────────────────────────────

  /**
   * Renders the video player and asset metadata after a successful upload.
   *
   * @param result - Asset metadata returned by Cloudinary.
   */
  private _showResult(result: UploadResult): void {
    this._setUploadControls('complete');
    this._saveToStorage(result);

    this._videoPlayer.src = result.secureUrl;
    this._videoPlayer.poster = result.secureUrl.replace(/\.[^.]+$/, '.jpg');

    this._resultUrl.href = result.secureUrl;
    this._resultUrl.textContent = result.secureUrl;

    this._resultDuration.textContent =
      result.duration > 0 ? formatDuration(result.duration) : '—';
    this._resultResolution.textContent =
      result.width && result.height ? `${result.width} × ${result.height}` : '—';
    this._resultFormat.textContent = result.format.toUpperCase();
    this._resultSize.textContent = formatBytes(result.bytes);

    this._resultSection.hidden = false;
    this._resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    this._chunkLabel.textContent = 'Upload complete';
    this._progressFill.style.width = '100%';
    this._percentLabel.textContent = '100%';

    if (result.addonLimitReached) {
      this._showError(
        'Video uploaded successfully, but the Google Video Tagging monthly quota was reached. ' +
        'Tags and transcript are unavailable for this video. Quota resets on your next billing date.',
      );
    }
  }

  private _saveToStorage(result: UploadResult): void {
    try {
      const existing: StoredVideo[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
      const video: StoredVideo = { ...result, savedAt: new Date().toISOString() };
      // Deduplicate by publicId — keep the latest version.
      const updated = [video, ...existing.filter((v) => v.publicId !== result.publicId)];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // localStorage may be unavailable (private mode, quota exceeded, etc.) — non-fatal.
    }
  }


  private _handleCancelled(): void {
    this._uploading = false;
    this._setUploadControls('idle');
    this._showError('Upload cancelled.');
    this._resetProgress();
  }

  private _handleUploadError(err: UploadError): void {
    this._uploading = false;
    this._setUploadControls('idle');

    this._showError(`Upload failed: ${err.message}`);
  }

  // ─── Control state machine ────────────────────────────────────────────────

  /**
   * Toggles button visibility based on the current upload state.
   *
   * @param state - One of `'idle'`, `'uploading'`, `'paused'`, `'complete'`.
   */
  private _setUploadControls(state: 'idle' | 'uploading' | 'paused' | 'complete'): void {
    const show = (...btns: HTMLButtonElement[]) => btns.forEach((b) => (b.hidden = false));
    const hide = (...btns: HTMLButtonElement[]) => btns.forEach((b) => (b.hidden = true));

    switch (state) {
      case 'idle':
        show(this._btnUpload);
        hide(this._btnPause, this._btnResume, this._btnCancel, this._btnReset);
        this._btnUpload.disabled = !this._selectedFile;
        break;
      case 'uploading':
        hide(this._btnUpload, this._btnResume, this._btnReset);
        show(this._btnPause, this._btnCancel);
        break;
      case 'paused':
        hide(this._btnUpload, this._btnPause);
        show(this._btnResume, this._btnCancel);
        break;
      case 'complete':
        hide(this._btnUpload, this._btnPause, this._btnResume, this._btnCancel);
        show(this._btnReset);
        break;
    }
  }


  /** Resets the entire UI back to the initial state. */
  private _reset(): void {
    this._selectedFile = null;
    this._uploader = null;
    this._uploading = false;

    this._fileInput.value = '';
    this._fileInfo.hidden = true;
    this._uploadSection.hidden = true;
    this._resultSection.hidden = true;
    this._hideError();
    this._resetProgress();
    this._setUploadControls('idle');

    this._videoPlayer.src = '';
    this._resultUrl.href = '#';
    this._resultUrl.textContent = '';
  }

  /** Copies the hosted video URL to the clipboard and briefly flashes the button. */
  private _copyUrl(): void {
    const url = this._resultUrl.href;
    if (!url || url === '#') return;

    navigator.clipboard.writeText(url).then(() => {
      const original = this._btnCopy.textContent;
      this._btnCopy.textContent = 'Copied!';
      this._btnCopy.classList.add('copied');
      setTimeout(() => {
        this._btnCopy.textContent = original;
        this._btnCopy.classList.remove('copied');
      }, 2000);
    });
  }

  // ─── Error / config banners ──────────────────────────────────────────────

  private _showError(message: string): void {
    this._errorMessage.textContent = message;
    this._errorBanner.hidden = false;
  }

  private _hideError(): void {
    this._errorBanner.hidden = true;
  }

  private _showConfigError(message: string): void {
    this._configBanner.hidden = false;
    ($<HTMLElement>('#config-error-message')).textContent = message;
    this._btnUpload.disabled = true;
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const app = new VideoUploadApp();
document.addEventListener('DOMContentLoaded', () => app.init());
