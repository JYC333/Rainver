import { describe, expect, it } from "vitest";
import { assertConversationInputCapabilities, assertConversationInputResourceTools } from "../src/modules/sessions/conversationInputCapabilities.js";

const image = {
  kind: "image" as const,
  media_id: "media-1",
  filename: "diagram.png",
  media_type: "image/png" as const,
  byte_size: 12,
};

const file = {
  kind: "file_reference" as const,
  project_folder_id: "folder-1",
  workspace_location_id: "location-1",
  relative_path: "README.md",
  display_name: "README.md",
  media_type: "text/markdown",
  byte_size: 12,
  sha256: "a".repeat(64),
};
const resource = {
  kind: "input_resource" as const,
  source_state: "saved" as const,
  project_folder_id: "folder-1",
  workspace_location_id: "location-1",
  relative_path: "README.md",
  display_name: "README.md",
  media_type: "text/markdown",
  byte_size: 12,
  sha256: "a".repeat(64),
};

describe("conversation input capability admission", () => {
  it("allows images only when runtime and model intersection is explicitly true", () => {
    expect(() => assertConversationInputCapabilities([image], {
      image: true,
      embedded_context: false,
      resource_link: true,
    })).not.toThrow();
    expect(() => assertConversationInputCapabilities([image], null)).toThrow(/does not explicitly support image input/);
    expect(() => assertConversationInputCapabilities([image], {
      image: false,
      embedded_context: true,
      resource_link: true,
    })).toThrow(/does not explicitly support image input/);
  });

  it("keeps text file references conservative only when ResourceLink is explicitly refused", () => {
    expect(() => assertConversationInputCapabilities([file], {
      image: null,
      embedded_context: null,
      resource_link: null,
    })).not.toThrow();
    expect(() => assertConversationInputCapabilities([file], {
      image: null,
      embedded_context: null,
      resource_link: false,
    })).toThrow(/does not support authorized file references/);
  });

  it("admits immutable resources only on a runtime with the governed tool surface", () => {
    expect(() => assertConversationInputResourceTools([resource], "opencode")).not.toThrow();
    expect(() => assertConversationInputResourceTools([resource], "custom_runtime")).toThrow(/cannot lazily read attached resources/);
    expect(() => assertConversationInputResourceTools([file], "custom_runtime")).not.toThrow();
  });
});
