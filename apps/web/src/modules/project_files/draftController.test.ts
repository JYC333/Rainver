import { describe, expect, it, vi } from 'vitest'
import { DRAFT_IDLE_MS, DRAFT_MAX_MS, ProjectFileDraftController } from './draftController'

function mutation(content: string, version: number | null = null) {
  return {
    expected_version: version,
    target_kind: 'existing' as const,
    relative_path: 'README.md',
    base_exists: true,
    base_sha256: 'a'.repeat(64),
    content,
    content_sha256: 'b'.repeat(64),
    byte_size: new TextEncoder().encode(content).byteLength,
    source_encoding: 'utf8' as const,
    preserve_bom: false,
    line_ending_mode: 'lf' as const,
  }
}

function draft(content: string, version: number) {
  return {
    ...mutation(content, version - 1),
    id: 'draft-1', space_id: 'space-1', project_id: 'project-1',
    project_folder_id: 'folder-1', workspace_location_id: 'location-1', owner_user_id: 'user-1',
    target_kind: 'existing' as const, relative_path: 'README.md', base_exists: true,
    base_sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64), version,
    created_at: '', updated_at: '', expires_at: '',
  }
}

describe('ProjectFileDraftController', () => {
  it('does not save on open and coalesces edits at the idle boundary', async () => {
    vi.useFakeTimers()
    const save = vi.fn().mockResolvedValue(draft('two', 1))
    const controller = new ProjectFileDraftController({
      initialContent: 'one',
      buildMutation: async (content) => mutation(content),
      save,
    })

    controller.setContent('t')
    controller.setContent('two')
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DRAFT_IDLE_MS - 1)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.runOnlyPendingTimersAsync()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toMatchObject({ content: 'two', expected_version: null })
    expect(controller.snapshot().status).toBe('saved')
    controller.destroy()
    vi.useRealTimers()
  })

  it('flushes the current generation and serializes a later edit behind it', async () => {
    const first = deferred<ReturnType<typeof draft>>()
    const second = deferred<ReturnType<typeof draft>>()
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const controller = new ProjectFileDraftController({
      initialContent: 'one',
      buildMutation: async (content, current) => mutation(content, current?.version ?? null),
      save,
    })

    controller.setContent('two')
    const flushing = controller.flush()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    controller.setContent('three')
    first.resolve(draft('two', 1))
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    second.resolve(draft('three', 2))
    await flushing
    await controller.flush()
    expect(controller.snapshot()).toMatchObject({ content: 'three', status: 'saved', acknowledgedGeneration: 2 })
    controller.destroy()
  })

  it('starts a max-age save while edits continue', async () => {
    vi.useFakeTimers()
    const save = vi.fn().mockResolvedValue(draft('long edit', 1))
    const controller = new ProjectFileDraftController({
      initialContent: '',
      buildMutation: async (content) => mutation(content),
      save,
    })
    controller.setContent('long edit')
    await vi.advanceTimersByTimeAsync(DRAFT_MAX_MS)
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    controller.destroy()
    vi.useRealTimers()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
