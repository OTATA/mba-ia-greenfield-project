---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-11T13:22:09+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-11T13:19:34+00:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Streaming/download audience undefined — anonymous viewers or owner only?"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Draft pre-registration required fields undefined; title boundary with Phase 04"
    resolved_by: clarification
  - id: ICC-1
    status: resolved
    summary: "TD-09 direct-from-storage streaming vs inherited strict-BFF single-origin posture"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "No TD decides internal vs browser-reachable storage endpoint for presigning"
    resolved_by: phase-03-videos/TD-12
  - id: MD-2
    status: resolved
    summary: "No TD decides where the 10GB cap and accepted content types are enforced"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Object Storage Client Library"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Bucket Topology and Object Key Layout"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Background Processing Queue Technology"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — 10GB Upload Protocol"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Draft Pre-registration and Upload-Completion Handshake"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Video Worker Process Topology"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — FFmpeg Invocation for Metadata and Thumbnail"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Unique Public Video URL Identifier"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Playback Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle and Processing-Failure Policy"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Integration-Test Strategy for Storage and Queue"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Storage Endpoint Addressing for Presigned URLs"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Upload Admission Control (10GB ceiling + content types)"
    resolved_by: phase-03-videos/TD-13
advisories: []
---

# phase-03-videos — Validation

## Findings

**Verdict: `clean`.** All 7 applicable checks ran against the post-resolve `context.md` and produced no open issues; every entry in `issues:` carries `status: resolved`. Check 8 is suppressed (single slice). The phase is cleared for `/plan-build 03`.

Evidence for the empty categories, so the verdict is auditable rather than asserted:

| Gate | Measured |
|---|---|
| Pending TDs (Check 6) | 0 of 13 |
| Uncovered capability bullets (Check 3) | 0 of 9 |
| `Scope: Frontend` TDs with no UI scope (Check 1 orphan) | 0 (7 Backend + 6 Cross-layer; `Cross-layer` is exempt) |
| `## UI Inventory` present (Checks 7 + Decisão #29) | absent → `ui_in_scope: false`, both suppressed |
| Phase-scope slices for NN=3 (Check 8) | 1 → suppressed |

### Inconsistencies

_None._

Pairwise coherence of the 13 decided TDs was checked and holds. The combinations worth naming:

- **TD-04 / TD-05 / TD-13** — TD-04 routes `CompleteMultipartUpload` through the API, which is exactly what makes TD-05's API-brokered completion signal free and gives TD-13 a hook for post-completion verification. Mutually reinforcing, not conflicting.
- **TD-02 / TD-09 / AMB-1** — the public-read bucket holds *thumbnails*; *videos* live in the private bucket reached only by presigned GET. "Download requires authentication" therefore does not contradict "thumbnails are world-readable" — different buckets, different assets.
- **TD-02 / TD-08** — TD-02 keys storage by the internal `videoId` while TD-08 introduces a separate public `public_id`. TD-02's recommendation states this explicitly so the public id can be rotated without touching storage.
- **TD-03 / TD-06 / TD-07** — BullMQ's documented stall failure mode is a CPU-starved event loop; TD-07 runs FFmpeg in a separate OS process via `child_process` and TD-06 puts the worker in its own container, so the loop stays free to renew locks during a 10GB transcode.
- **TD-10 / TD-03** — retry lives in BullMQ (`attempts` + backoff), so only terminal failures reach the DB as `failed`; the enum does not duplicate queue state.

All 13 `Capability:` citations match a `## Scope` bullet verbatim.

### Ambiguities

_None._ — AMB-1 and AMB-2 were resolved in the previous `/plan-resolve` run and are dropped per the Step 3 merge rule (same `(category, summary)` tuple already `resolved`). Their substance is preserved under `## Resolved Issues` below, which is load-bearing for `/plan-build`: AMB-1 fixes the Authorization Matrix split and AMB-2 fixes the `NOT NULL` columns of the CreateVideos migration.

### Missing Decisions

_None._ — 9/9 capability bullets covered; the error-response-format sub-type is satisfied by the inherited `phase-02-auth/TD-07`; the shared-types sub-type (Decisão #29) does not fire because `ui_in_scope: false`.

### Dependency Gaps

_None._ — prior-phase prerequisites are all present (channels and the global JWT guard from Phase 02; namespaced `registerAs` config and Joi env validation from Phase 01 for the new storage/queue/endpoint variables; the domain exception contract from `phase-02-auth/TD-07`). The infrastructure this phase introduces — MinIO, Redis, the worker container — is delivered *by* Phase 03 and is therefore not a gap. Within-phase ordering is declared explicitly: TD-12 records `Depends on: TD-04, TD-09` and TD-13 records `Depends on: TD-04, TD-05, TD-07, TD-10`.

### Inherited Constraint Conflicts

_None._ — ICC-1 was resolved and is dropped by the merge rule. Re-running Check 5 over all 13 now-decided TDs against `## Inherited Conventions` and `## Inherited Decisions Detail` surfaces no new contradiction: the new `queue.config.ts` / storage config follow the phase-01 `registerAs` + `ConfigType` + Joi conventions; the Video entity and its migration fit `TypeOrmModule.forRootAsync` with `autoLoadEntities: true, synchronize: false`; TD-13's rejection path uses the inherited domain-exception contract; and `phase-02-auth/TD-08`'s AuthModule-scoped throttler is untouched.

> **Note on TD-12 and the Docker-host rule.** TD-12 introduces an `S3_PUBLIC_ENDPOINT` that is `localhost`-based in development, which sits against the root `CLAUDE.md` instruction to use Compose service names as hosts. This is deliberately **not** an ICC-N: that instruction lives in `CLAUDE.md`, not in `## Inherited Conventions` or `## Inherited Decisions Detail` (the two sources Check 5 is defined over), and TD-12's recommendation already reconciles it in writing — the rule governs container-to-container configuration, while this value is a browser-facing URL whose host SigV4 signs. Recorded here so a future reader does not mistake the omission for an oversight.

### Unresolved Open Questions

_None._ — all 13 TDs are `decided`; no inventory open questions exist (no UI scope).

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent (`ui_in_scope: false`); UIG-N is not a concept for this phase.

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Streaming/download audience: **streaming is anonymous, download requires authentication**. Honours the project plan's "Usuários anônimos podem assistir livremente" while treating download of the original file as a deliberate act requiring an account. For `/plan-build`: the playback endpoint carries `@Public()`, the download endpoint does not; the Authorization Matrix distinguishes the two; presigned TTLs may differ per audience.
- **AMB-2** _(resolved_by clarification)_ — Minimum draft payload: Phase 03 writes `id`, `public_id`, `channel_id`, `status`, storage keys, the declared size/MIME (required by TD-13), and a **`title` derived from the uploaded filename**. `description` and `category` stay nullable for Phase 04. For `/plan-build`: in the CreateVideos migration `title` is `NOT NULL`, `description` and `category` are nullable — no upload-time form is introduced, preserving Phase 04's ownership of video-info editing.
- **ICC-1** _(resolved_by clarification)_ — Ruled in favour of **strict-BFF governs calls to the NestJS API; object storage is an accepted second origin.** Matches `docs/diagrams/software-arch.mermaid` (`Rel(frontend, storage, "Streams", "HTTPS")`) and reads `next-frontend-config-base/TD-03` as constraining NestJS callers rather than all browser egress. TD-09 stands as written; TD-12 remains load-bearing. Deciding argument: routing a 10GB download through Node is the same anti-pattern the enunciado bans for upload.
- **MD-1** _(resolved_by phase-03-videos/TD-12)_ — Storage endpoint addressing for presigned URLs; closed by the arrival of TD-12 (two endpoints, two clients).
- **MD-2** _(resolved_by phase-03-videos/TD-13)_ — Enforcement point for the 10GB ceiling and accepted content types; closed by the arrival of TD-13 (declare-then-bind + post-completion verification).
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Object Storage Client Library → A (`@aws-sdk/client-s3` v3). Libraries: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Bucket Topology and Object Key Layout → B (two buckets: private `streamtube-videos`, public-read `streamtube-thumbnails`).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Background Processing Queue Technology → A (BullMQ + Redis via `@nestjs/bullmq`). Libraries: `bullmq`, `@nestjs/bullmq`, `ioredis`. Settles the `TBD` the C4 diagram carried for the Message Queue container.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — 10GB Upload Protocol → C (presigned multipart brokered by the API).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Draft Pre-registration and Upload-Completion Handshake → A (API-brokered completion + janitor sweep for abandoned uploads).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — Video Worker Process Topology → A (separate container, shared codebase, `NestFactory.createApplicationContext()` entrypoint, dedicated `Dockerfile.worker` carrying FFmpeg).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — FFmpeg Invocation → B (direct `child_process` spawn of `ffmpeg` / `ffprobe`), avoiding the deprecated `fluent-ffmpeg`.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Unique Public Video URL Identifier → C (short `public_id` from `node:crypto`, no new dependency).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — Playback Streaming and Download Delivery → B (short-lived presigned `GET`; storage serves `206` natively).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — Video Status Lifecycle → A (single enum `draft → uploading → processing → ready | failed` plus `processing_error`; retry delegated to BullMQ `attempts`).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — Integration-Test Strategy → A (real MinIO and Redis from Compose, matching the existing Postgres/Mailpit convention).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — Storage Endpoint Addressing → A (two endpoints, two clients: `S3_INTERNAL_ENDPOINT` for server-side work, `S3_PUBLIC_ENDPOINT` only for signing browser-facing URLs).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — Upload Admission Control → C (declare-then-bind at create-upload via `signableHeaders` content-length, plus post-completion `HeadObject` + `ffprobe` verification feeding TD-10's `failed` state).
