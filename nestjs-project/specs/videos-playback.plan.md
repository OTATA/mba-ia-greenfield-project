---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-playback.e2e-spec.ts
---

# Video read endpoints Test Plan

## Application Overview

Three read endpoints resolve the unique per-video URL. `GET /videos/:publicId` returns the current state — the endpoint a client polls while processing runs. `GET /videos/:publicId/stream` and `GET /videos/:publicId/download` both issue a short-lived presigned GET; the client then fetches bytes straight from storage, which answers `Range` requests with `206 Partial Content` natively, so no range-handling code lives in the API. The two differ only by a `content-disposition` override. The audience split is deliberate: streaming is anonymous (the project plan grants anonymous viewers free watching), download requires authentication.

## Test Scenarios

### 1. Metadata resolution and visibility

**Setup:** `beforeEach` truncates the test database via `cleanAllTables` and clears both buckets; bootstrap the app with `Test.createTestingModule({ imports: [AppModule] }).compile()` plus `main.ts` global config. Seed one video in `ready` (with `duration_seconds`, `thumbnail_key` and a real object in storage) and one in `processing`, both owned by a registered, confirmed user.

#### 1.1. returns-metadata-for-ready-video-anonymously

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. GET /videos/:publicId for the `ready` video with no Authorization header
    - expect: HTTP 200
    - expect: response body `status` equals `ready`
    - expect: response body `duration_seconds` is a positive number
    - expect: response body `thumbnail_url` is a non-empty stable URL requiring no signature
    - expect: response body `public_id` equals the requested one

#### 1.2. hides-unready-video-from-non-owner

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. GET /videos/:publicId for the `processing` video with no Authorization header
    - expect: HTTP 404
    - expect: response body `error` equals `VIDEO_NOT_FOUND`
    - expect: the response reveals nothing distinguishing "exists but unready" from "does not exist"
  2. GET /videos/:publicId for the same video with the owner's token
    - expect: HTTP 200
    - expect: response body `status` equals `processing`

### 2. Streaming delivery

**Setup:** same as group 1.

#### 2.1. issues-anonymous-playback-url-serving-range-requests

**Covers AC:** #3, #4
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. GET /videos/:publicId/stream for the `ready` video with no Authorization header
    - expect: HTTP 200
    - expect: response body carries a non-empty `url` and a positive `expires_in`
    - expect: the `url` host matches the configured public storage endpoint, not the internal Compose service host
  2. Fetch the returned `url` with header `Range: bytes=0-1023`
    - expect: HTTP 206
    - expect: a `Content-Range` header is present
    - expect: the returned payload is 1024 bytes — the whole object was not transferred
  3. Fetch the returned `url` with no `Range` header
    - expect: HTTP 200
    - expect: the payload size equals the full object size

#### 2.2. refuses-stream-for-unready-video

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. GET /videos/:publicId/stream for the `processing` video
    - expect: HTTP 409
    - expect: response body `error` equals `VIDEO_NOT_READY`

### 3. Download delivery

**Setup:** same as group 1.

#### 3.1. requires-authentication-and-serves-attachment

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. GET /videos/:publicId/download for the `ready` video with no Authorization header
    - expect: HTTP 401
  2. GET /videos/:publicId/download for the same video with a valid access token
    - expect: HTTP 200
    - expect: response body carries a non-empty `url` and a positive `expires_in`
  3. Fetch the returned `url`
    - expect: HTTP 200
    - expect: a `Content-Disposition` header is present with the `attachment` disposition

#### 3.2. refuses-download-for-unready-video

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-11T13:40:49Z

**Steps:**
  1. GET /videos/:publicId/download for the `processing` video with a valid access token
    - expect: HTTP 409
    - expect: response body `error` equals `VIDEO_NOT_READY`
