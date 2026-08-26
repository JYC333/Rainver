import { describe, expect, it } from "vitest";
import {
  missingRequiredVariables,
  renderPromptMessages,
  renderPromptTemplate,
} from "../src/modules/prompts/renderer.js";

describe("renderPromptTemplate", () => {
  it("substitutes known variables and reports missing ones", () => {
    const result = renderPromptTemplate("Query: {query}\nSpace: {space_name}", { query: "hello" });
    expect(result.rendered).toBe("Query: hello\nSpace: {space_name}");
    expect(result.missingVariables).toEqual(["space_name"]);
  });

  it("stringifies non-string variable values and treats null/undefined as empty", () => {
    const result = renderPromptTemplate("count={count} note={note} data={data}", {
      count: 3,
      note: null,
      data: { ids: [1, 2] },
    });
    expect(result.rendered).toBe('count=3 note= data={"ids":[1,2]}');
    expect(result.missingVariables).toEqual([]);
  });

  it("leaves text with no placeholders untouched", () => {
    const result = renderPromptTemplate("no placeholders here", {});
    expect(result.rendered).toBe("no placeholders here");
    expect(result.missingVariables).toEqual([]);
  });
});

describe("renderPromptMessages", () => {
  it("renders every message and unions missing variables across all of them", () => {
    const result = renderPromptMessages(
      [
        { role: "system", content: "You are {role_name}." },
        { role: "user", content: "Query: {query}, again: {query}, extra: {extra}" },
      ],
      { role_name: "an assistant", query: "hi" },
    );
    expect(result.messages).toEqual([
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Query: hi, again: hi, extra: {extra}" },
    ]);
    expect(result.missingVariables).toEqual(["extra"]);
  });
});

describe("missingRequiredVariables", () => {
  it("returns required fields absent from the variables map", () => {
    const missing = missingRequiredVariables({ required: ["query", "top_k"] }, { query: "hi" });
    expect(missing).toEqual(["top_k"]);
  });

  it("returns an empty array when the schema declares no required fields", () => {
    expect(missingRequiredVariables({}, {})).toEqual([]);
  });
});
