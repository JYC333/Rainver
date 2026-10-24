import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { previewSkillFiles } from "../src/modules/skills/skillImporter.js";
import { readSkillArchive } from "../src/modules/skills/skillArchive.js";
import { resolveSkillImportPreview } from "../src/modules/skills/service.js";

const markdown = "\ufeff---\r\nname: portable\r\ndescription: Preserve original files.\r\n---\r\nRead references/a.txt.\r\n";
const bytes = { "portable/SKILL.md": strToU8(markdown), "portable/references/a.txt": strToU8("original\r\n"), "portable/assets/image.bin": Uint8Array.from([0, 255, 128, 1]) };
const files = Object.entries(bytes).map(([path, value]) => ({ path, content_base64: Buffer.from(value).toString("base64") }));

describe("original Skill packages", () => {
  it("previews a standalone Markdown upload with the same original bytes and hash as a ZIP", async () => {
    const content_base64 = Buffer.from(markdown).toString("base64");
    const standalone = await resolveSkillImportPreview({ source_type: "upload", files: [{ path: "SKILL.md", content_base64 }] });
    const archive = await resolveSkillImportPreview({ source_type: "upload", archive_base64: Buffer.from(zipSync({ "SKILL.md": strToU8(markdown) })).toString("base64") });
    expect(standalone.package_hash).toBe(archive.package_hash);
    expect(standalone.package_contents).toEqual({ "SKILL.md": content_base64 });
    expect(standalone.normalized_skill.name).toBe("portable");
    expect(standalone.persistable).toBe(true);
    expect(standalone.package_files).toHaveLength(1);
    expect(standalone.package_files[0]).toMatchObject({ path: "SKILL.md", byte_length: Buffer.byteLength(markdown), included: true });
  });
  it("drops macOS Finder metadata from ZIP and file uploads before validation and hashing", async () => {
    const clean = await resolveSkillImportPreview({ source_type: "upload", archive_base64: Buffer.from(zipSync(bytes)).toString("base64") });
    // Finder's "Compress" adds a __MACOSX tree of AppleDouble files and may carry .DS_Store.
    const finder = zipSync({
      ...bytes,
      "portable/.DS_Store": Uint8Array.from([0, 0, 0, 1]),
      "__MACOSX/": new Uint8Array(0),
      "__MACOSX/portable/._SKILL.md": Uint8Array.from([0, 5, 22, 7]),
      "__MACOSX/portable/references/._a.txt": Uint8Array.from([0, 5, 22, 7]),
      "portable/._image.bin": Uint8Array.from([0, 5, 22, 7]),
    });
    const archive = await resolveSkillImportPreview({ source_type: "upload", archive_base64: Buffer.from(finder).toString("base64") });
    expect(archive.package_hash).toBe(clean.package_hash);
    expect(Object.keys(archive.package_contents ?? {}).sort()).toEqual(Object.keys(bytes).sort());
    const uploaded = previewSkillFiles({ files: [...files, { path: "portable/.DS_Store", content_base64: "AAAAAQ==" }, { path: "portable/._SKILL.md", content_base64: "AAUWBw==" }] });
    expect(uploaded.package_hash).toBe(clean.package_hash);
    expect(() => previewSkillFiles({ files: [{ path: ".DS_Store", content_base64: "AAAAAQ==" }] })).toThrow(/1–200 files/);
  });
  it("preserves BOM, CRLF, binary bytes and one hash across folder and ZIP import", async () => {
    const folder = previewSkillFiles({ files });
    const archive = await resolveSkillImportPreview({ source_type: "upload", archive_base64: Buffer.from(zipSync(bytes)).toString("base64") });
    expect(archive.package_hash).toBe(folder.package_hash);
    expect(archive.package_contents).toEqual(Object.fromEntries(files.map(file => [file.path, file.content_base64])));
    expect(folder.package_files.every(file => file.included)).toBe(true);
  });

  it("rejects archives truncated between local headers rather than importing a partial package", () => {
    const archive = zipSync(bytes, { level: 0 });
    const secondHeader = Buffer.from(archive).indexOf(Buffer.from([80, 75, 3, 4]), 4);
    expect(secondHeader).toBeGreaterThan(0);
    for (const end of [secondHeader, secondHeader + 10, archive.length - 22]) {
      expect(() => readSkillArchive(Buffer.from(archive.subarray(0, end)).toString("base64"))).toThrow(/incomplete|Invalid/);
    }
  });

  it("bounds expanded bytes before accepting a compressed archive", () => {
    const archive = zipSync({ "SKILL.md": strToU8(markdown), "assets/bomb": new Uint8Array(1024 * 1024) });
    expect(archive.length).toBeLessThan(4000);
    expect(() => readSkillArchive(Buffer.from(archive).toString("base64"))).toThrow(/large/);
  });

  it.each(["../outside", "scripts/a:b.txt", "SKILL.md/child", "portable/CON.txt", "portable/file.", "portable/references/../x"])("rejects unsafe package path %s", path => {
    expect(() => previewSkillFiles({ files: [{ path: "SKILL.md", content_base64: Buffer.from(markdown).toString("base64") }, { path, content_base64: "" }] })).toThrow();
  });

  it("rejects case-insensitive and Unicode-normalization collisions", () => {
    for (const paths of [["SKILL.md", "skill.md"], ["SKILL.md", "é.txt", "e\u0301.txt"]]) {
      expect(() => previewSkillFiles({ files: paths.map(path => ({ path, content_base64: Buffer.from(markdown).toString("base64") })) })).toThrow(/colliding/);
    }
  });

  it("rejects multi-skill folders, invalid base64 and byte limits", () => {
    expect(() => previewSkillFiles({ files: [...files, { path: "portable/nested/SKILL.md", content_base64: files[0]!.content_base64 }] })).toThrow(/exactly one/);
    expect(() => previewSkillFiles({ files: [{ path: "SKILL.md", content_base64: "@@@" }] })).toThrow(/encoding/);
    expect(() => previewSkillFiles({ files: [{ path: "SKILL.md", content_base64: Buffer.alloc(256 * 1024 + 1).toString("base64") }] })).toThrow(/large/);
  });
});
