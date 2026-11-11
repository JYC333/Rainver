import {isWireRelativePath,looksSecretLikePath,runLocationGit} from '@rainver/folder-read';
import {gitOrThrow,type GitIdentity} from './taskWorktree.js';

/** Bounds of a commit chain published with its identities (hosts.md, "Controlled Git publication"). */
export const MAX_CHAIN_COMMITS=200;
const MAX_CHAIN_PATHS=2000;
export type PublicationStrategy='squash'|'fast_forward'|'merge'|'rebase';
/** A published chain. `rebase` is the Agent's commits replayed onto the target, published by fast-forward. */
export interface FrozenChain {strategy:'fast_forward'|'merge'|'rebase';base:string;tip:string;commits:string[]}

const refuse=(code:string)=>{throw new Error(code);};

/**
 * Freeze the Agent's own linear commits `base..tip` for publication by
 * fast-forward or an ordinary merge. The base must already be target history,
 * so a private snapshot baseline, earlier private checkpoints or another
 * branch's history can never travel with it; merges inside the chain are
 * refused for the same reason. Every changed path of every commit must be an
 * ordinary repository path, not a credential-like one.
 */
export async function freezePublicationChain(repoRoot:string,strategy:FrozenChain['strategy'],base:string,tip:string,targetRef:string):Promise<FrozenChain>{
 if((await runLocationGit(['merge-base','--is-ancestor',base,targetRef],repoRoot)).code!==0)refuse('native_publication_chain_base_not_target_history');
 if((await runLocationGit(['merge-base','--is-ancestor',base,tip],repoRoot)).code!==0)refuse('native_publication_chain_base_not_ancestor');
 const merges=await gitOrThrow(['rev-list','--min-parents=2','--max-count=1',`${base}..${tip}`],repoRoot);
 if(merges)refuse('native_publication_chain_not_linear');
 const listed=await gitOrThrow(['rev-list','--reverse',`--max-count=${MAX_CHAIN_COMMITS+1}`,`${base}..${tip}`],repoRoot);
 const commits=listed?listed.split('\n'):[];
 if(!commits.length)refuse('native_publication_chain_empty');
 if(commits.length>MAX_CHAIN_COMMITS)refuse('native_publication_chain_too_long');
 let paths=0;
 for(const commit of commits){
  const changed=await gitOrThrow(['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',`${commit}^`,commit],repoRoot);
  for(const path of changed.split('\0').filter(Boolean)){
   if(++paths>MAX_CHAIN_PATHS)refuse('native_publication_chain_too_large');
   if(!isWireRelativePath(path)||path.split('/').some(s=>s==='..'||s==='.git')||looksSecretLikePath(path))refuse('native_publication_chain_path_not_allowed');
  }
 }
 return {strategy,base,tip,commits};
}

/** The frozen chain must still be exactly what was checked when it is published. */
export async function assertChainUnchanged(repoRoot:string,chain:FrozenChain){
 const listed=await gitOrThrow(['rev-list','--reverse',`--max-count=${MAX_CHAIN_COMMITS+1}`,`${chain.base}..${chain.tip}`],repoRoot).catch(()=>'');
 if(listed.split('\n').join(' ')!==chain.commits.join(' '))refuse('native_publication_chain_changed');
}

/** An ordinary two-parent merge commit: first parent the target tip, second the chain tip. */
export async function writeMergeCommit(repoRoot:string,tree:string,onto:string,chainTip:string,identity:GitIdentity,message:string){
 return gitOrThrow(['commit-tree','--no-gpg-sign',tree,'-p',onto,'-p',chainTip,'-m',message],repoRoot,30_000,{
  GIT_AUTHOR_NAME:identity.name,GIT_AUTHOR_EMAIL:identity.email,GIT_COMMITTER_NAME:identity.name,GIT_COMMITTER_EMAIL:identity.email,
 });
}

/** A root publication may only target an existing, well-formed, non-Rainver branch. */
export async function assertPublicationTarget(repoRoot:string,targetRef:string,parentTarget:boolean){
 if(!parentTarget&&targetRef.startsWith('refs/heads/rainver/'))refuse('native_publication_target_managed');
 if((await runLocationGit(['check-ref-format',targetRef],repoRoot)).code!==0)refuse('native_publication_target_invalid');
 if((await runLocationGit(['rev-parse','--verify','--quiet',`${targetRef}^{commit}`],repoRoot)).code!==0)refuse('native_publication_target_missing');
}
