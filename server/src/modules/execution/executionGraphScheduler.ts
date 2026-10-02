interface ExecutionGraphNode {
  id: string;
  status: string;
  dependsOn: string[];
}

type ProjectedNodeStatus = "done" | "failed" | null;

/**
 * Shared deterministic state rules for Plan and fixed Workflow graphs.
 * Domain services own persistence, node materialization, and checkpoint
 * proposal creation; this class owns only graph scheduling semantics.
 */
export class ExecutionGraphScheduler {
  readyNodes(nodes: readonly ExecutionGraphNode[]): ExecutionGraphNode[] {
    const statusById = new Map(nodes.map((node) => [node.id, node.status]));
    return nodes.filter((node) =>
      ["inbox", "ready"].includes(node.status)
      && node.dependsOn.every((dependencyId) => statusById.get(dependencyId) === "done"),
    );
  }

  projectRunOutcome(runStatus: string, evaluationOutcome: string | null | undefined): ProjectedNodeStatus {
    if (["failed", "cancelled", "orphaned"].includes(runStatus)) return "failed";
    if (["succeeded", "degraded"].includes(runStatus) && evaluationOutcome === "passed") return "done";
    if (["succeeded", "degraded"].includes(runStatus) && evaluationOutcome) return "failed";
    return null;
  }

  hasFailedNode(nodes: readonly ExecutionGraphNode[]): boolean {
    return nodes.some((node) => ["failed", "cancelled"].includes(node.status));
  }

  isComplete(nodes: readonly ExecutionGraphNode[]): boolean {
    return nodes.length > 0 && nodes.every((node) => node.status === "done");
  }
}
