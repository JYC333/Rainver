import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, Folder, Loader2 } from 'lucide-react'
import { hostsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { errMsg } from '../../lib/utils'

/**
 * The VS Code-Remote directory picker shape: the daemon on the owned host
 * answers one `readdir` per level, this renders it. The selected directory is
 * simply the one currently open; a path can also be pasted and opened.
 */
export default function HostDirectoryBrowser({
  hostId,
  value,
  onChange,
  disabled = false,
}: {
  hostId: string
  /** The currently open (= selected) absolute path, or null before the first listing. */
  value: string | null
  onChange: (path: string | null) => void
  disabled?: boolean
}) {
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [draftPath, setDraftPath] = useState(value ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openPath = useCallback(async (path: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const listing = await hostsApi.browseDirectories(hostId, path)
      setParent(listing.parent)
      setDirs(listing.dirs)
      setTruncated(listing.truncated)
      setDraftPath(listing.path ?? '')
      onChange(listing.path)
    } catch (caught) {
      setError(errMsg(caught))
    } finally {
      setLoading(false)
    }
  }, [hostId, onChange])

  useEffect(() => {
    // First open: the home-ish root the daemon resolves for "/" is too broad a
    // default, so start from the previously selected path or the filesystem root.
    void openPath(value ?? '/')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId])

  const joinChild = (name: string) => `${value === '/' ? '' : value ?? ''}/${name}`

  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="host-directory-browser">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Parent directory"
          disabled={disabled || loading || !parent}
          onClick={() => void openPath(parent)}
        >
          <ArrowUp className="size-3.5" />
        </Button>
        <Input
          aria-label="Directory path"
          value={draftPath}
          disabled={disabled}
          onChange={event => setDraftPath(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void openPath(draftPath) } }}
          className="h-8 font-mono text-xs"
        />
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground shrink-0" />}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="max-h-44 overflow-y-auto space-y-0.5">
        {dirs.map(name => (
          <button
            key={name}
            type="button"
            disabled={disabled || loading}
            onClick={() => void openPath(joinChild(name))}
            className="w-full flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50"
          >
            <Folder className="size-3 shrink-0 text-primary/60" />
            <span className="truncate">{name}</span>
          </button>
        ))}
        {!loading && dirs.length === 0 && !error && (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">No subdirectories.</p>
        )}
      </div>
      {truncated && <p className="text-[11px] text-muted-foreground">Showing the first 500 directories.</p>}
      <p className="text-[11px] text-muted-foreground">The open directory is the one that will be registered.</p>
    </div>
  )
}
