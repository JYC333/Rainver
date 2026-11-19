import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_REMINDER_THRESHOLDS, COLLABORATION_OPERATION_SCHEMAS, CollaborationViewSchema,
  collaborationNextReminder, collaborationReminderThreshold, collaborationReminderThresholdsBetween,
} from '../src/index.js';

describe('task collaboration reminder thresholds', () => {
  it('uses 25/50/100/200 and then doubles, without a ceiling', () => {
    expect(COLLABORATION_REMINDER_THRESHOLDS).toEqual([25, 50, 100, 200]);
    expect(collaborationReminderThreshold(24)).toBeNull();
    expect(collaborationReminderThreshold(25)).toBe(25);
    expect(collaborationReminderThreshold(199)).toBe(100);
    expect(collaborationReminderThreshold(400)).toBe(400);
    expect(collaborationReminderThreshold(1_000_000)).toBe(819_200);
  });
  it('lists every threshold crossed by a jump, once', () => {
    expect(collaborationReminderThresholdsBetween(0, 24)).toEqual([]);
    expect(collaborationReminderThresholdsBetween(24, 25)).toEqual([25]);
    expect(collaborationReminderThresholdsBetween(25, 25)).toEqual([]);
    expect(collaborationReminderThresholdsBetween(40, 900)).toEqual([50, 100, 200, 400, 800]);
  });
  it('names the next reminder above any count', () => {
    expect(collaborationNextReminder(0)).toBe(25);
    expect(collaborationNextReminder(25)).toBe(50);
    expect(collaborationNextReminder(200)).toBe(400);
    expect(collaborationNextReminder(129)).toBe(200);
    expect(collaborationNextReminder(1000)).toBe(1600);
  });
  it('exposes exactly the collaboration operations and view fields', () => {
    expect(Object.keys(COLLABORATION_OPERATION_SCHEMAS).sort()).toEqual(['room.collaboration.get', 'room.collaboration.update_participants']);
    expect(Object.keys(CollaborationViewSchema.shape).sort()).toEqual([
      'active', 'can_manage', 'delegations_used', 'group_id', 'group_status', 'next_reminder_at',
      'participant_agent_ids', 'stop_reason', 'task_id', 'task_status', 'task_title', 'turns_used',
    ]);
  });
});
