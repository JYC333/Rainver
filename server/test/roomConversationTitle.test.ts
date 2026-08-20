import { describe, expect, it } from "vitest";
import {
  cleanGeneratedTitle,
  titleFromMessage,
} from "../src/modules/rooms/conversationTitleService";

describe("Room conversation titles", () => {
  it("creates a useful zero-cost title from a Chinese first message", () => {
    expect(titleFromMessage("我想要做一个研究 agent memory 的项目。先帮我定义问题"))
      .toBe("研究 agent memory 的项目");
  });

  it("normalizes long first messages without exposing formatting", () => {
    const title = titleFromMessage(`# Please help me investigate ${"memory retrieval ".repeat(8)}`);
    expect(title).not.toContain("#");
    expect(Array.from(title)).toHaveLength(48);
    expect(title.endsWith("…")).toBe(true);
  });

  it("accepts plain model titles and rejects JSON-shaped output", () => {
    expect(cleanGeneratedTitle("标题：个人 Agent 分层记忆\n"))
      .toBe("个人 Agent 分层记忆");
    expect(cleanGeneratedTitle('{"title":"个人 Agent 分层记忆"}')).toBeNull();
  });
});
