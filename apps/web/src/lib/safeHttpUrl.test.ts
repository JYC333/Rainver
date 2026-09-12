import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSafeHttpUrl, safeAppPath, safeHttpUrl } from './safeHttpUrl'

describe('safeHttpUrl', () => {
  it('keeps http and https URLs', () => {
    expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeHttpUrl('http://127.0.0.1:8010/x')).toBe('http://127.0.0.1:8010/x')
  })

  it('rejects javascript, data, protocol-relative, and credentialed URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('data:text/html,hi')).toBeNull()
    expect(safeHttpUrl('//evil.example/x')).toBeNull()
    expect(safeHttpUrl('https://user:pw@example.com')).toBeNull()
    expect(safeHttpUrl('/relative')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })
})

describe('openSafeHttpUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens only an allowlisted URL', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openSafeHttpUrl('javascript:alert(1)')
    expect(open).not.toHaveBeenCalled()
    openSafeHttpUrl('https://accounts.example/login')
    expect(open).toHaveBeenCalledWith('https://accounts.example/login', '_blank', 'noopener,noreferrer')
  })
})

describe('safeAppPath', () => {
  it('keeps same-origin paths including query and hash', () => {
    expect(safeAppPath('/tasks/abc')).toBe('/tasks/abc')
    expect(safeAppPath('/projects/p1/inquiry?thread=t1#top')).toBe('/projects/p1/inquiry?thread=t1#top')
    expect(safeAppPath('/')).toBe('/')
  })

  it('rejects protocol-relative, schemes, and backslash paths', () => {
    expect(safeAppPath('//evil.example/x')).toBeNull()
    expect(safeAppPath('https://evil.example/x')).toBeNull()
    expect(safeAppPath('javascript:alert(1)')).toBeNull()
    expect(safeAppPath('/\\evil.example')).toBeNull()
    expect(safeAppPath('tasks/abc')).toBeNull()
    expect(safeAppPath(null)).toBeNull()
  })

  it('refuses a path the browser would resolve off-site', () => {
    // Every textual rule passes — one leading slash, no backslash, no control
    // characters — and the browser then collapses it to `//evil.example`,
    // which is protocol-relative and leaves the site.
    expect(safeAppPath('/..//evil.example')).toBeNull()
    expect(safeAppPath('/../..//evil.example/x')).toBeNull()
    expect(safeAppPath('/a/../..//evil.example')).toBeNull()
  })

  it('returns the resolved path, so a later reader cannot re-derive a different one', () => {
    expect(safeAppPath('/projects/../tasks/abc')).toBe('/tasks/abc')
    expect(safeAppPath('/tasks/./abc')).toBe('/tasks/abc')
  })
})
