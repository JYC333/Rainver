import {runLocationGit} from '@rainver/folder-read';
import {gitOrThrow,writeCommit,type GitIdentity} from './taskWorktree.js';
import {mergeTrees} from './taskMerge.js';
import {MAX_CHAIN_COMMITS} from './publicationChain.js';

/**
 * Rebase publication (hosts.md, "Controlled Git publication"): the Agent's own
 * commits after its batch base are replayed one by one onto the target, in the
 * object store, like `git rebase --onto <target> <base>` without Git's
 * sequencer (whose state would live in the worktree). The base itself — a
 * private snapshot baseline, earlier private history — never travels.
 */

/** The commits `base..tip` a rebase onto `onto` replays, oldest first: merge
 * commits are dropped and a change already in `onto` is skipped, as `git rebase` selects them. */
export async function rebaseCommits(repoRoot:string,base:string,tip:string,onto:string):Promise<string[]>{
 const listed=await gitOrThrow(['rev-list','--reverse','--topo-order','--no-merges','--right-only','--cherry-pick',`${onto}...${tip}`,`^${base}`],repoRoot);
 const commits=listed?listed.split('\n'):[];
 if(commits.length>MAX_CHAIN_COMMITS)throw new Error('native_publication_chain_too_long');
 return commits;
}

/** A replayed commit: the original author, author date and message, with the Agent as committer. */
export async function pickCommit(repoRoot:string,original:string,tree:string,parent:string,committer:GitIdentity):Promise<string>{
 const [name,email,date]=(await gitOrThrow(['log','-1','--format=%an%x00%ae%x00%ad','--date=raw',original],repoRoot)).split('\0');
 const message=await gitOrThrow(['log','-1','--format=%B',original],repoRoot);
 return gitOrThrow(['commit-tree','--no-gpg-sign',tree,'-p',parent,'-m',message||'(no message)'],repoRoot,30_000,{
  GIT_AUTHOR_NAME:name??committer.name,GIT_AUTHOR_EMAIL:email??committer.email,...(date?{GIT_AUTHOR_DATE:date}:{}),
  GIT_COMMITTER_NAME:committer.name,GIT_COMMITTER_EMAIL:committer.email,
 });
}

export interface RebaseStop {commit:string;tree:string;conflicted:string[]}
/**
 * Replays `commits` onto `replayed` without touching any worktree. A commit
 * whose parent already is the replayed tip is kept as it is (identity
 * preserved); a clean pick becomes a new commit; a pick that changes nothing
 * is dropped. Stops at the first conflict with its merged tree, conflict
 * markers written, and the commits still to replay (that one first).
 */
export async function replayCommits(root:string,repoRoot:string,commits:readonly string[],replayed:string,committer:GitIdentity):Promise<{replayed:string;pending:string[];stop:RebaseStop|null}>{
 const treeOf=(commit:string)=>gitOrThrow(['rev-parse',`${commit}^{tree}`],repoRoot);
 for(let index=0;index<commits.length;index++){
  const commit=commits[index]!;
  const parent=await gitOrThrow(['rev-parse',`${commit}^`],repoRoot);
  if(parent===replayed){replayed=commit;continue;}
  // Merge base exactly the commit's parent: the target-side tree carried on that parent.
  const comparison=await writeCommit(repoRoot,await treeOf(replayed),parent,committer,'Rebase comparison baseline');
  const merged=await mergeTrees(root,comparison,commit);
  if(merged.conflicted.length)return {replayed,pending:commits.slice(index),stop:{commit,tree:merged.tree,conflicted:merged.conflicted}};
  if(merged.tree===await treeOf(replayed))continue;
  replayed=await pickCommit(repoRoot,commit,merged.tree,replayed,committer);
 }
 return {replayed,pending:[],stop:null};
}

/** Whether a resolved worktree tree still carries conflict markers in the stopped commit's conflicted files. */
export async function hasUnresolvedMarkers(root:string,replayed:string,tree:string,files:readonly string[]):Promise<boolean>{
 if(!files.length)return false;
 return (await runLocationGit(['diff','--check',replayed,tree,'--',...files],root)).code!==0;
}
