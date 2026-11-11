import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import {runLocationGit} from '@rainver/folder-read';
import {checkLocationRepository,taskBranchRef,taskLeaseKey} from './taskWorktree.js';
import {executionWorkspacePath} from './executionWorkspace.js';
import {workspaceScopedCwd} from './workspaceScope.js';
import {workspaceWorktreeKey} from './worktreeIdentity.js';

/**
 * A read-only delegated review of an existing execution workspace (ADR 0029,
 * `review_commit`). The reviewer does not prepare, settle or checkpoint the
 * worktree: it mounts it read-only, under the worktree's lease held shared, so
 * readers run together and no writer, cleanup or release runs beside them.
 */
export function isWorkspaceReview(ref:ExecutionWorkspaceRef|undefined):ref is ExecutionWorkspaceRef&{review_commit:string}{
 return typeof ref?.review_commit==='string';
}

/** The lease every writer of that worktree takes exclusively. */
export function workspaceReviewLeaseKey(locationId:string,ref:ExecutionWorkspaceRef){
 return taskLeaseKey(locationId,workspaceWorktreeKey(ref));
}

/** The existing worktree (never created here), scoped to the reviewed subdirectory. */
export async function workspaceReviewCwd(locationRoot:string,locationId:string,ref:ExecutionWorkspaceRef){
 const root=await executionWorkspacePath(locationRoot,locationId,ref).catch(()=>{throw new Error('execution_workspace_review_unavailable');});
 return workspaceScopedCwd(root,ref.cwd_subpath);
}

/**
 * With the shared lease held: the workspace branch and the worktree HEAD are
 * exactly the frozen commit and nothing is uncommitted. Anything else means
 * the version under review is not the one the server froze; the review is
 * refused rather than reading a different version.
 */
export async function verifyWorkspaceReviewBasis(locationRoot:string,locationId:string,ref:ExecutionWorkspaceRef&{review_commit:string}):Promise<string|null>{
 const check=await checkLocationRepository(locationRoot);
 if(check.kind!=='repository')return 'execution_workspace_review_unavailable';
 const root=await executionWorkspacePath(check.repo.root,locationId,ref).catch(()=>null);
 if(!root)return 'execution_workspace_review_unavailable';
 const branch=await runLocationGit(['rev-parse','--verify',`${taskBranchRef(workspaceWorktreeKey(ref))}^{commit}`],check.repo.root);
 const head=await runLocationGit(['rev-parse','--verify','HEAD^{commit}'],root);
 if(branch.code!==0||head.code!==0)return 'execution_workspace_review_unavailable';
 if(branch.stdout.trim()!==ref.review_commit||head.stdout.trim()!==ref.review_commit)return 'execution_workspace_review_basis_moved';
 const status=await runLocationGit(['--no-optional-locks','status','--porcelain','--untracked-files=all'],root);
 if(status.code!==0)return 'execution_workspace_review_unavailable';
 return status.stdout.trim()?'execution_workspace_review_basis_moved':null;
}
