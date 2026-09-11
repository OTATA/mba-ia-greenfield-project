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
