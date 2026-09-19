/**
 * Correlates ACP ToolCall/ToolCallUpdate messages at the protocol boundary.
 *
 * ACP identifies a tool lifecycle with `toolCallId`, but adapters in the wild
 * can omit it or can attach Rainver after the initial ToolCall was emitted.
 * Downstream event logs should not each invent their own recovery rule, so the
 * boundary turns that imperfect stream into one invariant:
 *
 * - every tool event has a non-empty correlation id;
 * - an update says whether its start was missing, so a writer can insert it;
 * - anonymous starts and updates are paired while the call remains open.
 *
 * Synthetic ids are local trace identities. They are never sent back to the
 * runtime and carry no authorization meaning.
 */
export interface AcpToolCallObservation {
  callId: string;
  missingStart: boolean;
}

export interface AcpToolCallLifecycle {
  started(input: {
    callId: string | null;
    name: string | null;
    status?: string | null;
  }): AcpToolCallObservation;
  updated(input: {
    callId: string | null;
    name: string | null;
    status: string | null;
  }): AcpToolCallObservation;
}

interface AnonymousCall {
  callId: string;
  name: string | null;
}

export function createAcpToolCallLifecycle(): AcpToolCallLifecycle {
  const knownCallIds = new Set<string>();
  const suppliedIdAliases = new Map<string, string>();
  const openAnonymousCalls: AnonymousCall[] = [];
  let anonymousSequence = 0;

  const syntheticId = (): string => {
    let candidate: string;
    do {
      anonymousSequence += 1;
      candidate = `rainver:acp:anonymous:${anonymousSequence}`;
    } while (knownCallIds.has(candidate));
    knownCallIds.add(candidate);
    return candidate;
  };

  const started = (input: {
    callId: string | null;
    name: string | null;
    status?: string | null;
  }): AcpToolCallObservation => {
    if (input.callId) {
      const aliased = suppliedIdAliases.get(input.callId);
      if (aliased) {
        closeAnonymousCall(openAnonymousCalls, aliased, input.status ?? null);
        return { callId: aliased, missingStart: false };
      }
      knownCallIds.add(input.callId);
      return { callId: input.callId, missingStart: false };
    }

    const callId = syntheticId();
    if (!isTerminalStatus(input.status ?? null)) {
      openAnonymousCalls.push({ callId, name: input.name });
    }
    return { callId, missingStart: false };
  };

  const updated = (input: {
    callId: string | null;
    name: string | null;
    status: string | null;
  }): AcpToolCallObservation => {
    if (input.callId) {
      const aliased = suppliedIdAliases.get(input.callId);
      if (aliased) {
        closeAnonymousCall(openAnonymousCalls, aliased, input.status);
        return { callId: aliased, missingStart: false };
      }
      const anonymousIndex = matchingAnonymousCall(openAnonymousCalls, input.name, false);
      if (!knownCallIds.has(input.callId) && anonymousIndex >= 0) {
        const anonymous = openAnonymousCalls[anonymousIndex]!;
        suppliedIdAliases.set(input.callId, anonymous.callId);
        knownCallIds.add(input.callId);
        if (isTerminalStatus(input.status)) openAnonymousCalls.splice(anonymousIndex, 1);
        return { callId: anonymous.callId, missingStart: false };
      }
      const missingStart = !knownCallIds.has(input.callId);
      knownCallIds.add(input.callId);
      return { callId: input.callId, missingStart };
    }

    const anonymousIndex = matchingAnonymousCall(openAnonymousCalls, input.name, true);

    if (anonymousIndex < 0) {
      const callId = syntheticId();
      if (!isTerminalStatus(input.status)) {
        openAnonymousCalls.push({ callId, name: input.name });
      }
      return { callId, missingStart: true };
    }

    const call = openAnonymousCalls[anonymousIndex]!;
    if (call.name === null && input.name) call.name = input.name;
    if (isTerminalStatus(input.status)) openAnonymousCalls.splice(anonymousIndex, 1);
    return { callId: call.callId, missingStart: false };
  };

  return { started, updated };
}

function isTerminalStatus(status: string | null): boolean {
  return status === "completed" || status === "failed" || status === "succeeded";
}

function matchingAnonymousCall(
  calls: readonly AnonymousCall[],
  name: string | null,
  allowNewestFallback: boolean,
): number {
  if (name) {
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      if (calls[index]?.name === name) return index;
    }
  }
  if (calls.length === 1 || allowNewestFallback) return calls.length - 1;
  return -1;
}

function closeAnonymousCall(calls: AnonymousCall[], callId: string, status: string | null): void {
  if (!isTerminalStatus(status)) return;
  const index = calls.findIndex((call) => call.callId === callId);
  if (index >= 0) calls.splice(index, 1);
}
