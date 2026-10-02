# Targeted Content Publications

Content publication is the only general-purpose cross-Space content transfer.
It copies an immutable snapshot to explicitly selected target Spaces; it never
grants target members access to the source resource.

## Publish

`POST /api/v1/publications` accepts a registered `resource_type`, a source
resource ID, and one or more target Space IDs.

- The caller must be an active member of every target Space.
- The caller must own the source resource and have `full` access.
- The resource type must have an explicit serializer/importer in the static
  publication adapter registry.
- Artifact snapshots require inline content. Memory snapshots require user scope
  and normal sensitivity. Space Object snapshots are limited to Knowledge items.
- The snapshot is canonicalized, SHA-256 hashed, versioned, and stored independently
  of the source resource.

Supported resource types are `artifact`, `memory`, `space_object` (Knowledge
items), and `task`. Unregistered resource types fail closed.

## Discover And Import

`GET /api/v1/publications?view=received` returns active publications targeted
to the current Space, plus revoked ones this Space already imported (with the
snapshot body and hash withheld), only when the caller remains an active
member. It does not query or expose the live source resource.

`POST /api/v1/publications/{id}/import` verifies target membership, publication
status, snapshot schema version, and snapshot hash before invoking the registered
importer. The importer creates a new target-Space resource with:

- a new resource ID
- the importing user as owner
- `visibility=private`
- `access_level=full`
- no source Workspace, Project, assignment, run, proposal, or grant references

`content_publication_imports` records the publication version, snapshot hash,
target resource identity, importer, and timestamp. One target Space has at most
one imported copy per publication.

## Revoke

The publisher can revoke an active publication from its source Space. Revocation
prevents discovery by target Spaces that have not imported it and blocks future
imports; a Space that already imported it still sees the entry, without the
snapshot body. Existing target copies and import
provenance are not deleted or modified.

## Non-Goals

- no anonymous or public catalog
- no anonymous visibility or global catalog
- no cross-Space grants or direct reads
- no federation, remote fetch, or synchronization
- no source authorization bypass for Space admins
