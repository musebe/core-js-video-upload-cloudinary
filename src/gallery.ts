/**
 * @fileoverview Gallery page controller.
 *
 * Reads videos from localStorage, renders cards with thumbnails, AI tags, and
 * toggleable transcripts fetched live from Cloudinary's CDN.
 */

import type { StoredVideo } from './types.js';
import { formatBytes, formatDuration } from './utils.js';
import { renameVideo, renameRaw, deleteVideo, deleteRaw, fetchVideoTags } from './cloudinary-admin.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'cld_uploads';

function cloudName(): string {
  const name = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
  if (!name) throw new Error(
    'Missing VITE_CLOUDINARY_CLOUD_NAME.\nCopy .env.example to .env and fill in your cloud name.',
  );
  return name;
}

// ─── URL builders ─────────────────────────────────────────────────────────────

function thumbnailUrl(secureUrl: string): string {
  return secureUrl
    .replace('/video/upload/', '/video/upload/w_640,h_360,c_fill,so_0,q_auto,f_jpg/')
    .replace(/\.[^.]+$/, '.jpg');
}

function transcriptUrl(cloud: string, publicId: string): string {
  return `https://res.cloudinary.com/${cloud}/raw/upload/${publicId}.transcript`;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function loadVideos(): StoredVideo[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveVideos(videos: StoredVideo[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(videos));
}

// ─── Transcript ───────────────────────────────────────────────────────────────

interface TranscriptWord {
  word: string;
  start_time: number;
  end_time: number;
}

interface TranscriptSegment {
  transcript: string;
  confidence: number;
  words: TranscriptWord[];
}

async function fetchTranscript(url: string): Promise<TranscriptSegment[]> {
  const res = await fetch(url);
  if (res.status === 404 || res.status === 400) throw new Error('not_ready');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as TranscriptSegment[];
  if (!Array.isArray(data)) throw new Error('unexpected_format');
  return data;
}

function renderTranscript(
  segments: TranscriptSegment[],
  content: HTMLElement,
  videoEl: HTMLVideoElement,
): void {
  if (segments.length === 0) {
    content.innerHTML = '<p class="transcript-empty">No speech detected.</p>';
    return;
  }

  content.innerHTML = segments.map((seg) => {
    const confidence = Math.round(seg.confidence * 100);
    const confClass = confidence >= 80 ? 'high' : confidence >= 60 ? 'mid' : 'low';
    const body = seg.words.length > 0
      ? seg.words.map((w) =>
          `<span class="tw" data-s="${w.start_time}" data-e="${w.end_time}">${escapeHtml(w.word)}</span>`
        ).join(' ')
      : escapeHtml(seg.transcript);
    return `<p class="transcript-segment">
      <span class="transcript-text">${body}</span>
      <span class="transcript-conf conf-${confClass}" title="Confidence">${confidence}%</span>
    </p>`;
  }).join('');

  const wordEls = Array.from(content.querySelectorAll<HTMLElement>('.tw'));
  if (wordEls.length === 0) return;

  // Click a word to seek the video to that timestamp.
  for (const el of wordEls) {
    el.addEventListener('click', () => {
      videoEl.currentTime = parseFloat(el.dataset.s!);
      videoEl.play().catch(() => {});
    });
  }

  // Highlight the word that matches the current playback position.
  let active: HTMLElement | null = null;
  videoEl.addEventListener('timeupdate', () => {
    const t = videoEl.currentTime;
    const next = wordEls.find(
      (el) => t >= parseFloat(el.dataset.s!) && t < parseFloat(el.dataset.e!),
    ) ?? null;
    if (next === active) return;
    active?.classList.remove('tw--active');
    next?.classList.add('tw--active');
    active = next;
    next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Card builder ─────────────────────────────────────────────────────────────

function buildCard(video: StoredVideo, cloud: string, template: HTMLTemplateElement): HTMLElement {
  const node = template.content.cloneNode(true) as DocumentFragment;
  const card = node.querySelector<HTMLElement>('.video-card')!;

  // Thumbnail
  const img = card.querySelector<HTMLImageElement>('.card-thumb__img')!;
  img.src = thumbnailUrl(video.secureUrl);
  img.alt = `Thumbnail for ${publicIdFilename(video.publicId)}`;

  card.querySelector<HTMLElement>('.thumb-badge--duration')!.textContent =
    video.duration > 0 ? formatDuration(video.duration) : '?:??';
  card.querySelector<HTMLElement>('.thumb-badge--format')!.textContent =
    video.format.toUpperCase();

  // Play / inline player
  const thumbWrap = card.querySelector<HTMLElement>('.card-thumb')!;
  const playBtn = card.querySelector<HTMLButtonElement>('.card-play-btn')!;
  const playerWrap = card.querySelector<HTMLElement>('.card-player')!;
  const videoEl = card.querySelector<HTMLVideoElement>('.card-video')!;

  let activeTrack: HTMLTrackElement | null = null;

  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    thumbWrap.hidden = true;
    playerWrap.hidden = false;

    videoEl.src = video.secureUrl;
    videoEl.crossOrigin = 'anonymous';

    activeTrack = document.createElement('track');
    activeTrack.kind = 'subtitles';
    activeTrack.label = 'English';
    activeTrack.srclang = 'en';
    activeTrack.src = `https://res.cloudinary.com/${cloud}/raw/upload/${video.publicId}.vtt`;
    activeTrack.default = true;
    videoEl.appendChild(activeTrack);

    videoEl.play().catch(() => {});
  });

  // Title + inline rename
  const displayName = video.displayName ?? publicIdFilename(video.publicId);
  const titleEl = card.querySelector<HTMLElement>('.card-title')!;
  titleEl.textContent = displayName;
  titleEl.title = displayName;

  const editBtn = card.querySelector<HTMLButtonElement>('.btn-edit-name')!;
  const renameForm = card.querySelector<HTMLFormElement>('.rename-form')!;
  const renameInput = card.querySelector<HTMLInputElement>('.rename-input')!;
  const renameCancel = card.querySelector<HTMLButtonElement>('.rename-cancel')!;
  const renameError = card.querySelector<HTMLElement>('.rename-error')!;
  const renameSubmit = card.querySelector<HTMLButtonElement>('.rename-save')!;

  const openRenameForm = () => {
    renameInput.value = titleEl.textContent ?? '';
    renameError.hidden = true;
    renameForm.hidden = false;
    editBtn.hidden = true;
    renameInput.focus();
    renameInput.select();
  };

  const closeRenameForm = () => {
    renameForm.hidden = true;
    editBtn.hidden = false;
    renameError.hidden = true;
  };

  editBtn.addEventListener('click', openRenameForm);
  renameCancel.addEventListener('click', closeRenameForm);

  renameForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const newName = renameInput.value.trim().replace(/\s+/g, '-').toLowerCase();
    if (!newName || newName === publicIdFilename(video.publicId)) {
      closeRenameForm();
      return;
    }

    const folder = video.publicId.includes('/')
      ? video.publicId.substring(0, video.publicId.lastIndexOf('/') + 1)
      : '';
    const toPublicId = `${folder}${newName}`;

    renameSubmit.disabled = true;
    renameSubmit.textContent = 'Saving…';
    renameError.hidden = true;

    try {
      const oldPublicId = video.publicId;
      const confirmedId = await renameVideo(oldPublicId, toPublicId);

      // Rebuild URL from scratch — avoids version-number prefix breaking string replace.
      const newSecureUrl = `https://res.cloudinary.com/${cloud}/video/upload/${confirmedId}.${video.format}`;

      video.publicId = confirmedId;
      video.secureUrl = newSecureUrl;
      video.displayName = newName;

      const all = loadVideos().map((v) => (v.publicId === oldPublicId ? video : v));
      saveVideos(all);

      // Rename supplementary raw files (VTT, SRT, transcript) — silently skip any that don't exist.
      const oldBase = oldPublicId;
      const newBase = confirmedId;
      const rawSuffixes = ['.transcript', '.vtt', '.en-US.vtt', '.srt', '.en-US.srt'];
      await Promise.allSettled(
        rawSuffixes.map((s) => renameRaw(`${oldBase}${s}`, `${newBase}${s}`)),
      );

      // Refresh all DOM references that embed the old URL or filename.
      titleEl.textContent = newName;
      titleEl.title = newName;
      img.src = thumbnailUrl(newSecureUrl);
      img.alt = `Thumbnail for ${newName}`;
      openBtn.href = newSecureUrl;
      if (videoEl.src) videoEl.src = newSecureUrl;
      if (activeTrack) activeTrack.src = `https://res.cloudinary.com/${cloud}/raw/upload/${confirmedId}.vtt`;

      closeRenameForm();
    } catch (err) {
      const msg = (err as Error).message;
      renameError.textContent = msg.includes('not found') || msg.includes('Resource not found')
        ? 'Video not found in Cloudinary — it may have been renamed already. Reload the page.'
        : msg;
      renameError.hidden = false;
    } finally {
      renameSubmit.disabled = false;
      renameSubmit.textContent = 'Save';
    }
  });

  card.querySelector<HTMLElement>('.card-meta')!.textContent =
    [formatBytes(video.bytes), video.width ? `${video.width}×${video.height}` : null]
      .filter(Boolean).join(' · ');

  // Tags
  const tagsList = card.querySelector<HTMLElement>('.tags-list')!;
  const tagsRefreshBtn = card.querySelector<HTMLButtonElement>('.tags-refresh-btn')!;

  function renderTags(tags: string[]): void {
    if (tags.length > 0) {
      tagsList.innerHTML = tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('');
      tagsRefreshBtn.hidden = true;
    } else if (video.addonLimitReached) {
      tagsList.innerHTML = '<span class="tags-quota">Addon quota reached — tags unavailable.</span>';
      tagsRefreshBtn.hidden = true;
    } else {
      tagsList.innerHTML = '<span class="tags-pending">No tags yet — Cloudinary processes them async.</span>';
      tagsRefreshBtn.hidden = false;
    }
  }

  renderTags(video.tags);

  tagsRefreshBtn.addEventListener('click', async () => {
    tagsRefreshBtn.disabled = true;
    tagsRefreshBtn.textContent = '↻ Refreshing…';
    try {
      const tags = await fetchVideoTags(video.publicId);
      video.tags = tags;
      const all = loadVideos().map((v) => (v.publicId === video.publicId ? video : v));
      saveVideos(all);
      renderTags(tags);
    } catch {
      tagsRefreshBtn.disabled = false;
      tagsRefreshBtn.textContent = '↻ Refresh tags';
    }
  });

  // Transcript toggle
  const toggle = card.querySelector<HTMLButtonElement>('.transcript-toggle')!;
  const panel = card.querySelector<HTMLElement>('.transcript-panel')!;
  const content = card.querySelector<HTMLElement>('.transcript-content')!;
  const label = toggle.querySelector<HTMLElement>('.transcript-toggle__label')!;
  let fetched = false;

  toggle.addEventListener('click', async () => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';

    if (isOpen) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      label.textContent = 'Show transcript';
      toggle.classList.remove('open');
      return;
    }

    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    label.textContent = 'Hide transcript';
    toggle.classList.add('open');

    if (fetched) return;
    fetched = true;

    if (video.addonLimitReached) {
      content.innerHTML = '<p class="transcript-quota">Addon quota was reached when this video was uploaded — transcript was not generated.</p>';
      return;
    }

    content.innerHTML = '<div class="transcript-loading"><span class="spinner"></span> Fetching transcript…</div>';

    try {
      const segments = await fetchTranscript(transcriptUrl(cloud, video.publicId));
      renderTranscript(segments, content, videoEl);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'not_ready') {
        content.innerHTML = '<p class="transcript-pending">⏳ Transcript is still processing — check back in a moment.</p>';
      } else {
        content.innerHTML = `<p class="transcript-error">Could not load transcript: ${escapeHtml(msg)}</p>`;
      }
      fetched = false; // allow retry
    }
  });

  // Open / delete actions
  const openBtn = card.querySelector<HTMLAnchorElement>('.card-open-btn')!;
  openBtn.href = video.secureUrl;

  const deleteBtn = card.querySelector<HTMLButtonElement>('.card-delete-btn')!;

  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Permanently delete "${video.displayName ?? publicIdFilename(video.publicId)}" from Cloudinary?`)) return;

    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';

    try {
      await deleteVideo(video.publicId);

      const rawSuffixes = ['.transcript', '.vtt', '.en-US.vtt', '.srt', '.en-US.srt'];
      await Promise.allSettled(rawSuffixes.map((s) => deleteRaw(`${video.publicId}${s}`)));

      const current = loadVideos().filter((v) => v.publicId !== video.publicId);
      saveVideos(current);

      card.classList.add('removing');
      setTimeout(() => {
        card.remove();
        updateCount(loadVideos().length);
        showEmptyIfNeeded();
      }, 300);
    } catch (err) {
      deleteBtn.disabled = false;
      deleteBtn.innerHTML = '<span aria-hidden="true">🗑</span> Remove';
      alert(`Delete failed: ${(err as Error).message}`);
    }
  });

  return card;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function publicIdFilename(publicId: string): string {
  return publicId.split('/').pop() ?? publicId;
}

function updateCount(n: number): void {
  const el = document.getElementById('video-count');
  if (el) el.textContent = n === 1 ? '1 video' : `${n} videos`;
}

function showEmptyIfNeeded(): void {
  const grid = document.getElementById('video-grid')!;
  const empty = document.getElementById('empty-state')!;
  const toolbar = document.getElementById('gallery-toolbar')!;
  const hasCards = grid.querySelector('.video-card') !== null;
  empty.hidden = hasCards;
  toolbar.hidden = !hasCards;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function init(): void {
  const configBanner = document.getElementById('config-banner')!;
  const configMsg = document.getElementById('config-error-message')!;

  let cloud: string;
  try {
    cloud = cloudName();
    configBanner.hidden = true;
  } catch (e) {
    configMsg.textContent = (e as Error).message;
    document.getElementById('gallery-toolbar')!.hidden = true;
    document.getElementById('empty-state')!.hidden = true;
    return;
  }

  const template = document.getElementById('card-template') as HTMLTemplateElement;
  const grid = document.getElementById('video-grid')!;
  const emptyState = document.getElementById('empty-state')!;
  const toolbar = document.getElementById('gallery-toolbar')!;
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const clearAllBtn = document.getElementById('btn-clear-all')!;

  let videos = loadVideos();

  function render(list: StoredVideo[]): void {
    grid.innerHTML = '';
    for (const v of list) {
      grid.appendChild(buildCard(v, cloud, template));
    }
    updateCount(videos.length);
    emptyState.hidden = list.length > 0;
    toolbar.hidden = videos.length === 0;
  }

  render(videos);

  // Search / filter
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) { render(videos); return; }
    const filtered = videos.filter(
      (v) =>
        publicIdFilename(v.publicId).toLowerCase().includes(q) ||
        v.tags.some((t) => t.toLowerCase().includes(q)),
    );
    render(filtered);
  });

  // Clear all
  clearAllBtn.addEventListener('click', () => {
    if (!confirm('Remove all videos from the gallery? This only clears local history.')) return;
    saveVideos([]);
    videos = [];
    render([]);
  });
}

document.addEventListener('DOMContentLoaded', init);
