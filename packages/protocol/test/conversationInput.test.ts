import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MAX_IMAGES,
  ConversationInputPartsSchema,
  MessageCreateRequestSchema,
} from "../src/index";

const image = (mediaId: string, byteSize = 128) => ({
  kind: "image" as const,
  media_id: mediaId,
  filename: `${mediaId}.png`,
  media_type: "image/png" as const,
  byte_size: byteSize,
  sha256: "a".repeat(64),
});

describe("conversation input contracts", () => {
  it("preserves text-only compatibility and accepts image-only and mixed messages", () => {
    expect(MessageCreateRequestSchema.parse({ content: "hello" })).toMatchObject({
      content: "hello",
      input_parts: [],
    });
    expect(MessageCreateRequestSchema.parse({ input_parts: [image("media-1")] })).toMatchObject({
      content: "",
      input_parts: [expect.objectContaining({ media_id: "media-1" })],
    });
    expect(MessageCreateRequestSchema.parse({ content: "describe", input_parts: [image("media-1")] }).input_parts)
      .toHaveLength(1);
  });

  it("rejects empty input, unknown part kinds, and too many images", () => {
    expect(MessageCreateRequestSchema.safeParse({ content: "", input_parts: [] }).success).toBe(false);
    expect(MessageCreateRequestSchema.safeParse({ input_parts: [{ kind: "audio", id: "x" }] }).success).toBe(false);
    expect(ConversationInputPartsSchema.safeParse(
      Array.from({ length: CONVERSATION_MAX_IMAGES + 1 }, (_, index) => image(`media-${index}`)),
    ).success).toBe(false);
  });

  it("rejects unsafe file paths and impossible aggregate image sizes", () => {
    const file = {
      kind: "file_reference" as const,
      project_folder_id: "folder-1",
      workspace_location_id: "location-1",
      relative_path: "../secret.env",
      display_name: "secret.env",
      media_type: "text/plain",
      byte_size: 10,
      sha256: "b".repeat(64),
    };
    expect(ConversationInputPartsSchema.safeParse([file]).success).toBe(false);
    expect(ConversationInputPartsSchema.safeParse([
      image("one", 10 * 1024 * 1024),
      image("two", 10 * 1024 * 1024),
      image("three", 1),
    ]).success).toBe(false);
  });
});
