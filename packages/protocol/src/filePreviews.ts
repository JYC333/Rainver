import { z } from 'zod';

/** Files explicitly copied into a Run's output directory, not an arbitrary host path. */
export const RUN_OUTPUT_LINK_PREFIX = '/__run_output__/';
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const OUTPUT_MAX_FILES = 20;
export const OUTPUT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export function rasterImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (bytes.length >= 24 && starts(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (bytes.length >= 4 && starts(255, 216, 255)) return 'image/jpeg';
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Known local paths are actions, never same-origin browser navigation. */
export function isLocalFileReference(value: string): boolean {
  if (value.startsWith(RUN_OUTPUT_LINK_PREFIX)) return true;
  if (/^(?:file:|[A-Za-z]:[\\/]|\/(?:tmp|home|workspace|work|mnt|var|Users|opt|srv|root|etc|data|private|Volumes|media|run)\/)/.test(value)) return true;
  if (/^(?:https?:|\/\/|#)/i.test(value)) return false;
  if (value.startsWith('/')) return !/^\/(?:api|assets)\//.test(value) && /\.[A-Za-z0-9]{1,12}(?::\d+)?(?:#L\d+)?$/.test(value);
  return /^(?:\.\.?\/|\.agent\/)/.test(value) || /^[^:?\s]+\.[A-Za-z0-9]{1,12}(?::\d+)?(?:#L\d+)?$/.test(value)
    || (Boolean(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/[?\s]/.test(value));
}

export const RunFilePreviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), project_id: z.string(), folder_id: z.string(), path: z.string(), line: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('image'), name: z.string(), mime_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), content_base64: z.string() }),
  z.object({ kind: z.literal('text'), name: z.string(), content: z.string() }),
]);
export type RunFilePreview = z.infer<typeof RunFilePreviewSchema>;
