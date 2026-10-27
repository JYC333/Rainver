import { describe, expect, it } from 'vitest';
import { HostRunOutputsUploadSchema, isLocalFileReference, rasterImageMime } from '../src/index.js';

describe('file preview contracts', () => {
  it('distinguishes local files from app routes and external links', () => {
    for (const value of ['/tmp/image.png', '/opt/repo/report.md', '/custom-root/report.txt', '/home/person/repo/file.md:12', '.agent/report.md', 'src/app.ts', './README.md', 'Makefile', '.gitignore', '/__run_output__/preview.png', 'file:///tmp/image.png']) expect(isLocalFileReference(value), value).toBe(true);
    for (const value of ['/home', '/api/v1/files/image.png', '/assets/image.png', '/projects/p/files?folder=f', 'https://example.test/a.png', '//example.test/a.png', 'javascript:alert(1)', '#section']) expect(isLocalFileReference(value), value).toBe(false);
  });
  it('keeps old text uploads compatible and accepts explicit binary encoding', () => {
    expect(HostRunOutputsUploadSchema.parse({ launch_id: 'launch', files: [{ name: 'a.txt', content: 'text' }] }).files[0]).toEqual({ name: 'a.txt', content: 'text' });
    expect(HostRunOutputsUploadSchema.safeParse({ launch_id: 'launch', files: [{ name: 'p.png', content: 'AA==', encoding: 'base64' }] }).success).toBe(true);
  });
  it('never recognizes SVG or HTML as a raster preview', () => {
    expect(rasterImageMime(new TextEncoder().encode('<svg onload="alert(1)"><image href="https://evil.test"/></svg>'))).toBeNull();
    expect(rasterImageMime(new Uint8Array([137, 80, 78, 71]))).toBeNull();
  });
});
