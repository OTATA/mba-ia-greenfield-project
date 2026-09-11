---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-11T13:10:16+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-11T13:02:31+00:00"
issues:
  - id: AMB-1
    status: open
    summary: "Streaming/download audience undefined — anonymous viewers or owner only?"
  - id: AMB-2
    status: open
    summary: "Draft pre-registration required fields undefined; title boundary with Phase 04"
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
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Storage Endpoint Addressing for Presigned URLs"
  - id: OQ-13
    status: open
    summary: "TD-13 pending — Upload Admission Control (10GB ceiling + content types)"
advisories: []
---

# phase-03-videos — Validation

## Findings

**Change since the previous revision:** the two `MD-N` issues are gone. `/research` added TD-12 (storage endpoint addressing) and TD-13 (upload admission control) to the slice, so the decisions now *exist* — they are simply not yet made. Per Check 3's rule that a pending TD belongs in `OQ-N` and not `MD-N`, they moved to **OQ-12** and **OQ-13**. Issue count is unchanged at 16, but the composition shifted from `2 AMB + 2 MD + 1 ICC + 11 OQ` to `2 AMB + 1 ICC + 13 OQ`. Nothing left in the set now requires new research — every remaining issue is resolvable by `/plan-resolve`.

### Inconsistencies

_None._

Checked and clear:

- All 13 TDs cite a `Capability:` that matches a `## Scope` bullet verbatim; `## Capability Coverage` shows 9/9 bullets covered with no `—` rows.
- No decided TD contradicts a scope bullet — vacuously true, no TD is decided yet.
- **Scope-Subsection orphan check does not fire.** Scope distribution is 7 × `Backend` + 6 × `Cross-layer`, zero `Scope: Frontend`. The check targets `Scope: Frontend` with no active UI scope; `Cross-layer` is explicitly exempt. TD-12 and TD-13 are both `Cross-layer`, so adding them did not introduce an orphan.
- UI ↔ Scope inconsistency skipped — `## UI Inventory` absent.

### Ambiguities

- **AMB-1** — Capability *"Download do vídeo pelo usuário"* (and, by extension, *"Reprodução via streaming (sem necessidade de download completo)"*) does not say **which** user. `docs/project-plan.md` § Visão Geral settles watching for anonymous users — "Usuários anônimos podem assistir livremente" — but is silent on downloading. TD-09 says the API "authorizes and returns a presigned URL" without deciding *who* is authorized, and TD-12 now inherits the same gap for the public endpoint it introduces. This drives the Authorization Matrix, whether the endpoints carry `@Public()`, and the presigned-URL TTL policy, so `/plan-build` cannot derive the SI without it. Explicit choice: decide whether streaming and download are (a) both anonymous, (b) both authenticated, or (c) streaming anonymous + download authenticated — and record it on TD-09.

- **AMB-2** — Capability *"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"* does not state which fields the draft row carries at creation. The Phase 04 boundary is genuinely fuzzy: that phase owns *"Edição das informações do vídeo: título, descrição, categoria e thumbnail customizada"*, so it is unclear whether Phase 03 must accept a title at upload start, derive a provisional one from the filename, or leave it null until Phase 04. This fixes the `NOT NULL` constraints in the CreateVideos migration — expensive to reverse once shipped. Note TD-13 now requires the client to declare size and MIME at create-upload, which partially specifies that request but says nothing about the descriptive fields. Explicit choice: fix the minimum draft payload for Phase 03 and state which columns stay nullable until Phase 04.

### Missing Decisions

_None._ — both prior `MD-N` issues are closed by the arrival of TD-12 and TD-13. The uncovered-bullet sub-type finds no gaps (9/9 covered), and the error-response-format sub-type is satisfied by the inherited `phase-02-auth/TD-07` domain exception filter.

The shared-types contract-sync sub-type (Decisão #29) does not fire: it requires `ui_in_scope ∈ {true, logic-only}`, and this phase is `ui_in_scope: false`.

### Dependency Gaps

_None._

Every prerequisite is delivered by a prior phase and visible in `## Inherited Conventions` / `## Inherited Decisions Detail`: channels from Phase 02 (videos belong to a channel), the global JWT guard from Phase 02 (protected upload endpoints), namespaced `registerAs` config + Joi env validation from Phase 01 (the new storage/queue/endpoint variables TD-12 introduces), and the `{ statusCode, error, message }` contract from `phase-02-auth/TD-07`.

Within-phase ordering is documented rather than implied, and the two new TDs strengthen this: TD-12 declares `Depends on: TD-04, TD-09`, and TD-13 declares `Depends on: TD-04, TD-05, TD-07, TD-10`.

### Inherited Constraint Conflicts

- **ICC-1** — TD-09 (`Cross-layer`, Playback Streaming and Download Delivery) recommends the browser fetch video bytes **directly from object storage** via presigned GET, and TD-12 now builds on that by introducing a browser-reachable storage endpoint. The inherited frontend posture points the other way: `phase-02-auth-frontend/TD-01`'s recommendation states that *"the strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller"*, and that TD-03 is titled *"Strict BFF — single server-only `API_URL`"*. Under a strict single-origin BFF the browser talks only to the Next.js origin; TD-09 + TD-12 require a second browser-visible origin. The conflict is not clear-cut: `docs/diagrams/software-arch.mermaid` explicitly draws `Rel(frontend, storage, "Streams", "HTTPS")`, and strict-BFF is worded as constraining *NestJS* calls specifically rather than all egress. It still needs an explicit ruling before `/plan-build`, because it decides whether the phase exposes a storage origin at all — and TD-12 is entirely predicated on the answer. Explicit choice: either (a) affirm that strict-BFF governs API calls only and the storage origin is an accepted second origin (aligning with the C4 diagram, and keeping TD-12 meaningful), or (b) keep a single origin and revisit TD-09 toward an API-proxied range path — which would also collapse TD-12 to the upload leg only.

> **Scope note (deviation from Check 5's literal wording, stated deliberately).** Check 5 is specified over *decided* current-scope TDs, and all 13 TDs here are still pending — read literally, this category would be empty. ICC-1 is nevertheless retained because the conflict is real and already documented, and because surfacing it only *after* TD-09 is decided would be strictly worse: `/plan-resolve` would ask the user to decide TD-09 blind to the inherited posture, and the next `/plan-validate` would then raise ICC-1 and force an extra resolve cycle. Raising it pre-decision lets the same resolve run settle TD-09 and ICC-1 together. The issue is raised against TD-09's `**Recommendation:**`, not against a decision.

### Unresolved Open Questions

All 13 TDs of this slice are `pending`. This is the expected state after `/research`; `/plan-resolve` is the stage that records decisions.

- **OQ-1** — TD-01 pending — Object Storage Client Library. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate 03`.
- **OQ-2** — TD-02 pending — Bucket Topology and Object Key Layout. Resolution: as above.
- **OQ-3** — TD-03 pending — Background Processing Queue Technology. Resolution: as above.
- **OQ-4** — TD-04 pending — 10GB Upload Protocol. Resolution: as above.
- **OQ-5** — TD-05 pending — Draft Pre-registration and Upload-Completion Handshake. Resolution: as above.
- **OQ-6** — TD-06 pending — Video Worker Process Topology. Resolution: as above.
- **OQ-7** — TD-07 pending — FFmpeg Invocation for Metadata Extraction and Thumbnail. Resolution: as above.
- **OQ-8** — TD-08 pending — Unique Public Video URL Identifier. Resolution: as above.
- **OQ-9** — TD-09 pending — Playback Streaming and Download Delivery. Resolution: as above; decide together with ICC-1 and AMB-1.
- **OQ-10** — TD-10 pending — Video Status Lifecycle and Processing-Failure Policy. Resolution: as above.
- **OQ-11** — TD-11 pending — Integration-Test Strategy for Storage and Queue. Resolution: as above.
- **OQ-12** — TD-12 pending — Storage Endpoint Addressing for Presigned URLs. Resolution: as above; depends on how ICC-1 is ruled (option (b) there would narrow this TD to the upload leg).
- **OQ-13** — TD-13 pending — Upload Admission Control (10GB ceiling + accepted content types). Resolution: as above.

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent from context.md (`ui_in_scope: false`), so UIG-N is not a concept for this phase. Phase 03 delivers no screen; the enunciado places the video interface out of scope.

## Resolved Issues

_No issues resolved yet._

The two prior `MD-N` entries are intentionally **not** listed here: `/plan-resolve` never ran to completion (it aborted at its Step 2 MD-N gate), so nothing was ever marked `resolved`. They ceased to fire because this run re-evaluated the checks against a context.md that now contains TD-12 and TD-13 — the audit trail for that transition lives in the `## Findings` preamble above and in the git history of this file.
