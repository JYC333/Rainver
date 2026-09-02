import { describe, expect, it } from "vitest";
import { hostThreadDispatchInputs } from "../src/modules/hosts/threadDispatchInputs.js";

// The Run row is the only place the job handler learns which host thread a
// Run belongs to and which vendor session to resume. It used to be the job
// payload, rebuilt by hand at each of the twenty enqueue sites — and the
// supervisor retry, direct chat, the resume endpoint and the authorization
// re-enqueue all built it without those fields, so their Runs resumed nothing.
describe("hostThreadDispatchInputs", () => {
  it("reads the thread and the session to resume from the Run's host_thread override", () => {
    expect(hostThreadDispatchInputs({
      host_task_thread_id: "thread-1",
      model_override_json: {
        model: "m",
        host_thread: { schema_version: "host_thread.v1", thread_id: "thread-1", runtime_session_id: "sess-9", fresh: false },
      },
    })).toEqual({ thread_id: "thread-1", resume_session_id: "sess-9", resume_attempted: true });
  });

  it("marks a thread's first dispatch as not attempting a resume", () => {
    for (const override of [
      null,
      {},
      { host_thread: { schema_version: "host_thread.v1", thread_id: "thread-1", runtime_session_id: null } },
      { host_thread: { schema_version: "host_thread.v1", thread_id: "thread-1", runtime_session_id: "" } },
      { host_thread: "malformed" },
    ]) {
      expect(hostThreadDispatchInputs({ host_task_thread_id: "thread-1", model_override_json: override }), JSON.stringify(override))
        .toEqual({ thread_id: "thread-1", resume_session_id: null, resume_attempted: false });
    }
  });

  it("is inert for a Run bound to no thread, whatever its override says", () => {
    expect(hostThreadDispatchInputs({
      host_task_thread_id: null,
      model_override_json: { host_thread: { runtime_session_id: "sess-9" } },
    })).toEqual({ thread_id: null, resume_session_id: null, resume_attempted: false });
  });
});
