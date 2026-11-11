import {randomUUID} from 'node:crypto';
import {loadConfig} from './config.js';
import {workspaceGitDirectory} from './readOnlyWorkspace.js';
import {acquireLocationLeases,releaseLocationLeases,tryShareLease} from './locationLease.js';
import {admitRepositories,REPOSITORY_RECOVERY_REQUIRED} from './branchAlignState.js';

/**
 * Canonical repository gate (hosts.md, "Controlled Git publication"). One
 * lease key per Git common directory (canonical, symlinks resolved), so every
 * Location, alias, linked worktree and Task worktree of one repository meets
 * at the same key whatever Location id or path it was reached through, and
 * whenever it was registered. Everything of Rainver that can move a ref or a
 * checkout of the repository holds it *shared* for its whole duration — Runs
 * (`launchRun`), host commands, worktree maintenance (`withTaskHeld`) and
 * Location registration — and a branch alignment takes it *exclusively*
 * without waiting, so it starts only while nothing else of the repository is
 * held or waiting and nothing starts beside it. Each start path resolves its
 * own repository identity freshly before it joins; the join itself is one
 * synchronous step, so no start can slip between an alignment's check and its
 * hold. The same paths ask the repository quarantine first
 * (`branchAlignState.ts`).
 *
 * Git processes outside Rainver (a person's terminal, an IDE) do not take
 * this lease. Against them an alignment relies on Git's own ref transaction
 * (compare-and-swap on both refs) and on refusing a dirty or busy checkout;
 * a change made in the checkout during the short worktree step is detected
 * (the step or its rollback answers `recovery_required`), not prevented.
 */
export const repositoryLeaseKey=(commonDir:string)=>`repository:${commonDir}`;

/** The canonical Git common directory of a configured Location, read now. */
export async function locationRepositoryDirectory(locationId:string):Promise<string|null>{
 const root=(await loadConfig().catch(()=>null))?.workspaces?.[locationId];
 return root?workspaceGitDirectory(root):null;
}

/**
 * For callers that never wait: holds every repository shared, or refuses
 * (`location_busy` while an alignment holds one; the quarantine's refusal).
 * Quarantine is asked *after* the hold: it is only ever recorded under an
 * alignment's exclusive hold, so none can appear once this is held.
 */
export async function tryHoldRepositories(commonDirs:readonly (string|null|undefined)[]):Promise<{release:()=>void}|{refused:string}>{
 const dirs=[...new Set(commonDirs.filter((d):d is string=>!!d))];
 const holder=`repository-share:${randomUUID()}`,held:string[]=[];
 const release=()=>releaseLocationLeases(held,holder);
 for(const dir of dirs){
  const key=repositoryLeaseKey(dir);
  if(!tryShareLease(key,holder)){release();return {refused:'location_busy'};}
  held.push(key);
 }
 return admitted(dirs,release);
}

/**
 * For callers that may wait (host commands, registration): waits out an
 * alignment, then holds. Registration changes no ref or checkout, so it is
 * not refused by a quarantine (`admit=false`); it only never overlaps an alignment.
 */
export async function holdRepositories(commonDirs:readonly (string|null|undefined)[],admit=true):Promise<{release:()=>void}|{refused:string}>{
 const dirs=[...new Set(commonDirs.filter((d):d is string=>!!d))];
 if(!dirs.length)return {release:()=>{}};
 const holder=`repository-wait:${randomUUID()}`,keys=dirs.map(repositoryLeaseKey);
 await acquireLocationLeases([],{runId:holder,launchId:holder},()=>{},keys);
 const release=()=>releaseLocationLeases(keys,holder);
 return admit?admitted(dirs,release):{release};
}

/** Held repositories that are quarantined and not yet proven consistent are released again. */
export async function admitted(dirs:readonly string[],release:()=>void):Promise<{release:()=>void}|{refused:string}>{
 const refused=await admitRepositories(dirs).catch(()=>REPOSITORY_RECOVERY_REQUIRED);
 if(refused){release();return {refused};}
 return {release};
}
