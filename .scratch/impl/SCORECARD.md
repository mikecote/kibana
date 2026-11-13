# Task-process remotable implementation scorecard

Base: `9102732dead662fdfcf0bb6d8b26834bade9a8fc`. Local exploratory measurements, not CI budgets.

| Commit | Change | Init bytes (workflow / es-query) | Other measurements | Regression evidence |
| --- | --- | --- | --- | --- |
|---|---|---|---|---|
|---|---|---|---|---|
| 0 (`2774e20ebf1b`) | Structural inventory dedup + fixture fixes | 1,407,286 → 772,807 B / 2,362,936 → 784,005 B | −634,479 B (45.1%) / −1,578,931 B (66.8%); no seam content | Scout 7/7; unit 246/246; integration 13/13 + 14/14; scoped types + lint pass |
| 1 (`b56af629570c`) | Seam core, no production imports | Unchanged by construction; not remeasured | capnweb 0.12.0 added in phase1; phase2 adds previously-transitive ws; esbuild smoke passes | 10 seam/composition tests; Scout 7/7 postcommit; scoped types/lint clean |
| 2 (`cb0d995f4e5a`) | Fork IPC transport + one session per live child | Not remeasured | Isolated fork RSS n=3/config: idle +0.172 MiB; after first RPC +11.219 MiB | Scout 7/7 pre/post; 9 server tests (3 repeat passes), 246 task-process tests + 34 supervisor tests; scoped types/lint pass |
| 3 (`0582e22cf886`) | Typed active-run cancel push | Not remeasured | 2 calls / 598 envelope B per cancellation ×3; HTTP cancel requests 0; native ES reads unchanged | Scout 7/7 pre/post; integration 3/3; unit 248/248; remote 9/9; scoped types/lint pass |
| 4 (`3b0bd51a5aae`) | Typed pool/count progress; ready-cached flags | Not remeasured | 5 calls / 1,399 envelope B; local endpoints 6→4; local flag HTTP 0 | Scout 7/7 pre/post amendment; unit 251; integration 5; workflow 14; scoped types/lint pass |
| 5 (`33b7137b540d`) | Facts + references; live Main compatibility | 772,807 → 39,519 B / 784,005 → 49,217 B | Main parity kinds 14/16 → 0 local; ML reference 324,834 B; steady witness 2 calls/647–650 B | Scout 7/7 final; unit259; integration6; workflow14; ML3; scoped types/lint pass |
| 6 (`862f18282bcc`) | Cases workflow client coordinator-placed | No further init reduction claimed | Cases emitted +2,624B; idle RSS +3.828MiB (n3/config, noisy); +1 capability/21 methods | Original Scout7/7; real Cases1/1; combined8/8; unit260 + Cases38; session1; scoped types/lint pass |

## Commit 0 artifacts

- `.scratch/impl/harness/`: adapted Track A capture/analyzer and fork preload; payload strings redacted, exact JSON byte sizes retained.
- `commit-0/before/`: initial baseline/invalidated loop. Seven original es-query snapshots were 2,362,936 B. Subsequent files contain sharedSettings after Kibana's development watcher restarted Main during editing while child bundles were stale. This loop is **not regression evidence**.
- `commit-0/after/`: intermediate verification boot, stopped to add explicit shared-init capability and rebuild bundles. Not regression evidence.
- `commit-0/verified/`: final-source loop; each actual init capture is paired with an `inline-init` capture reconstructed from the exact same snapshot by expanding references and removing the shared section. This isolates structural dedup from configuration, IDs and boot-to-boot noise. These inline controls are counterfactual wire sizes, explicitly not separate historical runs.
- `commit-0/jest-task-process-unit.log`: 26 suites / 246 tests pass.
- `commit-0/type-task-manager.log`, `type-workflows.log`, `eslint.log`: scoped validation.
- `commit-0/jest-task-process-invalid-concurrent.log`: invalid first integration attempt; concurrent suites extracted the same ES install path. Retry sequentially; never count this as implementation failure or a passing check.
- `commit-0/jest-workflows.log`: workflow fixture regression: 14/14 pass, using TASK_PROCESS_TEST_BUNDLE_DIR=target/task_processes_scout/bundles.

No timings inferred from byte counts. No expected savings substituted for measured values.

Verified capture analysis: 56/56 byte reconstructions exact (`commit-0/verified/analysis.log`); per-bundle sizes and raw capture filenames in `commit-0/verified/init-summary.json`.

Commit 1 artifacts: `commit-1/{jest-common.log,jest-server.log,type-*-postcommit.log,eslint-postcommit.log,scout-tests-postcommit.log,metafile.json,esbuild.log}`. No Inversify/reflect-metadata in either smoke bundle.

## Commit 2 artifacts and interpretation

- `commit-2/session-memory-{raw,summary}.json`, `commit-2/cold/session-memory-{raw,summary}.json`: alternating fresh PIDs, explicit GC, 1s idle, n=3 per configuration. Both variants load the same bundle. The +11.219 MiB first-RPC result includes lazy runtime initialization in a tiny isolated fork; **not a full Kibana worker delta**. Idle session alone: +0.172 MiB. Neither number replaces the other.
- `commit-2/jest-server-{1,2,3}.log`: real fork IPC coexistence and post-boot table baselines after three runs. `drain()` does not flush release-frame delivery; table assertions allow bounded eventual delivery (1s), not leaked exports.
- `commit-2/scout-tests.log`, `scout-tests-postcommit.log`: 7/7 each. `scout-tests-postcommit-interrupted.log` is an infrastructure-killed attempt, not passing evidence.
- `commit-2/type-*-postcommit.log`, `eslint-postcommit.log`: scoped types/lint pass.
- Lifecycle clarification approved by supervisor: create boot session after fork, expose lease after validated ready, no pre-ready run capabilities, retain one session across reuse and close on disconnect/exit.

## Approved commit 3 scope clarification

Native workflow `refreshCancelState` ES reads remain unchanged for multi-node correctness: a different Kibana node may persist cancellation. Only the TaskManager HTTP cancellation hop moves to a typed session push. Budget counts seam traffic, not native ES reads. Do not claim total cancellation polls become zero; the two PoCs placed cancellation state differently. Same-node workflow notification is optional only if <~50 lines and no new coupling; otherwise skipped.

## Commit 3 artifacts and budget

- `commit-3/jest-cancellation.log`: three real HTTP + RPC run/cancel cycles, each 2 calls / 598 envelope bytes; both tables return to post-boot 1 import / 1 export. Budget: ≤10 call-expression frames and ≤5 KiB, envelope/newline included, measured from one side of the boundary (not double-counted).
- `commit-3/seam-verified.jsonl`: payload-free method log; budget excludes worker-native ES reads by design.
- `commit-3/scout-tests.log`: 7/7. Scout timeout can occur during cold child startup, before dispatch, so the dedicated integration test—not Scout's process-exit assertion—proves cancellation delivery and acknowledgement semantics. No RPC calls observed in this Scout run; do not invent a measured poll reduction.
- `commit-3/jest-task-process.log`, `jest-server.log`, `type-*-postcommit.log`, `eslint-postcommit.log`: 248 unit / 9 remote-server tests, scoped types/lint.
- Same-node workflow cancel fast-path skipped: coupling to workflow/concurrency cancellation routing was not genuinely cheap. Cross-node ES cancellation semantics remain intact.

Commit 4 scope clarification approved: declarations already ride validated child-ready, evaluated values ride dispatch. Delete redundant local flag-preflight HTTP hop with zero replacement RPC; do not add unused FlagEvaluationApi. Remote HTTP preflight block may move verbatim to a helper, with call sites changed only.

## Commit 4 split and budget evidence

Real Scout traffic exposed bulk telemetry in the mixed progress operation: first 22 payloads 7,833–11,269 B, already above the unchanged 5-KiB envelope budget. This was caught by reviewing real traffic, not the original small canonical test. Original unpublished commit/diff/raw prefix remain in `commit-4/pre-amend/`. The single authorized amendment produced `3b0bd51a5aae`; authorization consumed.

Corrected integration includes an 11,366-B native telemetry fixture; count-only RPC is 257 envelope B, total five calls / 1,399 B with a changed count, four calls / 1,142 B otherwise. Real Scout prefix: 66 dispatches; zero flag/pool/cancel HTTP requests; 19 native telemetry bodies 8,958–14,506 B with only prometheus; four count requests with 3-B logical payloads. Frozen prefixes in `commit-4/split/` preserve these values. Native ES cancellation reads remain unchanged.

`commit-4/split/scout-tests-post-amend.log`: 7/7 (3.4m). `jest-control-post-amend.log`, `type-task-manager-post-amend.log`, `eslint-post-amend.log`: passing. Remote flag helper extraction verified verbatim ignoring whitespace.

## Commit 5 facts, live metadata and static content

- `commit-5/final/{captures/,init-summary.json,analysis.log}`: workflow init39,519B (n7 workflow run/resume captures), es-query49,217B; the frozen precommit35-capture summary reconciles exactly (the capture directory also contains subsequent postcommit runs). Prior dedup controls772,807/784,005B are historical same Scout-config captures, not paired same-snapshot controls for this stage. Workflow −94.89%, es-query −93.72% vs stage0 dedup. Overall original init −97.19%/−97.92%.
- Main parity arrays no longer shipped locally:14 workflow/16 rule kinds→0. Native registration witnesses remain as lazy initialization after the actual runtime constructs; Main checks current truth before each dispatch, digest changes trigger full report. Generic workflow/module guards preserve missing-Main-only policy; Agent Builder preserves bidirectionality. Eight legitimate worker-only registrations (proposals.* and threat_intel.fetch_source) exposed the mistake in naive bidirectionality. Raw failing attempt retained `commit-5/direction-catch/`; corrected prior Scout7/7 in `verified/`, final dedup-preserving loop7/7 in `final/`.
- Init size reduction is NOT a claim that live inventories disappear from total boot traffic: boot inventory responses63,208–399,092 logical payload B, measured `final/seam-summary.json`. Known global feature data remains single-copy in that boot response. Full real lazy witness requests1,907–7,317 logical B per newly constructed group. First full witness is explicitly lazy worker initialization, not steady control traffic. Canonical large200-ID witness2calls/12,937 envelopeB; subsequent digest-only checks2calls/647–650B and table baselines restored three times (`jest-integration-final.log`).
- Installed ML assets244 files /324,834 JSONB, sha256 in `ml-content.json`. Main sends digest+size; first use verified in worker-owned private temporary cache; disk hit/coalesced concurrent reads make no second fetch. Scout did not request the module files in this fixture; no invented production cache-hit rate. ML source unit3/3 and cache tests prove lazy loading, hit, integrity and rejection.
- Config/credentials/flags inline unchanged; unexercised mixed settings kept inline rather than moving secrets as “inventory”. Remote mode retains native inline snapshots and original comparison fallback.
- `jest-task-process.log`259; `jest-integration-final.log`6; `jest-workflows.log`14 incl remote reuse; `jest-ml.log`3; scoped task-manager/ML/AgentBuilder types and lint logs. Missing capture output directory caused the first instrumented attempt to fail before worker init; `scout-tests-invalid-capture-dir.log` is invalid evidence, never counted as passing.

## Commit 6: placement mechanism demonstrated; savings ceiling not achieved

| Metric | Measured iteration | Historical all-Cases-exclusion ceiling (NOT achieved here) |
| --- | --- | --- |
|---|---|---|
| Cases-attributed emitted bytes | 1,163,418→1,166,042B (**+2,624**) | ≈−1.2MB only when all Cases contributions leave graph |
| Total graph emitted JS | +24,932B | Not substituted for attribution |
| Post-GC idle worker RSS | 557.34375→561.171875MiB (**+3.828125**) | −15.6MiB only for all-Cases exclusion |
| Samples | n3/config, six raw PIDs, baseline spread10.40625/after2.984375MiB | Historical Track A n3/config |
| Seam surface | +1 capability, **21 explicitly named methods** | Pre-existing calls in ~30 step handlers, not speculative API |

**Dependency-closure finding:** agent-builder's separate Cases contribution still directly imports `createCasesRunServices`. Moving just the workflow contribution reclaims no shared closure. Metafile static reachability proves the thin local workflow path has no path to that factory; the remote-only dynamic fallback and agent-builder path remain. Relocating Cases agent-builder is out of scope and would be required to approach the historical ceiling. No RSS win claimed; +3.83MiB is reported as-is, with small n/noisy baseline.

Artifacts: `commit-6/{before-final,after}/metafile.json` (fresh52-entry builds), `cases-analysis.json` (re-runnable attribution and static reachability), `closure-methods.txt` (21-method source inventory), `rss-summary.json`, `{before-final,after}/rss.json` (PIDs, post-GC samples), `native-fallback-preserved.json` (exact hashes of unchanged native/agent-builder contributions). Memory harness is adapted Track A: same workflow-capable idle bundle, fixture settings, fresh process each sample, two explicit GCs,2s settle. Benchmark's rounded idleRssMb uses pre-GC ps sampling; scorecard uses raw post-GC probes instead.

**Budget and outcome:** `validation/jest-cases-session-final.log`: three real IPC-session cycles, two mocked create uses per run, **5 push-expression frames/2,038–2,051 envelopeB**, ≤10/5KiB. One capability acquisition per run plus reference-ownership frame; subsequent business use one method RPC. Tables return to baseline and retained stubs reject after lease revocation. Test caught premature cap disposal; retained ownership now duplicated before releasing acquisition promise. `cases_operations.test.ts` verifies all21 bindings and that no generic helper is RPC-exposed.

The inherited7-test Scout suite does **not** create a case. Original tests left untouched; new `cases_coordinator.spec.ts` proves a persisted case in a custom space, creator equal to workflow caller, and actual native worker dispatch. `scout/cases-tests.log`1/1; `scout/scout-tests.log`original7/7; `scout/scout-tests-with-cases.log`combined8/8. Real create requests695–696 logicalB, response871–875B (`scout/seam-summary.json`), no budget breach. Other20 operations have routing/unit coverage, not real large-result budget coverage; `find`, `getAll`, `similar` remain an explicit residual risk, not silently exempted from the budget.

`validation/jest-cases-all.log`:38 tests; `jest-task-process-final.log`:260 tests (a native Node segmentation-fault attempt preserved separately; clean retry passes). `jest-control.log`:6 unchanged control/initialization integration tests. Scoped TM/Cases/remote-common types + final non-mutating lint pass. Initial benchmark without fixture settings and initial test-discovery attempts are invalid and not passing evidence.

## Session scaling (corrected against actual supervisor code)

One session/live child. Active leases ≤ max_concurrent_processes. Steady retained sessions ≤ active bound + reuse.max_idle_processes, plus briefly terminating children during overlap. Measured Scout disables reuse, so no idle sessions retained. These are existing pool/admission bounds, not new unbounded session admission. Per-session isolated idle delta+0.172MiB; lazy first RPC+11.219MiB, not full-worker measurements.

Native/remote Cases integration additionally passed8/8 (`commit-6/validation/jest-cases-native-remote.log`,290.6s): child_process and remote, reuse off/on, case/comment/update/read/events plus attachments/file creation/deletion. The real coordinator path is separately proved by added Scout; these original integration modes preserve native fallback coverage, not invented coordinator coverage.

## Final committed-tip validation (862f18282bcc)

`commit-6/scout/scout-tests-postcommit.log`: **8/8** (1.9m). `commit-6/final/result.txt`: **passed**. Eight scoped type projects (remote-common, remote-server-internal, task-manager, workflows engine, ML, AgentBuilder, Cases, kbn-jest); non-mutating ESLint83 source files; common5/server9/task-process260/Cases38/ML6 unit tests; control/initialization integration6 and Cases session1 (three cycles). Exact command inventory: `commit-6/final-validation.sh`; raw per-command logs in `commit-6/final/`. Existing Cases native/remote8/8 remains in `validation/`. Independent adversarial review is supervisor-owned and pending, not implied by these checks.

## Phase2 — deliberately revised design decisions

| Commit | Result | Honest cost/deletion accounting | Validation |
| --- | --- | --- | --- |
| 7 (`a3aa8889849b`) |73 convention-discovered static remote manifests; both JSON keys removed; runtime composition/build read same declarations |+2110/−494 LOC, net+1616;539 license/header+1072 manifest data+164 dev interpreter/tests+335 other additions. Not net-red: declarations move to owners;8 retires machinery |52/52 bundle names/flags identical; emitted JS80,582,253→80,601,631B (+19,378/0.02405%); parser absent. Scout8/8; native/remote Cases8/8; TM260/Cases38/alerting2/AB3/discovery9/bundle18/session9/control6; scoped types/lint |
| 8 (`ca111d795155`) | Authenticated remote WS session; four HTTP families retired |+1653/−574 LOC, net+1079: tests/helpers+709; production/metadata+370. Four per-control negotiation strings removed | Frozen-source Scout8/8; native/remote Cases8/8; workflow14 incl remote reuse; core10/TM252/Cases37 units +Cases session1; controls15; scoped4 types/26-file lint |
| Portability (`a519fe18582b`; extra appended fix approved before9) | Dotted task basenames stay extension-agnostic; no dist-only branches |+147/−55 LOC, net+92;52 entries/15 manifests fixed; fresh bundles zero-byte delta | Actual production-SWC options,73 JS-only manifest loads; bundle91/resolver19+22 snapshots/import-rule10; Scout8/8; Cases8/8; workflow14; TM252/control15; scoped4 types/19-file lint |

Commit7 removes `plugin.taskTypes` and `plugin.taskTypeContributions` (two schema keys;73 owning manifests migrated). Dev-only AST interpreter lives in import-locator; repo-packages performs path discovery only. Esbuild resolves `require.resolve` into static data; plugin code never executes during discovery. Five coverage tests change declaration lookup only; scans/assertions byte-identical (three entire describe blocks byte-identical).

Artifacts:`commit-7/{line-counts.json,equivalence-final.json,compare.cjs,coverage-preserved.json,accepted/,scout/tests-frozen.log,type-clean-*.log,eslint-accepted.log,jest-*.log}`. Intermediate failures and invalidated Scout loops are retained in NOTES.md; never counted. DevEx feedback submitted correcting start-server/run-tests reuse guidance. At the commit7 checkpoint, the approved WS design/gates were recorded in DECISIONS.md; route deletion then followed in8.



### Phase2 deletion/dependency totals (implementation commits7–8 + portability fix;9 is documentation)

- **4 HTTP families deleted:** `/v3/feature_flags`, `/v3/active_pool`, `/v3/cancel`, `/v3/gauges`. Versioned HTTP protocol paths7→3; `/health` remains an additional liveness alias. WS `/session` is an authenticated transport upgrade, not a replacement HTTP control shim.
- **2 kibana.jsonc keynames removed,83 occurrences across73 plugins:**15 `taskTypes` +68 `taskTypeContributions`. Schema, repo parser/types and bespoke coverage discovery removed. Definition data lives with its owner; one path scan +one dev-only interpreter/shared helper.
- **Branch delta vs862f18282bcc:1,069 base LOC deleted;3,856 added; net+2,787.** Per-commit gross sum is1,123 deleted/3,910 added:54 newly added lines were replaced later, not removed from the base PR. No net-deletion claim. Commit7 decomposes into539 header/license lines+1072 manifest-data lines+164 interpreter/tests+335 other additions, minus494. Commit8 adds939 test/helper lines and714 production/metadata lines, removes230 test/helper and344 production/metadata lines. Its fixed WS/lifecycle/conformance cost exceeds the removed HTTP machinery. The appended portability correction adds147/removes55 (net+92). Measurements outrank the predicted “red-heavy” label.
- Phase1 added **capnweb**; phase2 adds **ws8.22.0, previously transitive**, plus dev types8.18.2, without upgrades. Installed ws19 files/151,410B (not an RSS delta). Local core/supervisor imports leave ws unloaded (`local-lazy-ws.json`). Native graphs already had14 ws inputs via jsdom; unchanged. Fresh52-bundle graph80,601,631→80,603,973B (+2,342B), names/flags identical, no parser inputs (`bundle-summary-verified.json`).

### Commit8 controls, concurrency and lifecycle

Real supervised protocol-fixture child + WS: **8 call-expression frames/997 WebSocket-frameB**, including startup/extra fixture metadata and per-run flag read; steady6/749B. Counts/pool/cancel use the session; native task/data-plane behavior is additionally exercised by original Cases/workflow integration suites. Budget remains≤10/5KiB **per physical control boundary**; remote mode has both WS and child IPC boundaries, not a claimed end-to-end summed-call reduction.

Overlapping cancellation control windows:10 frames/1,244B, with11,332B encoded native telemetry per run kept on HTTP. This second window excludes prior lease/flag setup; the native-child test above includes it. A design-review catch fixed the single-slot telemetry assumption: per-execution snapshots are independently consumed and expire at the existing run grace (default5s); shutdown clears timers. Retained bytes follow cancellation completions within their grace windows×snapshot size, not max concurrent children. No admission changes or hard byte/rate bound; do not invent a “few KB maximum.” Consume/expiry/hygiene assertions pass.

Auth401/browser-Origin403, failed-auth classification, absent/stale-session503, deadline-bounded stalled lease acquisition, disconnect-revocation/retry/no orphan, fresh retry, shared-ref bursts and table/listener baselines pass. TLS terminates upstream as in the base deployment model; loopback WS was tested, not a production TLS proxy. One WS/busy supervisor URL+token closes on last lease; no idle linger added. Local session scaling remains the corrected active+idle+terminating-overlap model above.

### Commit8 test inventory and validation provenance

User revised the standing test rule mid-run: base tests are evidence, not a constitution. Never remove an assertion because it fails; replace obsolete contracts at equal/greater strength and retain surviving business outcomes. Already-green fixture migrations were not churned for elegance.

- `remote_task_runner.test.ts`: lease-seam transport mocks; HTTP flag-preflight fixture follows session declarations; retired HTTP-cancel acknowledgement test replaced by typed cancellation coverage.
- `server.test.ts`: native IPC lease fixture, real WS health replicas and session header setup preserve surviving dispatch/snapshot/business assertions. Gauges follow folded path. Old HTTP flags/count/pool tests leave with endpoints; typed `[2,2,1,4]→final5` checkpoints retain idempotency assertions and add no-control-polling assertion. Live pool freshness remains covered.
- `remote_metrics.test.ts`: transport plumbing mocked at lease seam; old mixed HTTP-cancel telemetry test replaced with count-only RPC +native HTTP handoff/final-response dedup (both total5 assertions retained).
- `cancel_telemetry.test.ts`: canonical metrics URL only. `integration_tests/cancellation_session.test.ts`: literal retired-route negative assertions (including gauges), budgets/hygiene retained. Obsolete `active_task_pool_requests.test.ts` removed with its HTTP reply queue; typed pool coverage remains.
- Added `web_socket_session.test.ts` (three real transport bursts), `remote_worker_capabilities.test.ts` (metadata/bounds), `integration_tests/{remote_session,cancelled_telemetry}.test.ts` (real WS/native fixture child +concurrency/expiry).

Final commands/logs:`commit-8/final-validation.sh`, `final/{type-*.log,eslint-last.log,jest-*.log,result.txt}`, `scout/tests.log`8/8. The extra full native-session budget test was added after the all-suite pass and rerun with the full control suite:15/15 in `jest-control-accepted.log` and `final/jest-control-last.log`; scoped TM type/lint repeated. Native/remote Cases8/8 and workflow14 use freshly rebuilt `target/phase2-8-verified` bundles. Cases server unit37 and existing Node-config session integration1 are separate commands: broad jsdom invocation had `AbortSignal.any` missing and is retained as invalid test-environment evidence, not a product failure or passing check. An attempted unsupported Jest environment-match option was reverted without source diff. One normal control run emitted an exit-delay warning; diagnostic `--detectOpenHandles` rerun14/14 reported no handles and exited. All spawned servers/workers stopped.

Commit9 reframes the PR directly around deliberate design revisions while naming the base PR's lasting contributions. Independent acceptance review remains supervisor-owned; no push or live PR edit performed.

Byte budgets include all application messages plus transport framing, measured on one side; call counts mean push/call-expression frames, not every response/release frame.

### Late distributable portability check

The actual `build_packages_task.ts` production SWC config was used (synchronous transform API, JS-only target fixtures, not a full release build). It reproduced `MODULE_NOT_FOUND` when TaskManager's runtime imported a manifest containing `require.resolve('...task.ts')`. The uniform-import helper had mistaken `.task` for an explicit extension and added `.ts`. A narrow basename fix keeps extensionless require.resolve requests extensionless; explicit source names/native ESM behavior remain covered.52 task entries across15 manifests corrected. All73 actual manifest sources now load through the production transform without executing any target implementations. This is the approved fourth appended commit, not a rewritten7/8. Raw failed repro and passing91/19/10 tests, zero-delta bundle comparison, fresh Scout8/8/Cases8/8/workflow14 and scoped validation: `commit-8-fix/`.
