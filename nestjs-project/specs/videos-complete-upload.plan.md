---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-complete-upload.e2e-spec.ts
---

# POST /videos/:publicId/complete Test Plan

## Application Overview

`POST /videos/:publicId/complete` finalizes a multipart upload. Because the API brokers `CompleteMultipartUpload` itself, this call doubles as the upload-completion signal: no storage webhook is involved. In one request it verifies ownership, verifies the video is actually in `uploading`, reconciles the submitted part list against the plan issued at create-upload, assembles the object in storage, moves the row to `processing`, and enqueues the `video.process` job that the worker consumes. That coupling is what makes the whole flow exercisable end-to-end in an integration test.

## Test Scenarios

### 1. Guard conditions

**Setup:** `beforeEach` truncates the test database via `cleanAllTables`, clears the videos bucket, and drains the `video-processing` queue; bootstrap the app with `Test.createTestingModule({ imports: [AppModule] }).compile()` plus `main.ts` global config. Register and confirm two distinct users (owner and stranger), each with its own channel.

#### 1.1. rejects-non-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. As the owner, POST /videos to open an upload and capture `public_id` and the part plan
  2. Upload every planned part directly to storage using the presigned URLs, collecting each `ETag`
  3. As the stranger, POST /videos/:publicId/complete with the correct part list
    - expect: HTTP 403
    - expect: response body `error` equals `NOT_VIDEO_OWNER`
    - expect: the row's `status` is still `uploading`

#### 1.2. rejects-wrong-upload-state

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. As the owner, open an upload, upload every part, and complete it once successfully
  2. As the owner, POST /videos/:publicId/complete a second time with the same part list
    - expect: HTTP 409
    - expect: response body `error` equals `INVALID_UPLOAD_STATE`

#### 1.3. rejects-part-list-mismatch

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. As the owner, open an upload and upload every planned part
  2. POST /videos/:publicId/complete omitting the last part from the submitted list
    - expect: HTTP 400
    - expect: response body `error` equals `UPLOAD_PART_MISMATCH`
    - expect: the row's `status` is still `uploading`
  3. POST /videos/:publicId/complete with an extra part number that was never in the plan
    - expect: HTTP 400
    - expect: response body `error` equals `UPLOAD_PART_MISMATCH`

### 2. Successful handshake

**Setup:** same as group 1.

#### 2.1. assembles-object-and-enqueues-processing

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. As the owner, POST /videos to open an upload for a known byte payload, capturing `public_id` and the part plan
  2. Upload every planned part directly to storage via its presigned URL, collecting the returned `ETag` values
  3. POST /videos/:publicId/complete with the full `{ part_number, etag }` list
    - expect: HTTP 202
    - expect: response body `status` equals `processing`
    - expect: response body `public_id` equals the one opened in step 1
  4. Inspect the private videos bucket for the row's `storage_key`
    - expect: the object exists
    - expect: its byte size equals the size declared at create-upload
  5. Inspect the `video-processing` queue
    - expect: exactly one job is present for this `videoId`
    - expect: the job payload carries `videoId`, `bucket`, and `storageKey`
  6. Query the `videos` row
    - expect: its `status` is `processing`
    - expect: its `storage_key` is populated
