---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-create-upload.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` opens a video upload. It is the admission-control gate of the phase: it validates the client's declared size and MIME type, pre-registers the video as a draft row owned by the caller's channel, opens an S3 multipart upload, and returns one presigned URL per planned part. The bytes themselves never transit the API — the client uploads each part straight to object storage. Every part URL is signed against the public storage endpoint and bound to an exact `content-length`, so the 10GB ceiling is enforced by the signature itself rather than by inspecting a stream.

## Test Scenarios

### 1. Admission control

**Setup:** `beforeEach` truncates the test database via the existing `cleanAllTables` helper and clears the videos bucket; bootstrap the app with `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproducing `main.ts` global config (ValidationPipe + domain exception filters). Register and confirm a user to obtain a valid access token and its channel.

#### 1.1. rejects-declared-size-above-ceiling

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. POST /videos with a valid token and body `{ filename: "big.mp4", size_bytes: 10737418241, content_type: "video/mp4" }`
    - expect: HTTP 413
    - expect: response body `error` equals `UPLOAD_TOO_LARGE`
    - expect: no row was created in `videos`
  2. POST /videos with the same body but `size_bytes: 10737418240` (exactly the ceiling)
    - expect: HTTP 201
    - expect: a row exists in `videos` for the returned `public_id`

#### 1.2. rejects-content-type-outside-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. POST /videos with a valid token and body `{ filename: "notes.pdf", size_bytes: 1024, content_type: "application/pdf" }`
    - expect: HTTP 415
    - expect: response body `error` equals `UNSUPPORTED_CONTENT_TYPE`
    - expect: no row was created in `videos`

#### 1.3. rejects-anonymous-caller

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. POST /videos with no Authorization header and an otherwise valid body
    - expect: HTTP 401
    - expect: no row was created in `videos`

### 2. Draft pre-registration and part plan

**Setup:** same as group 1.

#### 2.1. creates-draft-row-and-returns-part-plan

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. POST /videos with a valid token and body `{ filename: "Minha Viagem.mp4", size_bytes: 209715200, content_type: "video/mp4" }`
    - expect: HTTP 201
    - expect: response body carries `public_id`, `upload_id`, `part_size`, and a non-empty `parts` array
    - expect: each element of `parts` carries `part_number`, `url`, and `content_length`
    - expect: `part_number` values are contiguous and start at 1
  2. Query the `videos` table for the returned `public_id`
    - expect: exactly one row exists
    - expect: its `status` is `uploading`
    - expect: its `title` is derived from the uploaded filename, not empty
    - expect: its `channel_id` equals the authenticated caller's channel id
    - expect: its `declared_size_bytes` equals 209715200

#### 2.2. part-plan-sums-to-declared-size

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. POST /videos with a valid token and body `{ filename: "clip.mp4", size_bytes: 209715200, content_type: "video/mp4" }`
    - expect: HTTP 201
    - expect: the sum of `content_length` across every element of `parts` equals exactly 209715200
    - expect: the count of `parts` is at most 10000 (the S3 multipart part-number ceiling)
  2. Inspect any part URL from the response
    - expect: its host matches the configured public storage endpoint, not the internal Compose service host
