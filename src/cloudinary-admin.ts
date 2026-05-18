/**
 * @fileoverview Cloudinary Admin API client — rename and destroy.
 *
 * ⚠️  Demo use only. Signing in the browser exposes your API secret.
 *     In production, proxy these calls through your own backend.
 */

/** Resolved from VITE_CLOUDINARY_API_KEY / VITE_CLOUDINARY_API_SECRET env vars. */
interface AdminCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

function resolveAdminCredentials(): AdminCredentials {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
  const apiKey = import.meta.env.VITE_CLOUDINARY_API_KEY as string | undefined;
  const apiSecret = import.meta.env.VITE_CLOUDINARY_API_SECRET as string | undefined;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      'Missing VITE_CLOUDINARY_API_KEY or VITE_CLOUDINARY_API_SECRET in .env.\n' +
      'Add them to enable video renaming.',
    );
  }

  return { cloudName, apiKey, apiSecret };
}

import { sha1Hex } from './utils.js';

/**
 * Generates a Cloudinary API signature.
 *
 * Cloudinary requires params sorted alphabetically, concatenated as
 * `key=value&key=value`, then appended with the raw API secret before hashing.
 *
 * @param params - Key/value pairs to sign (excluding api_key and signature).
 * @param apiSecret - Raw API secret string.
 */
async function sign(params: Record<string, string | number | boolean>, apiSecret: string): Promise<string> {
  const sorted = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  return sha1Hex(`${sorted}${apiSecret}`);
}

async function renameAsset(
  fromPublicId: string,
  toPublicId: string,
  resourceType: 'video' | 'raw',
): Promise<string> {
  const { cloudName, apiKey, apiSecret } = resolveAdminCredentials();
  const timestamp = Math.floor(Date.now() / 1000);

  // resource_type is excluded from Cloudinary signatures (same rule as api_key and file).
  const signingParams = { from_public_id: fromPublicId, invalidate: true, timestamp, to_public_id: toPublicId };
  const signature = await sign(signingParams, apiSecret);

  const form = new FormData();
  form.append('from_public_id', fromPublicId);
  form.append('to_public_id', toPublicId);
  form.append('resource_type', resourceType);
  form.append('invalidate', 'true');
  form.append('timestamp', String(timestamp));
  form.append('api_key', apiKey);
  form.append('signature', signature);

  const res = await fetch(
    `/api/cloudinary/v1_1/${cloudName}/${resourceType}/rename`,
    { method: 'POST', body: form },
  );

  const body = await res.json() as { public_id?: string; error?: { message: string } };
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `Cloudinary rename failed (HTTP ${res.status})`);
  }
  return body.public_id!;
}

/** Renames a video asset. The delivery URL changes; callers must update stored references. */
export async function renameVideo(fromPublicId: string, toPublicId: string): Promise<string> {
  return renameAsset(fromPublicId, toPublicId, 'video');
}

/** Renames a raw asset (VTT, SRT, transcript). Throws if the asset doesn't exist. */
export async function renameRaw(fromPublicId: string, toPublicId: string): Promise<void> {
  await renameAsset(fromPublicId, toPublicId, 'raw');
}

// ─── Destroy ──────────────────────────────────────────────────────────────────

async function destroyAsset(publicId: string, resourceType: 'video' | 'raw'): Promise<void> {
  const { cloudName, apiKey, apiSecret } = resolveAdminCredentials();
  const timestamp = Math.floor(Date.now() / 1000);

  // resource_type excluded from signature per Cloudinary spec.
  const signingParams = { invalidate: true, public_id: publicId, timestamp };
  const signature = await sign(signingParams, apiSecret);

  const form = new FormData();
  form.append('public_id', publicId);
  form.append('invalidate', 'true');
  form.append('timestamp', String(timestamp));
  form.append('api_key', apiKey);
  form.append('signature', signature);

  const res = await fetch(
    `/api/cloudinary/v1_1/${cloudName}/${resourceType}/destroy`,
    { method: 'POST', body: form },
  );

  const body = await res.json() as { result?: string; error?: { message: string } };
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `Cloudinary delete failed (HTTP ${res.status})`);
  }
}

/** Permanently deletes a video asset from Cloudinary. */
export async function deleteVideo(publicId: string): Promise<void> {
  await destroyAsset(publicId, 'video');
}

/** Permanently deletes a raw asset (VTT, SRT, transcript). Silently ignores "not found". */
export async function deleteRaw(publicId: string): Promise<void> {
  try {
    await destroyAsset(publicId, 'raw');
  } catch (err) {
    if (!(err as Error).message.includes('not found')) throw err;
  }
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

/**
 * Fetches the current tags for a video asset from the Cloudinary Admin API.
 * Google Video Tagging is async — tags won't be in the upload response but will
 * appear here once Cloudinary finishes processing (usually within a few minutes).
 */
export async function fetchVideoTags(publicId: string): Promise<string[]> {
  const { cloudName, apiKey, apiSecret } = resolveAdminCredentials();
  const auth = btoa(`${apiKey}:${apiSecret}`);

  const res = await fetch(
    `/api/cloudinary/v1_1/${cloudName}/resources/video/upload/${encodeURIComponent(publicId)}`,
    { headers: { Authorization: `Basic ${auth}` } },
  );

  const body = await res.json() as { tags?: string[]; error?: { message: string } };
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }

  console.log(`[Tags] ${publicId}:`, body.tags ?? []);
  return body.tags ?? [];
}
