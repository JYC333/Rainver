import {describe,it,expect} from 'vitest';
import {publicWorkspaceError,publicWorkspaceLaunchError} from '../src/workspaceScope.js';

describe('public workspace failure reasons',()=>{
 it('preserves the target-checkout refusal that the publication worker retries',()=>{
  expect(publicWorkspaceError('native_verified_version_changed')).toBe('native_verified_version_changed');
  expect(publicWorkspaceError('native_preparation_preserves_local_files: /private/location')).toBe('native_preparation_preserves_local_files');
  expect(publicWorkspaceError('main_checked_out_elsewhere')).toBe('main_checked_out_elsewhere');
  expect(publicWorkspaceError(new Error('workspace_generation_moved'))).toBe('workspace_generation_moved');
 });
 it('keeps local filesystem diagnostics out of the wire reason',()=>{
  expect(publicWorkspaceError(new Error("ENOENT: no such file or directory, open '/private/source/.git/index'"))).toBe('workspace_host_operation_failed');
 });
 it('adds actionable launch guidance without changing command reason codes or exposing diagnostics',()=>{
  const error=new Error('workspace_checkout_project_config_not_allowed: /private/source/.npmrc contains private-token');
  expect(publicWorkspaceError(error)).toBe('workspace_checkout_project_config_not_allowed');
  const message=publicWorkspaceLaunchError(error);
  expect(message).toContain('Only engine-strict=true/false and comments are supported');
  expect(message).not.toContain('/private/source');
  expect(message).not.toContain('private-token');
  expect(publicWorkspaceLaunchError(new Error('EACCES: /private/source'))).toBe('workspace_host_operation_failed');
 });
 it('distinguishes private snapshot file and aggregate limits with fixed recovery guidance',()=>{
  expect(publicWorkspaceLaunchError(new Error('workspace_snapshot_file_too_large'))).toContain('16 MiB');
  expect(publicWorkspaceLaunchError(new Error('workspace_snapshot_too_large'))).toContain('64 MiB');
 });
});
