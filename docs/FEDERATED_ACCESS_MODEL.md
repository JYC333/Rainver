# Federated Access Model

Multi-deployment federation is not implemented. The application has no remote
pointer, remote fetch, synchronization, distributed identity, or cross-instance
authorization API.

Local cross-Space transfer uses targeted immutable publications documented in
[CONTENT_PUBLICATIONS.md](CONTENT_PUBLICATIONS.md). That mechanism copies a
snapshot into an explicit target Space and cannot be used to read the live
source resource.

Federation design notes:
[`.agent/plans/unimplemented-from-guides.md`](../.agent/plans/unimplemented-from-guides.md)
§14.
