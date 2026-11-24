import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PgProposalRepository } from '../src/modules/proposals/repository.js';
import { insertProposalRow } from '../src/modules/proposals/reviewPackets.js';
import { seedSpaceMember, seedSpaceOwnerProject } from './support/domainSeeds.js';
import { useTestDatabase } from './support/testDatabase.js';

const db = useTestDatabase(import.meta.filename);

it('pages a mixed-type proposal filter in global review priority without counting a hidden proposal', async () => {
  if (!db.available) return;
  const space = randomUUID();
  const owner = randomUUID();
  const member = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project: randomUUID(), spaceType: 'team' });
  await seedSpaceMember(db.pool, { space, user: member });

  const propose = (proposalType: string, urgency: string, visibility = 'space_shared', createdByUserId = owner) =>
    insertProposalRow(db.pool, { spaceId: space, proposalType, title: proposalType, payload: {}, rationale: null, urgency, visibility, createdByUserId });
  const low = await propose('knowledge_archive', 'low');
  const high = await propose('claim_create', 'high');
  await propose('claim_create', 'critical', 'private', member);
  await propose('memory_create', 'critical');

  const repository = new PgProposalRepository(db.pool);
  const filters = { status: 'pending', proposalTypes: ['knowledge_archive', 'claim_create'], limit: 1 };
  const first = await repository.listVisible(space, owner, { ...filters, offset: 0 });
  const second = await repository.listVisible(space, owner, { ...filters, offset: 1 });
  expect(first).toMatchObject({ items: [{ id: high.id }], total: 2 });
  expect(second).toMatchObject({ items: [{ id: low.id }], total: 2 });
});
