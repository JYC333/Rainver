import { HttpError } from "../routeUtils/common.js";
import type { InvocationDelivery } from "@rainver/protocol";
import type { CliStdioController } from "./localCliExecution.js";

/** Same worker-affinity requirement as the existing process cancellation
 * registry. Never forward a delivery to a different attempt of the same Run. */
const channels = new Map<string, RunLiveInputChannel>();

export interface RunLiveInputChannel {
  delivery: InvocationDelivery;
  available(): boolean;
  during<T>(work: () => Promise<T>): Promise<T>;
  inject: NonNullable<CliStdioController["steer"]>;
  onClose(work: () => Promise<void>): void;
  close(): Promise<void>;
}

export function liveInputChannel(runId: string): RunLiveInputChannel | undefined { return channels.get(runId); }

export function registerRunLiveInput(runId: string, delivery: InvocationDelivery, controller: CliStdioController): RunLiveInputChannel {
  if (channels.has(runId)) throw new Error("An execution already owns this Run's live input");
  let active = true;
  const pending = new Set<Promise<unknown>>(), finalizers: Array<() => Promise<void>> = [];
  const channel: RunLiveInputChannel = {
    delivery,
    available: () => active && channels.get(runId) === channel && controller.canSteer?.() === true,
    async during(work) {
      if (!channel.available() || pending.size > 0) throw new HttpError(409, "Run is not accepting additional input");
      const task = Promise.resolve().then(work);
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    },
    inject: prompt => active && channels.get(runId) === channel && controller.steer
      ? controller.steer(prompt) : Promise.resolve("promptRequired"),
    onClose: work => { finalizers.push(work); },
    async close() {
      active = false;
      if (channels.get(runId) === channel) channels.delete(runId);
      await Promise.allSettled([...pending]);
      const settled = await Promise.allSettled(finalizers.map(finalize => finalize()));
      const failed = settled.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
  channels.set(runId, channel);
  return channel;
}
