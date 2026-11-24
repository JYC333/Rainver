/**
 * Launch instructions for delegated children placed in their coordinator's
 * workspace (delegatedWorkspacePlacement). They describe enforcement that the
 * server and Host apply anyway; the text is never the enforcement itself.
 */
export function sharedDelegationInstruction(changeSetId:string,revision:number,baseCommit?:string){
 const basis = baseCommit ? ` The assigned saved commit is ${baseCommit}. Check the current HEAD before editing.` : "";
 return `You are working directly in your coordinator's workspace for this conversation and repository (the same worktree, branch and change set ${changeSetId}, revision ${revision}); no other writer runs beside you.${basis} Edit files and use normal Git commits on this branch. Your work stays in the coordinator's batch: save with your own Git commit or workspace.change.complete action=checkpoint, but do not call prepare, publish or reconcile — the coordinator integrates and publishes this batch and those actions are refused for you. Do not move shared target refs. If you are stopped or fail, whatever you saved or left in the tree is kept as your own commit for the coordinator to review; report what is complete and what is not.`;
}

export function delegatedReviewInstruction(commit:string){
 return `This is a read-only review of your coordinator's workspace, mounted read-only at exactly commit ${commit}. You cannot change files, commits or refs here, and there is no change set to save or publish. Report your findings, citing that commit, in your reply.`;
}

/** Current binding and publication rules needed even when the session has just been rebuilt. */
export function conversationWorkspaceInstruction(changeSetId: string, revision: number): string {
  return [
    `You are in this conversation’s isolated worktree. Change set ${changeSetId}, revision ${revision}.`,
    "Use Git on your own branch. Save privately with a commit or workspace.change.complete action=checkpoint. Never move shared target refs.",
    "For an authorized merge, use workspace.change.complete to prepare, resolve any reported conflicts here, check the exact prepared commit here, then publish with its verification. Squash requires the person’s explicit request and quote. Use workspace.change.get for the current revision and outcome. Wait for pending operations, and prepare and verify again if the target moves. Report publication only after merged or no_changes.",
    "Use workspace.change.list to find retained work before closure or recovery. Ask for neither command configuration nor internal IDs.",
  ].join(" ");
}
