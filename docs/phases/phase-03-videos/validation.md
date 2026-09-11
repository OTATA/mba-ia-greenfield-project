---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-11T13:10:16+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-11T13:02:31+00:00"
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

All 16 issues from the previous revision were resolved by `/plan-resolve` on 2026-09-11. `status` is deliberately left at `dirty` — per the pipeline contract only `/plan-validate` computes the verdict, and it must re-run the checks against the now-decided TDs before declaring `clean`.

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ — `## UI Inventory` absent from context.md (`ui_in_scope: false`); UIG-N is not a concept for this phase.

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Streaming/download audience settled: **streaming is anonymous, download requires authentication**. This honours the project plan's "Usuários anônimos podem assistir livremente" while treating download of the original file as a deliberate act requiring an account. Consequences for `/plan-build`: the playback endpoint carries `@Public()`, the download endpoint does not; the Authorization Matrix distinguishes the two; presigned TTLs may differ per audience.
- **AMB-2** _(resolved_by clarification)_ — Minimum draft payload settled: Phase 03 writes `id`, `public_id`, `channel_id`, `status`, storage keys, the declared size/MIME (already required by TD-13), and a **`title` derived from the uploaded filename**. `description` and `category` stay nullable for Phase 04 to populate. Consequence for `/plan-build`: in the CreateVideos migration `title` is `NOT NULL`, `description` and `category` are nullable — no upload-time form is introduced, keeping Phase 04's ownership of video-info editing intact.
- **ICC-1** _(resolved_by clarification)_ — Ruled in favour of option (a): **strict-BFF governs calls to the NestJS API; object storage is an accepted second origin.** This matches `docs/diagrams/software-arch.mermaid`, which already draws `Rel(frontend, storage, "Streams", "HTTPS")`, and reads `next-frontend-config-base/TD-03` as constraining NestJS callers rather than all browser egress. TD-09 therefore stands as written and TD-12 remains load-bearing. The deciding argument was the download capability: routing a 10GB download through Node is the same anti-pattern the enunciado bans for upload.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Object Storage Client Library → A (`@aws-sdk/client-s3` v3). Libraries: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Bucket Topology and Object Key Layout → B (two buckets: private `streamtube-videos`, public-read `streamtube-thumbnails`).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Background Processing Queue Technology → A (BullMQ + Redis via `@nestjs/bullmq`). Libraries: `bullmq`, `@nestjs/bullmq`, `ioredis`. This settles the `TBD` the C4 diagram carried for the Message Queue container.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — 10GB Upload Protocol → C (presigned multipart brokered by the API).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Draft Pre-registration and Upload-Completion Handshake → A (API-brokered completion, plus a low-frequency janitor sweep for abandoned uploads).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — Video Worker Process Topology → A (separate container, shared codebase, `NestFactory.createApplicationContext()` entrypoint, dedicated `Dockerfile.worker` carrying FFmpeg).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — FFmpeg Invocation → B (direct `child_process` spawn of `ffmpeg` / `ffprobe`), avoiding the deprecated `fluent-ffmpeg`.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Unique Public Video URL Identifier → C (dedicated short `public_id` from `node:crypto`, no new dependency).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — Playback Streaming and Download Delivery → B (short-lived presigned `GET`; storage serves `206` natively).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — Video Status Lifecycle → A (single enum `draft → uploading → processing → ready | failed` plus `processing_error`; retry delegated to BullMQ `attempts`).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — Integration-Test Strategy → A (real MinIO and Redis from Compose, matching the existing Postgres/Mailpit convention).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — Storage Endpoint Addressing → A (two endpoints, two clients: `S3_INTERNAL_ENDPOINT` for server-side work, `S3_PUBLIC_ENDPOINT` used only for signing browser-facing URLs; a `localhost`-based public value in dev does **not** violate the `CLAUDE.md` Docker-host rule).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — Upload Admission Control → C (both mechanisms: declare-then-bind at create-upload with `signableHeaders` content-length, plus post-completion `HeadObject` + `ffprobe` verification feeding TD-10's `failed` state).
