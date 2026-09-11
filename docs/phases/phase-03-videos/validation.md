---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-11T12:44:22+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-11T12:36:54+00:00"
issues:
  - id: AMB-1
    status: open
    summary: "Streaming/download audience undefined — anonymous viewers or owner only?"
  - id: AMB-2
    status: open
    summary: "Draft pre-registration required fields undefined; title boundary with Phase 04"
  - id: MD-1
    status: open
    summary: "No TD decides internal vs browser-reachable storage endpoint for presigning"
  - id: MD-2
    status: open
    summary: "No TD decides where the 10GB cap and accepted content types are enforced"
  - id: ICC-1
    status: open
    summary: "TD-09 direct-from-storage streaming vs inherited strict-BFF single-origin posture"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Object Storage Client Library"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Bucket Topology and Object Key Layout"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Background Processing Queue Technology"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — 10GB Upload Protocol"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Draft Pre-registration and Upload-Completion Handshake"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Video Worker Process Topology"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — FFmpeg Invocation for Metadata and Thumbnail"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Unique Public Video URL Identifier"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Playback Streaming and Download Delivery"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Video Status Lifecycle and Processing-Failure Policy"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Integration-Test Strategy for Storage and Queue"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

Checked and clear:

- All 11 TDs cite a `Capability:` that matches a `## Scope` bullet verbatim (9/9 bullets, no orphan citations).
- No decided TD contradicts a scope bullet — trivially true this run, since no TD is decided yet.
- **Scope-Subsection orphan check does not fire.** TD Scope distribution is 7 × `Backend` + 4 × `Cross-layer`, zero `Scope: Frontend`. The check fires only for `Scope: Frontend` with no active UI scope; `Cross-layer` is explicitly exempt (it renders in backend subsections via API Contracts).
- UI ↔ Scope inconsistency skipped — `## UI Inventory` is absent (no UI scope in this phase).

### Ambiguities

- **AMB-1** — Capability *"Download do vídeo pelo usuário"* (and, by extension, *"Reprodução via streaming (sem necessidade de download completo)"*) does not say **which** user. `docs/project-plan.md` § Visão Geral states "Usuários anônimos podem assistir livremente", which settles playback for anonymous viewers but is silent on download. TD-09 says "The API authorizes and returns a presigned URL" without deciding *who* is authorized. This changes the Authorization Matrix, the guard configuration (`@Public()` or not) and the presigned-URL TTL policy, so `/plan-build` cannot derive the SI without it. Explicit choice: decide whether streaming and download are (a) both public/anonymous, (b) both authenticated, or (c) streaming public + download authenticated — and record it on TD-09 or as a new TD.

- **AMB-2** — Capability *"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"* does not state which fields the draft row must carry at creation time. The boundary with Phase 04 is genuinely fuzzy: Phase 04 owns *"Edição das informações do vídeo: título, descrição, categoria e thumbnail customizada"*, so it is unclear whether Phase 03 must accept a title at upload start, derive a provisional one from the filename, or leave it null until Phase 04. This determines the `NOT NULL` constraints in the CreateVideos migration — a decision that is expensive to reverse once the migration ships. Explicit choice: fix the minimum draft payload for Phase 03 and state which columns are nullable until Phase 04.

### Missing Decisions

- **MD-1** — Capability *"Serviço de armazenamento de arquivos (vídeos e thumbnails)"* + *"Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"*: no TD decides **which host the S3 endpoint is signed against**. TD-04 and TD-09 both hand the client a presigned URL that the client must fetch directly. A presigned URL's signature covers the host, so it cannot be rewritten after signing. The root `CLAUDE.md` mandates "always use the Docker Compose service name as the host — never `localhost`", which would sign against `minio:9000` — an address no browser and no host-side test runner can resolve. Conversely signing against a public host breaks server-side calls inside the Compose network. This is a genuine cross-component decision (API config + `compose.yaml` + `.env` + test setup), and it is the single most likely thing to make the upload and streaming deliverables fail at demo time. Explicit choice: run `/research phase-03-videos` to add a TD covering dual-endpoint addressing (typical resolutions: a separate `S3_PUBLIC_ENDPOINT` used only for signing, a shared host alias resolvable from both sides, or a reverse proxy fronting MinIO on one origin).

- **MD-2** — Capability *"Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"*: no TD decides **where the 10GB ceiling and the accepted content types are enforced**. TD-04's presigned-multipart flow puts the bytes outside the API's control by design, so the limit cannot be enforced by reading the stream. The enforcement point is a strategic choice with different failure modes (reject before signing vs. detect after the fact vs. let storage refuse). Explicit choice: run `/research phase-03-videos` to add a TD covering upload admission control (typical resolutions: `content-length-range` conditions in the presigned policy, validating the declared size/MIME at the create-upload endpoint, or post-completion verification in the worker with a reject path into the `failed` status of TD-10).

### Dependency Gaps

_None._

Checked and clear — every prerequisite this phase leans on is delivered by a prior phase and visible in `## Inherited Conventions` / `## Inherited Decisions Detail`:

- Videos belong to a channel → channels (1:1 with user, created at registration) delivered in Phase 02.
- Protected upload endpoints → global JWT guard + `@Public()` convention delivered in Phase 02.
- Config for the new storage/queue env vars → namespaced `registerAs` factories (phase-01/TD-03) + Joi env validation (phase-01/TD-02).
- Error contract for the new endpoints → `{ statusCode, error, message }` domain exception filter (phase-02-auth/TD-07).
- Within-phase ordering is documented rather than implied: TD-05 states its dependency on TD-04's API-brokered completion, and TD-09 depends on TD-02's bucket policy split.

### Inherited Constraint Conflicts

- **ICC-1** — TD-09 (`Cross-layer`, Playback Streaming and Download Delivery) recommends the browser fetch video bytes **directly from object storage** via presigned GET. The inherited frontend posture points the other way: `phase-02-auth-frontend/TD-01`'s recommendation states that *"the strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller"*, and that TD-03 is titled *"Strict BFF — single server-only `API_URL`"*. Under a strict single-origin BFF the browser talks only to the Next.js origin; TD-09 requires a second browser-visible origin (the storage endpoint). The conflict is not clear-cut in either direction — `docs/diagrams/software-arch.mermaid` explicitly draws `Rel(frontend, storage, "Streams", "HTTPS")`, which sanctions the direct path, and strict-BFF is worded as constraining *NestJS* calls specifically, not all network egress. It nevertheless needs an explicit ruling before `/plan-build`, because it decides whether the phase exposes a storage origin to the browser at all, and it is tightly coupled to MD-1. Explicit choice: either (a) affirm that strict-BFF governs API calls only and the storage origin is an accepted second origin (aligning with the C4 diagram), or (b) keep a single origin and revisit TD-09 toward an API/BFF-proxied range path — accepting the throughput cost that TD-09's Option A documents.

### Unresolved Open Questions

All 11 TDs of this slice are still `pending`. This is the expected state immediately after `/research`; `/plan-resolve` is the stage that records the decisions.

- **OQ-1** — TD-01 pending — Object Storage Client Library. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate 03`.
- **OQ-2** — TD-02 pending — Bucket Topology and Object Key Layout. Resolution: as above.
- **OQ-3** — TD-03 pending — Background Processing Queue Technology. Resolution: as above.
- **OQ-4** — TD-04 pending — 10GB Upload Protocol. Resolution: as above.
- **OQ-5** — TD-05 pending — Draft Pre-registration and Upload-Completion Handshake. Resolution: as above.
- **OQ-6** — TD-06 pending — Video Worker Process Topology. Resolution: as above.
- **OQ-7** — TD-07 pending — FFmpeg Invocation for Metadata Extraction and Thumbnail. Resolution: as above.
- **OQ-8** — TD-08 pending — Unique Public Video URL Identifier. Resolution: as above.
- **OQ-9** — TD-09 pending — Playback Streaming and Download Delivery. Resolution: as above; see also ICC-1.
- **OQ-10** — TD-10 pending — Video Status Lifecycle and Processing-Failure Policy. Resolution: as above.
- **OQ-11** — TD-11 pending — Integration-Test Strategy for Storage and Queue. Resolution: as above.

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent from context.md (`ui_in_scope: false`), so UIG-N is not a concept for this phase. Phase 03 delivers no screen; the enunciado states the video interface is out of scope.

Also suppressed for the same reason: the shared-types contract-sync sub-type of Check 3 (Decisão #29), which fires only when `ui_in_scope ∈ {true, logic-only}`.

## Resolved Issues

_No issues resolved yet._
