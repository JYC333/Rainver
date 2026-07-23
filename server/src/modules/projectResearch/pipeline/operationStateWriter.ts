import type { Queryable } from "../../routeUtils/common";
import {
  applyResearchStatePatch,
  researchStage,
  researchState,
  transition as transitionResearchOperation,
  updateProjection,
  type ResearchOperationState,
  type ResearchStepOverride,
} from "../stateMachine";

export interface ResearchOperationProjection {
  id: string;
  space_id: string;
  project_id: string;
  progress_json: unknown;
}

/** Writes a research projection only through the canonical state machine. */
export async function setResearchOperationState(
  db: Queryable,
  operation: ResearchOperationProjection,
  state: ResearchOperationState,
  steps: ResearchStepOverride[],
): Promise<void> {
  const base = researchState(operation.progress_json);
  const from = base.current_stage;
  const to = researchStage(state.current_stage);
  if (from === to) {
    await updateProjection(
      db,
      operation.space_id,
      operation.id,
      ({ state: current }) => applyResearchStatePatch(current, base, state),
      steps,
    );
    return;
  }
  await transitionResearchOperation(db, operation.space_id, operation.id, {
    from: [from],
    to,
    mutate: ({ state: current }) => applyResearchStatePatch(current, base, state),
    stepOverrides: steps,
    onIllegal: "noop",
  });
}
