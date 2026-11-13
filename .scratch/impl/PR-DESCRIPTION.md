## Task processes: explicit placement, one coordination contract

This iteration **deliberately revises three design decisions** of mikecote/kibana#11.
Its lasting contributions remain: **forked bundles, native data plane, per-run HTTP dispatch with TaskManager claim/retry semantics, and slim Core**.

| Base decision → revision | Measured reason | Counter-column |
| --- | --- | --- |
| Hand-versioned HTTP coordination → one typed, budgeted session over local fork IPC or remote WS | Four endpoint families and their client/schema/negotiation machinery deleted | Session skew/lifetime cost; remote still has WS + child-IPC boundaries |
| `kibana.jsonc` registration + runtime parity policing → convention-discovered static remote manifests + live Main comparison | Two manifest keynames/83 occurrences removed;73 owning manifests;52/52 bundle names/flags identical | More declarative LOC, not a line-count win; discovery/parser stay tooling-only |
| Snapshot-replicated inventories → facts, live references and digest assets | Workflow/rule init39,519/49,217B; ML assets fetched on use | Boot inventories still63–399KB; first witnesses cost initialization traffic; remote init retains inline fallback |

**Deleted:** `/v3/feature_flags`, `/v3/active_pool`, `/v3/cancel`, `/v3/gauges`.
**Survivors:** `/v3/run` (dispatch), `/health` + `/v3/health` (session-independent liveness/capability negotiation), `/v3/metrics` (bulk telemetry, including owner-scoped gauges and post-cancel handoff). Metric serializer negotiation remains.

Remote upgrades reuse `TASK_PROCESS_TOKEN`, reject browser Origin, and assume **TLS termination upstream**, as in the base deployment model. Post-cancel telemetry is independently consumed or expires at the run's existing grace (default5s): retention follows rolling cancellation completions, **not** the child-concurrency cap.

## Scorecard

| Stage | Measured result |
| --- | --- |
| 0: structural dedup | Init workflow1,407,286→772,807B; rule2,362,936→784,005B |
| 1–2: seam/session | Isolated idle+0.172MiB; first-RPC+11.219MiB (n3/config, not full-worker deltas) |
| 3–4: typed controls | IPC cancel2 calls/598B; pool/count conformance5 calls/1,399B; native ES cancellation reads remain |
| 5: facts/references | Init39,519/49,217B; local Main parity arrays14/16 kinds→0; ML324,834B lazy asset |
| 6: Cases placement |21 named methods; Cases emitted **+2,624B**, idle RSS **+3.83MiB** (n3, noisy): **no memory win**; shared agent-builder closure remains |
| 7: convention discovery |2 JSON keynames/83 occurrences removed across73 plugins; bundle JS+19,378B (+0.024%); parser absent |
| 8: remote/session retirement |4 HTTP families deleted; native remote WS conformance8 calls/997B including startup/extra fixture metadata and per-run flags;52-bundle JS+2,342B |
| 7–8 + portability fix: LOC |**1,069 base lines deleted; net+2,787**.7:+1,616 (539 header lines);8:+1,079 (tests/helpers+709, production/metadata+370); portability+92. Not net deletion |

A separately appended correctness fix prevents distributable Main startup failure: all73 manifests load through production SWC with JS-only targets; bundle bytes unchanged.

Phase1 added capnweb; phase2 adds **ws, previously transitive**, for remote sessions: one explicit, well-known runtime dependency (151,410 installed package bytes; no upgrade). Our local core/supervisor import path does not load it; existing native jsdom/ws graph inputs are unchanged.

Budget remains **≤10 call-expression frames /≤5KiB per control boundary**, not a summed end-to-end remote-call claim. Bulk telemetry stays HTTP. Three-cycle hygiene/revocation tests remain; large Cases `find`/`getAll`/`similar` results are still unproven under budget. Cost is per dependency closure, not per contribution; growth is intentional boundary APIs, not mirrored host plumbing.

**Scaling:** one session/live local child, retained under existing active+idle reuse bounds (plus terminating overlap); one WS/busy remote supervisor URL+token, shared by active leases and closed on last release. No idle WS policy or admission changes.

Worked diffs: [local cancellation](https://github.com/jloleysens/kibana/commit/0582e22cf886) · [Cases placement](https://github.com/jloleysens/kibana/compare/33b7137b540d...862f18282bcc).

**Non-goals:** production credential lifecycle; serverless/UIAM/QAF; alternate dispatch/data-plane stacks; relocating Cases agent-builder; other domains; landing in main.

**Validation:** unchanged Scout8/8; native/remote Cases8/8 and workflow14 including remote reuse; scoped types/lint; real WS auth, disconnect/retry/no-orphan, race, cache-expiry, budget and hygiene tests. Business-outcome coverage retained; obsolete HTTP tests replaced by session-contract tests. Evidence: `.scratch/impl/SCORECARD.md`, `commit-7/`, `commit-8/`. Independent review remains required.
