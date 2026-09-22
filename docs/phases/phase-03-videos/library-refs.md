---
libs:
  "@aws-sdk/client-s3":
    version: "3.1130.0"
    context7_id: "n/a — sourced from npm registry API + AWS S3 User Guide"
    fetched_at: "2026-09-11T13:23:03+00:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1130.0"
    context7_id: "n/a — sourced from npm registry API + package README"
    fetched_at: "2026-09-11T13:23:03+00:00"
  "bullmq":
    version: "6.3.4"
    context7_id: "n/a — sourced from npm registry API + docs.bullmq.io"
    fetched_at: "2026-09-11T13:23:03+00:00"
  "@nestjs/bullmq":
    version: "12.0.0"
    context7_id: "n/a — sourced from npm registry API"
    fetched_at: "2026-09-11T13:23:03+00:00"
  "ioredis":
    version: "5.11.1"
    context7_id: "n/a — sourced from npm registry API"
    fetched_at: "2026-09-11T13:23:03+00:00"
    note: "registry latest is 6.0.0, but the resolved tree pins 5.11.1 — see the ioredis section"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-11T13:19:34+00:00"
---

# phase-03-videos — Library References

> **Provenance note — built without `context7`.** `/plan-resolve` Step 5 nominally resolves library docs through the `context7` MCP, but `context7` is not configured in this repository (`.mcp.json` declares only `postgres`) and never has been in its git history. Per the user's decision on 2026-09-11, this cache was built instead from the **npm registry API** (`https://registry.npmjs.org/{package}` — authoritative for `dist-tags.latest`, publish date, `engines`, `peerDependencies`, module `type`, and the `deprecated` flag) plus **official vendor documentation**, with every claim traceable to a cited source. The `context7_id` fields above record `n/a` rather than a fabricated identifier.

**Stack baseline this cache was resolved against:** NestJS 11 · TypeScript 5.9.3 · Node 25.6.0 · CommonJS output (`module: nodenext`, no `"type": "module"`).

---

## Compatibility matrix

| Library | Latest | Published | Module type | Node engines | Fits this stack? |
|---|---|---|---|---|---|
| `@aws-sdk/client-s3` | 3.1130.0 | 2026-09-10 | CommonJS | `>=20.0.0` | ✅ Node 25.6 |
| `@aws-sdk/s3-request-presigner` | 3.1130.0 | 2026-09-10 | CommonJS | `>=20.0.0` | ✅ |
| `bullmq` | 6.3.4 | 2026-09-01 | CommonJS | `>=14.17.0` | ✅ |
| `@nestjs/bullmq` | 12.0.0 | 2026-08-27 | ESM (`type: module`) | — | ✅ see note below |
| `ioredis` | 6.0.0 | 2026-07-31 | CommonJS | `>=20.0.0` | ✅ |

**Peer-dependency checks (from the registry, not from memory):**

- `@nestjs/bullmq@12.0.0` declares `@nestjs/core: ^10 || ^11 || ^12` and `@nestjs/common: ^10 || ^11 || ^12` → the installed **NestJS 11** is in range.
- `@nestjs/bullmq@12.0.0` declares `bullmq: ^3 || ^4 || ^5 || ^6` → **bullmq 6.3.4** is in range.
- `bullmq@6.3.4` declares `ioredis: >=5.0.0` as a peer → **ioredis 6.0.0** satisfies it, and it must be installed explicitly (peers are not auto-installed as direct deps here).

**ESM note for `@nestjs/bullmq`.** The package is `"type": "module"`, but its `exports` map points both `import` and `require` at the same `./dist/index.js`. This stack was empirically probed (synthetic ESM-only package, inside the project container): under TS 5.9.3 + Node 25.6.0 with `module: nodenext`, both `tsc --noEmit` (exit 0) and runtime `require(esm)` succeed. **Not a blocker** — the only residual risk is a future release adopting top-level await, which `require(esm)` cannot handle.

---

## `@aws-sdk/client-s3`

Used by `StorageService` (API) and the video worker. Backs **TD-01**, **TD-02**, **TD-04**, **TD-12**.

Pointing at MinIO requires two non-default options — without `forcePathStyle`, the SDK builds virtual-hosted-style URLs (`bucket.host`) that MinIO does not serve by default:

```ts
new S3Client({
  endpoint: cfg.internalEndpoint,   // http://minio:9000
  forcePathStyle: true,
  region: cfg.region,               // any value; MinIO ignores it but SigV4 requires one
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

**TD-12 requires two client instances**, not one: the internal client (above) for server-side calls, and a second identical client whose `endpoint` is `S3_PUBLIC_ENDPOINT`, used **only** as the first argument to `getSignedUrl`. SigV4 signs the `Host` header, so the signing client's endpoint is what the resulting URL is valid for.

Commands this phase uses: `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `ListPartsCommand` (TD-04/TD-05); `GetObjectCommand` (TD-09 playback/download, worker reads); `HeadObjectCommand` (TD-13 post-completion size check); `PutObjectCommand` (worker writes the thumbnail).

**Multipart limits** (AWS S3 User Guide, verified 2026-09-11): max 10,000 parts; part numbers 1–10,000; part size 5 MiB–5 GiB with no minimum on the last part; single-`PutObject` ceiling 5 GiB — which is *why* TD-04 rejected presigned single-PUT for a 10GB requirement. At 64 MiB parts, 10GB is ~160 parts, far under the cap.

Recommended companion: a bucket lifecycle rule with `AbortIncompleteMultipartUpload` so abandoned uploads stop accruing storage (TD-04's recommendation; TD-05's janitor sweep is the application-level counterpart).

Sources: [Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) · [Multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)

---

## `@aws-sdk/s3-request-presigner`

Backs **TD-04**, **TD-09**, **TD-12**, **TD-13**. This is the package the phase's two hardest decisions rest on.

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(publicS3Client, command, { expiresIn: 3600 });
```

`expiresIn` is in **seconds** and **defaults to 900** when omitted. TD-09 suggests a 15–60 min window for playback, re-issued on demand.

**`signableHeaders` — the mechanism TD-13 depends on.** Non-`x-amz-*` headers are only bound into the signature when named explicitly:

```ts
const partUrl = await getSignedUrl(publicS3Client, uploadPartCommand, {
  signableHeaders: new Set(['content-length']),
  expiresIn: 3600,
});
```

This pins the presigned `UploadPart` URL to one exact byte count, which is how TD-13's declare-then-bind half bounds the total upload size: the API signs exactly N part URLs, each locked to its planned length, so a client can neither add unplanned parts (unsigned) nor oversize a planned one (signature fails at storage).

⚠️ **`content-length-range` is NOT available here.** That condition belongs to the S3 **POST policy** used by browser form uploads; presigned `PUT` / `UploadPart` URLs carry no policy document. Any guidance suggesting a `content-length-range` condition on a presigned multipart flow is wrong for this architecture — `signableHeaders` is the correct primitive. (This corrected an earlier resolution hint written into `validation.md`.)

For `x-amz-*` headers that must be signed, use `unhoistableHeaders` instead of `signableHeaders`.

**Download vs. playback (TD-09)** differ by one override on `GetObjectCommand`: `ResponseContentDisposition: 'attachment; filename="…"'` produces the download URL; omitting it produces the streaming URL. Range handling needs no code — storage answers `206 Partial Content` natively to the browser's `Range` requests.

Sources: [`s3-request-presigner` README](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md) · [S3 POST policy (`content-length-range` scope)](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html)

---

## `bullmq`

Backs **TD-03** and **TD-06**. The video-processing queue.

**Stalled-job handling is the reason TD-03 chose BullMQ**, so it is the part worth getting right. When a worker picks up a job it takes a lock and must periodically renew it; `stalledInterval` governs the renewal cadence (the docs advise not modifying it without cause). If the lock lapses, the job is moved **back to `waiting`** and re-processed by another worker. `maxStalledCount` caps how many times that may happen before the job is moved to `failed` permanently.

The documented failure mode is a **CPU-starved event loop** preventing timely renewal. This phase is structurally immune to it, and the reason is worth recording: TD-07 runs FFmpeg via `child_process` in a **separate OS process**, so the worker's event loop stays free to renew locks while a 10GB transcode runs. Had the phase chosen an in-process transcoding library, the same design would have been fragile. TD-06's separate worker container reinforces this by keeping the API's event loop out of the picture entirely.

Retry policy for TD-10: configure `attempts` + `backoff` on the job so transient FFmpeg failures retry inside the queue and **only genuinely terminal failures** reach the DB as `status = failed` with a populated `processing_error`.

`ioredis` is a declared peer (`>=5.0.0`) and must be installed as a direct dependency.

Source: [BullMQ — Stalled Jobs](https://docs.bullmq.io/guide/workers/stalled-jobs)

---

## `@nestjs/bullmq`

Backs **TD-03** and **TD-06**. Official Nest wrapper — chosen partly because it matches the project's established "first-party Nest integration where one exists" pattern (`@nestjs/typeorm`, `@nestjs/jwt`, `@nestjs/throttler`, `@nestjs/config`).

Register the connection with `BullModule.forRootAsync`, following the inherited Phase 01 convention of `registerAs` config injected via `ConfigType` + `@Inject(xxxConfig.KEY)` — so a new `src/config/queue.config.ts` factory, and the Redis host taken from the Compose service name per the root `CLAUDE.md` Docker rule (`redis`, never `localhost`). Per-queue registration uses `BullModule.registerQueue({ name })`.

The consumer side is a class decorated with `@Processor(queueName)` extending `WorkerHost` and implementing `process(job)`. In the worker container this module is loaded through `NestFactory.createApplicationContext()` (TD-06) rather than `NestFactory.create()`, giving the same DI graph with no HTTP listener.

**Testing hook (TD-11):** `nestjs-project`'s testing guide already names `BullModule.registerQueue()` alongside `TypeOrmModule.forFeature()` and `JwtModule.register()` as configured imports that require a **module compilation test** — DI wiring errors here surface only at runtime, so the compilation test is not optional.

---

## `ioredis`

Backs **TD-03** indirectly — a declared peer of `bullmq`, not used directly by application code. Installed so the peer resolves; connection options are supplied through `@nestjs/bullmq`'s `forRootAsync` rather than by instantiating a client directly.

⚠️ **Resolved version is 5.11.1, not the registry's `latest` of 6.0.0.** Corrected on 2026-09-11 during SI-03.4 after observing the actual install. `typeorm@0.3.28` already depends on `ioredis`, so npm dedupes the whole tree onto a single 5.x copy rather than installing two majors side by side:

```
+-- bullmq@6.3.4
| `-- ioredis@5.11.1 deduped
+-- ioredis@5.11.1
`-- typeorm@0.3.28
  `-- ioredis@5.11.1 deduped
```

This is correct and requires no action: `bullmq@6.3.4` declares the peer as `ioredis: >=5.0.0`, which 5.11.1 satisfies. Forcing 6.0.0 would split the tree into two ioredis copies for no benefit. Recorded here because a cache that claims 6.0.0 while the lockfile pins 5.11.1 would mislead anyone debugging a Redis-level issue.
