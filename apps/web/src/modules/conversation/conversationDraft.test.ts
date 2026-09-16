import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearConversationDraft,
  readConversationDraft,
  writeConversationDraft,
} from './conversationDraft'

describe('conversation drafts', () => {
  beforeEach(() => sessionStorage.clear())

  it('round-trips a destination-scoped text and logical input draft', () => {
    writeConversationDraft({
      destination: 'room:room-1:session-1',
      text: 'continue this',
      input_parts: [{
        kind: 'file_reference',
        project_folder_id: 'folder-1',
        workspace_location_id: 'location-1',
        relative_path: 'src/index.ts',
        display_name: 'index.ts',
        media_type: 'text/plain',
        byte_size: 12,
        sha256: 'a'.repeat(64),
      }],
    })

    expect(readConversationDraft('room:room-1:session-1')).toMatchObject({
      destination: 'room:room-1:session-1',
      text: 'continue this',
      input_parts: [{ relative_path: 'src/index.ts' }],
    })
    expect(readConversationDraft('room:room-2:session-1')).toBeNull()
  })

  it('discards malformed and superseded schemas', () => {
    sessionStorage.setItem('rainver:conversation-draft:v1:room%3Aroom-1', JSON.stringify({
      version: 0,
      destination: 'room:room-1',
      text: 'old',
      input_parts: [],
    }))
    expect(readConversationDraft('room:room-1')).toBeNull()

    writeConversationDraft({ destination: 'room:room-1', text: 'valid', input_parts: [] })
    sessionStorage.setItem('rainver:conversation-draft:v1:room%3Aroom-1', JSON.stringify({
      version: 1,
      destination: 'room:room-1',
      text: 'bad',
      input_parts: [{ kind: 'unknown' }],
      saved_at: new Date().toISOString(),
    }))
    expect(readConversationDraft('room:room-1')).toBeNull()
  })

  it('discards drafts older than the recovery window', () => {
    sessionStorage.setItem('rainver:conversation-draft:v1:room%3Aroom-1', JSON.stringify({
      version: 1,
      destination: 'room:room-1',
      text: 'stale',
      input_parts: [],
      saved_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    }))
    expect(readConversationDraft('room:room-1')).toBeNull()
  })

  it('clears after a successful send', () => {
    writeConversationDraft({ destination: 'direct:agent-1:project-1:new', text: 'send me', input_parts: [] })
    clearConversationDraft('direct:agent-1:project-1:new')
    expect(readConversationDraft('direct:agent-1:project-1:new')).toBeNull()
  })
})
