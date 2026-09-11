---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-09-11
scope_description: "Backend foundation for large-file video upload and asynchronous processing: object storage client and key layout, background queue technology, the 10GB upload protocol, upload-completion handshake, worker process topology, FFmpeg metadata/thumbnail extraction, unique public video URL, streaming/download delivery, video status lifecycle, and the integration-test strategy for the new infrastructure."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (draft pre-registration, presigned upload brokering, completion handshake, playback/download URL issuing), the video worker process (FFmpeg metadata + thumbnail), and the new Compose infrastructure (object storage, queue broker, worker).
- `next-frontend/` — **No open decision in this document.** The video interface is explicitly out of scope for Phase 03; the phase's capability bullets contain no screen. The four `Cross-layer` TDs below (TD-04, TD-05, TD-08, TD-09) nevertheless fix the client↔server contract now — upload handshake, completion call, public URL shape, and playback/download delivery — so that the frontend phase consumes a settled contract instead of reopening it.

> **Tooling note — `context7` MCP is not configured in this repository.** `CLAUDE.md` mandates library documentation lookup via `context7`, but `.mcp.json` declares only `postgres` (and `figma` in `.mcp.json.example`); `context7` has never been present in the repo's git history. Library facts in this document were therefore sourced from the **npm registry API** (versions, `engines`, `peerDependencies`, module type, deprecation flags — queried 2026-09-11) and **official vendor documentation** (AWS S3 User Guide, MinIO docs). Every version claim below is traceable to one of those. This gap should be closed before `/plan-resolve` produces `library-refs.md`.

**Verified stack baseline (2026-09-11):** NestJS 11 · TypeScript 5.9.3 · Node 25.6.0 · PostgreSQL 17 · TypeORM 0.3.28 · CommonJS output (`module: nodenext`, no `"type": "module"`).

**Verified ESM finding that affects several TDs below:** `pg-boss@12.31.0` and `nanoid@6.0.1` are now ESM-only (`"type": "module"`). This was empirically probed inside the project container against a synthetic ESM-only package: under TS 5.9.3 + Node 25.6.0 with `module: nodenext`, both `tsc --noEmit` (exit 0) and runtime `require(esm)` succeed. **ESM-only is therefore not a blocker** for this stack — it is a minor friction point only (it breaks if the dependency ever adopts top-level await). Options below are scored accordingly, not on the stale "ESM-only is unusable in CJS Nest" assumption.

---

## TD-01: Object Storage Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The object storage backend itself is not open — `docs/project-plan.md` and the C4 diagram fix it as "S3 or MinIO", meaning MinIO locally and real S3 in production. What is open is which Node client the API and worker use to talk to it, since that choice determines whether the same code runs unmodified against both.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 (+ `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`)
- Official AWS SDK v3, modular packages. Points at MinIO via `endpoint` + `forcePathStyle: true`. Version 3.1130.0 (2026-09-10), CommonJS, `engines.node >= 20`.
- **Pros:** Same code runs against MinIO and real S3 with only an env change — exactly the stated portability goal. First-party presigner covers both single-object and per-part presigning (TD-04). Command-object API is straightforward to unit-test. Actively released (daily cadence).
- **Cons:** Larger dependency surface (`@smithy/*` transitive tree). Verbose command-per-operation API. Presigning multipart parts requires manual composition rather than a one-call helper.

### Option B: `minio` JS client
- MinIO's own SDK, version 8.0.7 (2026-02-27), CommonJS, `engines.node ^16 || ^18 || >=20`. Higher-level helpers (`fPutObject`, `presignedPutObject`, `presignedGetObject`).
- **Pros:** Noticeably simpler API for the common operations. Smaller dependency tree. Built-in helpers for presigned GET/PUT reduce boilerplate.
- **Cons:** Vendor-specific client — swapping to real S3 in production means swapping libraries, which defeats the portability the architecture calls for. Slower release cadence (last publish ~7 months before AWS SDK's). Weaker multipart presigning story.

**Recommendation:** **Option A (`@aws-sdk/client-s3` v3)** — the architecture explicitly targets "S3 or MinIO" as one interchangeable container, and only the AWS SDK honours that with a single codebase. The extra verbosity is absorbed once inside a `StorageService` wrapper; the portability is structural and cannot be retrofitted cheaply.

**Decision:** _[pending]_

---

## TD-02: Bucket Topology and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Video files and thumbnails have opposite access profiles: a video must never be world-readable (it is served through short-lived signed URLs, TD-09), while a thumbnail is a small image shown in listings where signing every URL is pure overhead. Buckets are the unit at which an access policy is applied, so the split is decided here. The key layout is a cross-component contract — the API writes the key, the worker reads and derives from it, and the DB stores it.

**Options:**

### Option A: Single private bucket, prefix-separated (`videos/…`, `thumbnails/…`)
- One bucket, one policy. Every read — video and thumbnail alike — goes through a presigned GET.
- **Pros:** Simplest provisioning: one bucket to create and healthcheck. One policy to reason about. Uniform read path.
- **Cons:** Thumbnails must be presigned too, so a listing of N videos costs N signing operations and the URLs expire (uncacheable by CDN/browser). Anonymous viewers are a first-class requirement of this product, making expiring thumbnail URLs a poor fit.

### Option B: Two buckets — `streamtube-videos` (private) + `streamtube-thumbnails` (public read)
- Videos stay private and are reached only via presigned GET; thumbnails are served by a plain, stable, cacheable URL.
- **Pros:** Each asset class gets the policy it actually needs. Thumbnail URLs are permanent and CDN-cacheable — no signing cost per listing. Clear blast radius: a thumbnail-bucket misconfiguration cannot expose video content.
- **Cons:** Two buckets to provision and healthcheck. Two policies. The public bucket must be scoped to read-only, which is one more thing to get right.

### Option C: One bucket partitioned by channel (`{channelId}/videos/…`)
- Keys are grouped by owning channel rather than by asset type.
- **Pros:** Natural fit for per-channel operations (bulk delete a channel, per-channel usage accounting).
- **Cons:** Cannot separate video and thumbnail policies at all — the core requirement here. Leaks the ownership graph into the key namespace, so moving a video between channels rewrites keys. Solves a problem Phase 03 does not have.

**Recommendation:** **Option B (two buckets)** — the access profiles genuinely differ, and bucket-level policy is the correct place to express that. Suggested keys: `videos/{videoId}/original{ext}` and `thumbnails/{videoId}/frame.jpg`. Keying by the internal `videoId` (not the public URL id from TD-08) keeps storage stable if the public id is ever rotated.

**Decision:** _[pending]_

---

## TD-03: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** This is the phase's principal stack decision — `docs/diagrams/software-arch.mermaid` literally marks the Message Queue container as `TBD`. The queue carries video-processing jobs that are **long-running** (FFmpeg over files up to 10GB) and **low-volume** (a handful of uploads at a time). Durability and stalled-job recovery therefore matter far more than throughput. PostgreSQL 17 is already in the Compose stack; Redis and RabbitMQ are not.

**Options:**

### Option A: BullMQ + Redis, via `@nestjs/bullmq`
- `bullmq@6.3.4` (CommonJS) driven by the official Nest wrapper `@nestjs/bullmq@12.0.0`, whose peer range `@nestjs/core ^10 || ^11 || ^12` covers the installed NestJS 11. Adds a Redis service to Compose.
- **Pros:** Official first-party Nest integration, matching how every other infrastructure concern in this project is wired (`@nestjs/typeorm`, `@nestjs/jwt`, `@nestjs/throttler`, `@nestjs/config`). Purpose-built for long jobs: `lockDuration` + lock renewal and automatic stalled-job recovery, which is exactly the FFmpeg failure mode. Retries with backoff, concurrency control, and a failed-job set are built in. Largest ecosystem by a wide margin (~3.2M weekly downloads).
- **Cons:** Introduces Redis — a new container, and a second durability model to reason about (job durability now depends on Redis persistence config, not Postgres' WAL).

### Option B: pg-boss on the existing PostgreSQL
- `pg-boss@12.31.0`, a queue implemented on Postgres `SKIP LOCKED`. Requires `node >= 22.12` (satisfied: Node 25.6) and `pg ^8.23` (project has `pg ^8.20` — a **minor bump is required**). ESM-only, which this stack handles (see baseline note).
- **Pros:** Zero new infrastructure — the strongest argument by far. Jobs are ordinary rows, so enqueue can join the same transaction that pre-registers the video draft, giving exactly-once enqueue semantics for free. ACID durability inherited from a database the project already backs up and already tests against.
- **Cons:** No official Nest module — wiring, lifecycle and DI are hand-rolled (community wrappers exist but are unmaintained relative to `@nestjs/bullmq`). Long-job safety rests on `expireInSeconds`, a blunter instrument than BullMQ's renewable locks: an FFmpeg run that legitimately overruns the expiry is re-queued and duplicated. Requires bumping `pg`. Far smaller ecosystem (~312K weekly downloads).

### Option C: RabbitMQ via `@golevelup/nestjs-rabbitmq` or `@nestjs/microservices`
- A real AMQP broker with exchanges, routing keys and native dead-letter queues.
- **Pros:** Genuine message-broker semantics, first-class DLQ, and the natural choice if the system later grows fan-out to several independent consumers.
- **Cons:** Heaviest operational footprint of the three for a single producer and a single consumer. No job-level retry/backoff or progress reporting without building it. `@nestjs/microservices` models RPC rather than a work queue; the capable adapter is third-party. Substantial complexity bought for routing flexibility this phase does not need.

**Recommendation:** **Option A (BullMQ + Redis)** — the deciding factor is stalled-job handling for long FFmpeg runs. BullMQ renews a worker's lock while the job is alive and recovers it if the worker dies; pg-boss's fixed expiry either kills legitimate long jobs or leaves dead ones stuck, and getting that window right for a file range of a few MB to 10GB is guesswork. The official `@nestjs/bullmq` module also matches the project's established "first-party Nest integration where one exists" pattern. pg-boss is a genuinely strong runner-up whose "no new container" advantage is real — if the reviewer weights infrastructure minimalism above lock semantics, it is a defensible choice, but it must then pair with a conservatively long `expireInSeconds` and an explicit idempotency guard on the processing job.

**Decision:** _[pending]_

---

## TD-04: 10GB Upload Protocol

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The defining constraint of the phase, and the one the challenge calls out as automatic failure if solved by brute force. The file must never transit the NestJS process. Hard numbers from the AWS S3 User Guide (verified 2026-09-11): a single `PutObject` tops out at **5 GiB**; multipart allows **10,000 parts** of **5 MiB–5 GiB** each, up to 48.8 TiB total. Both sides of the wire are affected, so this is one contract, decided once.

**Options:**

### Option A: Proxy the upload through the API (`multipart/form-data`)
- The browser POSTs the file to NestJS, which streams it on to storage.
- **Pros:** Simplest client. The API sees the bytes, so it can validate content inline.
- **Cons:** Disqualified. Ties up a Node process and a socket for the entire transfer, defeating "sem impacto na performance"; any restart loses the whole upload; no resumability. Listed only to record the rejection.

### Option B: Single presigned `PUT`
- API returns one presigned URL; the browser PUTs the whole file straight to storage.
- **Pros:** Very simple — one signature, one request, no completion bookkeeping. Bytes never touch the API.
- **Cons:** **Cannot satisfy the requirement**: S3's single-PUT ceiling is 5 GiB, less than the mandated 10GB. No resumability — one dropped connection at 9GB restarts from zero.

### Option C: Presigned multipart upload brokered by the API
- API calls `CreateMultipartUpload` and hands back per-part presigned `UploadPart` URLs; the browser uploads parts (in parallel, retrying individually) and returns the `{ PartNumber, ETag }` list; the API calls `CompleteMultipartUpload`.
- **Pros:** Meets 10GB with room to spare (e.g. 64 MiB parts → 160 parts, far under the 10,000 cap). Bytes bypass the API entirely. Per-part retry and parallelism come for free. The API keeps control of authorization and of the completion moment, which TD-05 depends on. Pure S3 semantics — identical against MinIO and real S3.
- **Cons:** Most moving parts of the three: three endpoints, client-side chunking, and abandoned uploads need a lifecycle rule (`AbortIncompleteMultipartUpload`) so orphaned parts stop accruing storage.

### Option D: tus resumable protocol (`@tus/server` 2.4.5)
- An open resumable-upload protocol fronted by a tus server component.
- **Pros:** Best-in-class resumability, including across browser sessions. Mature client libraries. Protocol-level offset negotiation.
- **Cons:** Adds a protocol and a server component outside the S3 model, and the tus endpoint becomes a byte-path component to run and scale — reintroducing a variant of the problem Option C avoids. Larger conceptual surface than the phase needs.

**Recommendation:** **Option C (presigned multipart brokered by the API)** — the only option that both clears the 10GB bar and keeps the file off the API process, using nothing but standard S3 semantics that work identically on MinIO today and S3 later. Option B is arithmetically excluded by the 5 GiB single-PUT limit; Option A is the documented anti-pattern. Pair with a bucket lifecycle rule aborting incomplete uploads after ~24h.

**Decision:** _[pending]_

---

## TD-05: Draft Pre-registration and Upload-Completion Handshake

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Two capability bullets meet at one handshake. The video row must exist as a draft *before* bytes flow (so the upload has an id to attach to), and processing must start *automatically* once the last byte lands. What decides this TD is how the system learns that the upload finished, because that event is what enqueues the job.

**Options:**

### Option A: API-brokered completion (the client's `complete` call is the signal)
- Because TD-04 routes `CompleteMultipartUpload` through the API, the API is already the component that finalizes the object. It marks the row `processing` and enqueues the job in the same request.
- **Pros:** No extra mechanism — the signal is a call the chosen upload protocol already requires. Synchronous and immediate. The API can validate ownership and part list before accepting. Enqueue and status transition sit in one transaction boundary.
- **Cons:** A client that uploads every part then never calls `complete` leaves a row stuck in `uploading`; needs a reconciliation sweep to clean up.

### Option B: MinIO bucket notification webhook
- MinIO publishes `s3:ObjectCreated:CompleteMultipartUpload` to a webhook target; the API endpoint receives it and enqueues.
- **Pros:** Storage-authoritative — fires on the real object, so it cannot disagree with what is actually stored. Catches completions the client never reported. MinIO supports a webhook target natively (also AMQP, Redis, Postgres, Kafka, NATS…).
- **Cons:** Requires a publicly reachable, authenticated webhook endpoint and MinIO-side event configuration in Compose. Event delivery is at-least-once, so the handler must be idempotent. Couples the API to a storage-vendor feature that is configured, not coded — harder to exercise in tests. Redundant with Option A given the API already brokers completion.

### Option C: Scheduled reconciliation polling
- A periodic job lists storage and promotes any object whose row is still `uploading`.
- **Pros:** Self-healing by construction; no webhook infrastructure.
- **Cons:** Adds latency proportional to the poll interval — "processamento automático" becomes "eventually". Wasteful listing. Poor fit as the primary path.

**Recommendation:** **Option A (API-brokered completion)** — TD-04 already routes completion through the API, so the signal exists for free and no vendor-specific eventing is needed; this also keeps the flow fully exercisable in integration tests. Adopt Option C narrowly as a **janitor**, not a trigger: a low-frequency sweep that aborts incomplete multipart uploads and fails rows abandoned in `uploading` past a TTL. Option B is the right hardening step only if a non-first-party client is ever allowed to upload.

**Decision:** _[pending]_

---

## TD-06: Video Worker Process Topology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram models the Video Worker as a container distinct from the API. Beyond the diagram there is a hard packaging reason: the worker needs the FFmpeg binaries and the API does not, and FFmpeg materially inflates the image. This TD settles how the worker is built, booted and deployed.

**Options:**

### Option A: Separate container, shared codebase, own entrypoint
- One repository and one `src/`, with a second bootstrap file (e.g. `src/worker.main.ts`) started via `NestFactory.createApplicationContext()` — a Nest DI context with no HTTP listener. A dedicated `Dockerfile.worker` installs `ffmpeg`/`ffprobe`. Compose runs it as its own service.
- **Pros:** Matches the architecture diagram. Entities, config, DataSource and the storage service are imported directly — no duplication, no drift. Worker scales and restarts independently of the API. Only the worker image carries FFmpeg. Crash in processing cannot take down the API.
- **Cons:** A second Dockerfile and Compose service. Two entrypoints to keep in mind. Shared modules must not assume an HTTP context.

### Option B: In-process BullMQ worker inside the API container
- The API registers the processor and consumes its own queue.
- **Pros:** Least infrastructure — no new service, no new image. Simplest local run.
- **Cons:** Contradicts the C4 diagram. A 10GB FFmpeg run competes with request handling for CPU and event-loop time — the precise "impacto na performance" the phase forbids. Forces FFmpeg into the API image. Cannot scale processing independently. A processing OOM kills the API.

### Option C: Fully separate project/package
- A standalone worker application with its own manifest and dependencies.
- **Pros:** Hardest isolation boundary; the worker could even be a different language.
- **Cons:** Entities, config and migrations must be duplicated or extracted into a shared package — real work, and a standing drift risk. Disproportionate for one consumer sharing the same data model.

**Recommendation:** **Option A (separate container, shared codebase)** — it is the only option that satisfies the diagram and the isolation requirement without duplicating the data model. `createApplicationContext()` is the standard Nest idiom for a non-HTTP process and gives the worker the same DI graph the API uses.

**Decision:** _[pending]_

---

## TD-07: FFmpeg Invocation for Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must read duration and technical metadata, and cut one frame as a thumbnail. In Node the reflexive answer has always been `fluent-ffmpeg` — but that is no longer viable, which makes this a real decision rather than a formality.

**Decisive fact (verified on the npm registry, 2026-09-11):** `fluent-ffmpeg@2.1.3` is flagged **deprecated** — *"Package no longer supported."* — with its last publish on **2024-05-19**; the GitHub repository was archived read-only in May 2025 and is documented as not working correctly with recent FFmpeg releases.

**Options:**

### Option A: `fluent-ffmpeg`
- The historical fluent wrapper around the FFmpeg CLI.
- **Pros:** Enormous body of existing examples and tutorials. Pleasant chainable API.
- **Cons:** **Deprecated and archived**; no security or compatibility maintenance; known breakage against current FFmpeg. Adopting a dead dependency at the centre of the phase's processing path is not defensible.

### Option B: Direct `child_process` invocation of `ffmpeg` / `ffprobe`
- The worker spawns the binaries itself: `ffprobe -v quiet -print_format json -show_format -show_streams` for metadata, and `ffmpeg -ss <t> -i <in> -frames:v 1` for the thumbnail. Binaries are installed in the worker image (TD-06).
- **Pros:** No dependency to rot — the FFmpeg CLI is the most stable contract in this space, and `-print_format json` yields structured output directly. Full control over flags. Trivially unit-testable by injecting a spawn wrapper, and honestly integration-testable against the real binary. Zero supply-chain surface.
- **Cons:** Argument arrays and error handling are hand-written. Must parse `ffprobe` JSON into typed objects. Requires disciplined handling of spawn errors, non-zero exits and timeouts.

### Option C: A maintained third-party wrapper (e.g. `@ts-ffmpeg/fluent-ffmpeg`, `mediaforge`)
- Community successors offering a fluent API with TypeScript types.
- **Pros:** Retains ergonomic chaining. Native typings. Less boilerplate than raw spawning.
- **Cons:** Young, low-adoption packages with no track record — swapping one abandonment risk for another, at the core of the phase. Forks still carry the upstream deprecation notice. Thin value over spawning given how few FFmpeg operations this phase needs (exactly two).

**Recommendation:** **Option B (direct `child_process`)** — with only two operations required, a wrapper earns very little, while the CLI contract it would hide is precisely the part that is stable. `ffprobe -print_format json` is effectively a structured API already. This also keeps the phase free of a dependency whose predecessor just died mid-project.

**Decision:** _[pending]_

---

## TD-08: Unique Public Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a collision-free public identifier for its URL. The shape is a client↔server contract (it appears in every link the frontend builds), and it also decides whether the internal primary key is exposed. Note the project already hand-rolls secure random tokens with `node:crypto` in the auth module — precedent worth matching.

**Options:**

### Option A: Reuse the UUID primary key in the URL
- `/videos/{uuid}` using the existing `@PrimaryGeneratedColumn('uuid')`.
- **Pros:** Zero extra column, zero extra code, collision-free by construction. One identifier to reason about.
- **Cons:** 36 characters — long and unfriendly in a share link. Exposes the internal PK directly, so the public URL and the storage/DB identity can never diverge.

### Option B: Dedicated short `public_id` generated with `nanoid`
- A separate unique column, e.g. an 11-character id in the style of YouTube.
- **Pros:** Compact, URL-safe, shareable. Decouples the public identifier from the internal PK. Well-known, audited generator.
- **Cons:** `nanoid@6.0.1` is ESM-only (workable here — see baseline — but still friction), and it is a dependency added for a single function the platform already provides.

### Option C: Dedicated short `public_id` generated with `node:crypto`
- Same column and semantics as B, but the id comes from `randomBytes(8).toString('base64url')` (~11 chars, 64 bits of entropy) with a unique index and retry-on-conflict.
- **Pros:** All of B's benefits with **no new dependency**. Matches the existing auth-module precedent of generating tokens from `node:crypto`. Entropy and length are tuned explicitly rather than inherited.
- **Cons:** A few lines of generation-and-retry logic to write and test. Alphabet and collision handling are the project's responsibility rather than a library's.

**Recommendation:** **Option C (`node:crypto` short id)** — it delivers exactly what Option B delivers while staying consistent with how this codebase already generates opaque identifiers, and without adding a dependency for one call. Enforce uniqueness with a DB unique index and retry on violation; 64 bits makes a collision negligible at this scale, and the index makes it impossible rather than merely unlikely.

**Decision:** _[pending]_

---

## TD-09: Playback Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Two capability bullets served by one delivery mechanism. Playback must start without fetching the whole file — i.e. HTTP `Range` / `206 Partial Content` — and the same object must also be downloadable. The C4 diagram already draws `Frontend → Object Storage: "Streams", HTTPS`, i.e. bytes are not meant to flow through the API on the read path either.

**Options:**

### Option A: The API proxies byte ranges
- The client requests the API with a `Range` header; NestJS issues `GetObject` with that range and pipes the result back via `StreamableFile`.
- **Pros:** Storage stays entirely private with no signed URLs to manage. The API can authorize, count views, and enforce policy per request.
- **Cons:** Puts the API back on the byte path for reads — the same pressure TD-04 removed from writes, now sustained for the whole watch duration of every viewer. Contradicts the architecture diagram. Node becomes the streaming bottleneck and scales with concurrent viewers rather than with requests.

### Option B: Short-lived presigned `GET` URLs, client streams from storage
- The API authorizes and returns a presigned URL; the browser's `<video>` element issues its own `Range` requests straight to MinIO/S3, which serves `206` natively. Download uses the same mechanism with `response-content-disposition=attachment`.
- **Pros:** Matches the diagram exactly. Range handling is the storage layer's job and it already does it correctly. API cost is one signature per view, independent of file size or watch time. Streaming and download differ only by one response-header override. Identical on MinIO and S3.
- **Cons:** URL expiry must be tuned — too short breaks long viewing sessions, too long weakens the link. A leaked URL is usable until it expires. View counting must hook the authorize call rather than the byte stream.

### Option C: HLS/DASH adaptive transcoding
- The worker segments each video into multiple renditions and serves a manifest.
- **Pros:** Adaptive bitrate, best experience on variable networks, industry standard for large-scale video.
- **Cons:** Multiplies processing cost and storage per video, and adds manifest/segment management — none of which any Phase 03 capability asks for. The phase requires progressive streaming, not adaptive. Substantial scope inflation.

**Recommendation:** **Option B (short-lived presigned GET)** — it is what the architecture diagram already specifies, it satisfies "sem necessidade de download completo" through native S3 `Range` support without writing any range code, and it covers the download bullet via a `content-disposition` override on the same primitive. Suggested expiry in the 15–60 min range, re-issued on demand. Option C is a legitimate future phase, not this one.

**Decision:** _[pending]_

---

## TD-10: Video Status Lifecycle and Processing-Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The challenge requires the status cycle (rascunho → processando → pronto/erro) to be visible in the database, and requires an explicit answer for what happens when processing fails. The state machine also has to accommodate the window in TD-05 where the draft exists but the bytes have not landed.

**Options:**

### Option A: Single status enum with an explicit upload state
- One column over `draft → uploading → processing → ready | failed`, plus a nullable `processing_error` for the failure reason. Retries are BullMQ `attempts` with exponential backoff; the row only reaches `failed` once retries are exhausted.
- **Pros:** One column, one source of truth, directly readable as the required cycle. `uploading` makes TD-05's abandoned-upload window explicit and sweepable instead of ambiguous. Enum is enforced by the DB. Retry policy lives in the queue, where it belongs, so transient FFmpeg failures never surface as `failed`.
- **Cons:** Conflates two concerns (upload progress and processing progress) into one axis, so a future "re-process a ready video" flow needs care to avoid an illegal transition.

### Option B: Two independent columns (`upload_status` + `processing_status`)
- Upload and processing tracked on separate axes.
- **Pros:** Cleanly separates concerns; re-processing without touching upload state is natural. More precise for a future admin view.
- **Cons:** Valid combinations must be enforced in application code — the DB cannot express "processing_status must be null while upload_status is pending". Every read has to interpret two columns to answer one question. More state than the phase's four documented states justify.

### Option C: Event-sourced status history table
- Append-only transitions; current status is derived.
- **Pros:** Full audit trail, natural home for timing metrics and debugging.
- **Cons:** Every status read becomes a join or a maintained projection. Substantial machinery for a requirement that asks only for the current status to be reflected in the DB.

**Recommendation:** **Option A (single enum + `processing_error`)** — it maps one-to-one onto the required cycle, keeps the reflected state trivially queryable, and delegates retry to BullMQ (TD-03) so that only genuinely terminal failures are persisted as `failed`. Record the reason in `processing_error` so a failed video can be diagnosed without reading worker logs.

**Decision:** _[pending]_

---

## TD-11: Integration-Test Strategy for Storage and Queue

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)"

**Context:** Phase 03 adds three pieces of infrastructure that the existing suite has no pattern for. The project's established convention is to test against real services from Compose — integration tests hit the real PostgreSQL, and the mail tests hit a real Mailpit through its HTTP API rather than mocking the transport. This TD decides whether object storage and the queue follow that precedent.

**Options:**

### Option A: Real MinIO and Redis from Compose
- Integration tests exercise the actual services the app runs against, mirroring the existing Postgres/Mailpit approach.
- **Pros:** Consistent with the convention already proven in this repo. Catches the failures that actually happen here — presigned-URL signing, path-style addressing, multipart assembly, `Range` responses — none of which a mock reproduces. Directly satisfies the challenge's "não mocke o que dá para testar de verdade com a infra do Compose".
- **Cons:** Tests require the full stack running. Slower than mocks. Buckets and queues need cleanup between specs, as tables already do.

### Option B: Mock the storage and queue interfaces
- Unit-level fakes behind the `StorageService` / queue abstractions.
- **Pros:** Fast, no infrastructure, trivially deterministic.
- **Cons:** Verifies only that the code calls its own abstraction — exactly the class of bug that does not occur. Signature mismatches against real S3 and MinIO go undetected. Contradicts both the repo convention and an explicit challenge requirement.

### Option C: Testcontainers-managed ephemeral instances
- Each run spins up throwaway MinIO/Redis containers.
- **Pros:** Perfect isolation; no cleanup logic; independent of a developer's running stack.
- **Cons:** Introduces a new testing dependency and a Docker-in-Docker/socket requirement inside the `nestjs-api` container. Noticeably slower startup. Diverges from the pattern every existing integration test follows, for isolation the shared-Compose approach already delivers adequately.

**Recommendation:** **Option A (real MinIO and Redis from Compose)** — it is the convention this repository already runs on, and it is what the phase explicitly demands. Keep the layering rules from `nestjs-project/CLAUDE.md`: real-service tests are `*.integration-spec.ts`, pure logic (e.g. `ffprobe` JSON parsing, key derivation) stays in `*.spec.ts` with mocks, and full HTTP flows are `*.e2e-spec.ts`. Add per-suite bucket/queue cleanup mirroring the existing `cleanAllTables` helper.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Client Library | `@aws-sdk/client-s3` v3 | _[pending]_ |
| TD-02 | Backend | Bucket Topology and Object Key Layout | Two buckets (private videos + public thumbnails) | _[pending]_ |
| TD-03 | Backend | Background Processing Queue Technology | BullMQ + Redis via `@nestjs/bullmq` | _[pending]_ |
| TD-04 | Cross-layer | 10GB Upload Protocol | Presigned multipart brokered by the API | _[pending]_ |
| TD-05 | Cross-layer | Draft Pre-registration and Completion Handshake | API-brokered completion (+ janitor sweep) | _[pending]_ |
| TD-06 | Backend | Video Worker Process Topology | Separate container, shared codebase | _[pending]_ |
| TD-07 | Backend | FFmpeg Invocation (metadata + thumbnail) | Direct `child_process` spawn | _[pending]_ |
| TD-08 | Cross-layer | Unique Public Video URL Identifier | Short `public_id` from `node:crypto` | _[pending]_ |
| TD-09 | Cross-layer | Playback Streaming and Download Delivery | Short-lived presigned `GET` | _[pending]_ |
| TD-10 | Backend | Video Status Lifecycle and Failure Policy | Single enum + `processing_error` | _[pending]_ |
| TD-11 | Backend | Integration-Test Strategy for Storage and Queue | Real MinIO + Redis from Compose | _[pending]_ |

## Sources

Version, module-format, engine and deprecation facts were read from the npm registry API on 2026-09-11 (`https://registry.npmjs.org/{package}`). Vendor documentation consulted:

- [Amazon S3 — Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [Amazon S3 — Multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)
- [MinIO — Bucket notification targets and events](https://docs.min.io/enterprise/aistor-object-store/administration/bucket-notifications/)
- [fluent-ffmpeg — repository (archived)](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) and [Phasing out fluent-ffmpeg (issue #1324)](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324)
