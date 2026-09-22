/**
 * Test-only environment adjustment, loaded by Jest after `dotenv/config`.
 *
 * `S3_PUBLIC_ENDPOINT` is browser-facing: in development it is
 * `http://localhost:9000`, which is correct for a browser on the host but
 * unreachable from inside a container, where `localhost` is the container
 * itself. Tests run in-container and must be able to actually fetch the
 * presigned URLs they generate, so under test the public endpoint points at
 * the internal one — this is what `phase-03-videos/TD-12` prescribes.
 *
 * The dual-client wiring itself (signing against the *public* endpoint rather
 * than the internal one) is still asserted, by
 * `storage.service.integration-spec.ts` → "signs against the configured public
 * endpoint even when it differs from the internal one", which builds a service
 * with two genuinely different endpoints and inspects the URL without
 * dereferencing it.
 */
if (process.env.S3_INTERNAL_ENDPOINT) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_INTERNAL_ENDPOINT;
}

/**
 * Shrink the multipart part size to S3's floor for non-final parts (5 MiB).
 *
 * Reconciling a submitted part list against the issued plan can only be
 * exercised when a plan has more than one part. At the production part size of
 * 64 MiB that would mean pushing 64 MB through a test; at 5 MiB a 6 MiB payload
 * already produces two parts. Going below 5 MiB is not an option — storage
 * rejects `CompleteMultipartUpload` when a non-final part is smaller.
 */
process.env.S3_UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024);
