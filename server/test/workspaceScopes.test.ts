import {describe,it,expect} from 'vitest';
import {executionWorkspaceMountRef} from '../src/modules/hosts/workspaceScopes.js';

const receipt={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',generation:2,base_commit:'a'.repeat(40),target_ref:'refs/heads/dev',cwd_subpath:'packages/app'};

describe('mount scope on a shared execution workspace',()=>{
 it('keeps the root grant at the repository root after a primary subdirectory wrote its receipt',()=>{
  const root=executionWorkspaceMountRef(receipt,'');
  const sibling=executionWorkspaceMountRef(receipt,'packages/other');
  expect(root).toEqual({id:receipt.id,generation:2,base_commit:receipt.base_commit,target_ref:receipt.target_ref});
  expect(sibling).toEqual({...receipt,cwd_subpath:'packages/other'});
  expect(receipt.cwd_subpath).toBe('packages/app');
 });
 it('does not inherit a prior cwd when a root mirror omits its subdirectory',()=>{
  expect(executionWorkspaceMountRef({...receipt,integration_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})).not.toHaveProperty('cwd_subpath');
 });
});
