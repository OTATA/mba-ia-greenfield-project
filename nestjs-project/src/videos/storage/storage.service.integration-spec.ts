import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../../config/storage.config';
import { StorageService } from './storage.service';
import { thumbnailObjectKey, videoObjectKey } from './storage-key.util';

/**
 * Exercises the real MinIO from the Compose stack — per TD-11, the failures
 * that actually happen here (SigV4 host binding, path-style addressing,
 * multipart assembly, Range responses) are invisible to a mocked client.
 */
describe('StorageService (integration)', () => {
  let storage: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteVideoObject(key).catch(() => undefined);
    }
  });

  /** Uploads `body` through the full presigned-multipart path. */
  const uploadViaMultipart = async (
    key: string,
    body: Buffer,
  ): Promise<void> => {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const parts = await storage.presignUploadParts(key, uploadId, body.length);

    const completed: { part_number: number; etag: string }[] = [];
    let offset = 0;
    for (const part of parts) {
      const chunk = body.subarray(offset, offset + part.content_length);
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(chunk),
        headers: { 'content-length': String(part.content_length) },
      });
      expect(res.status).toBe(200);
      const etag = res.headers.get('etag');
      expect(etag).toBeTruthy();
      completed.push({ part_number: part.part_number, etag: etag! });
      offset += part.content_length;
    }

    await storage.completeMultipartUpload(key, uploadId, completed);
    createdKeys.push(key);
  };

  it('round-trips an object through presigned multipart intact', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    const body = Buffer.alloc(1024 * 64, 7);

    await uploadViaMultipart(key, body);

    expect(await storage.headObjectSize(key)).toBe(body.length);
  });

  it('plans parts whose content_length sums to the declared size', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    // Two-and-a-bit parts, so the last one is a short remainder.
    const totalBytes = storage.uploadPartSizeBytes * 2 + 123;

    const parts = await storage.presignUploadParts(key, uploadId, totalBytes);

    const sum = parts.reduce((acc, p) => acc + p.content_length, 0);
    expect(sum).toBe(totalBytes);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    expect(parts[2].content_length).toBe(123);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('rejects a part uploaded with a content-length other than the signed one', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const parts = await storage.presignUploadParts(key, uploadId, 2048);

    // The signature is bound to 2048 bytes; send more.
    const oversized = Buffer.alloc(4096, 1);
    const res = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(oversized),
      headers: { 'content-length': String(oversized.length) },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('serves a Range request with 206 and only the requested bytes', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    const body = Buffer.alloc(1024 * 32, 3);
    await uploadViaMultipart(key, body);

    const url = await storage.presignPlaybackUrl(key);
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toContain('bytes 0-1023/');
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.length).toBe(1024);
  });

  it('serves the full object when no Range header is sent', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    const body = Buffer.alloc(4096, 9);
    await uploadViaMultipart(key, body);

    const res = await fetch(await storage.presignPlaybackUrl(key));

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(body.length);
  });

  it('returns Content-Disposition attachment on the download URL', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    await uploadViaMultipart(key, Buffer.alloc(512, 1));

    const url = await storage.presignDownloadUrl(key, 'Minha Viagem.mp4');
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain(
      'Minha Viagem.mp4',
    );
  });

  it('signs browser-facing URLs against the configured public endpoint', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const [part] = await storage.presignUploadParts(key, uploadId, 128);
    const playback = await storage.presignPlaybackUrl(key);
    const publicHost = new URL(process.env.S3_PUBLIC_ENDPOINT!).host;

    expect(new URL(part.url).host).toBe(publicHost);
    expect(new URL(playback).host).toBe(publicHost);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('signs against the public endpoint even when it differs from the internal one', async () => {
    // The core of TD-12. Under test the two endpoints are collapsed onto the
    // same host (see src/test/setup-test-env.ts) so that presigned URLs are
    // fetchable in-container — which would make the assertion above vacuous.
    // Here we build a service with two genuinely different endpoints and
    // inspect the URL WITHOUT dereferencing it, so the dual-client wiring is
    // proven without needing the public host to be reachable.
    const divergent = new StorageService({
      internalEndpoint: 'http://minio:9000',
      publicEndpoint: 'http://cdn.example.test:9000',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      videosBucket: 'streamtube-videos',
      thumbnailsBucket: 'streamtube-thumbnails',
      uploadPartSizeBytes: 67108864,
      presignedUrlTtlSeconds: 1800,
    });

    const playback = await divergent.presignPlaybackUrl(
      'videos/x/original.mp4',
    );

    expect(new URL(playback).host).toBe('cdn.example.test:9000');
    expect(new URL(playback).host).not.toBe('minio:9000');
    // SigV4 signs Host, so the signature is bound to the public host — which
    // is exactly why the URL cannot simply be rewritten after signing.
    expect(playback).toContain('X-Amz-Signature');
  });

  it('aborts a multipart upload so it no longer appears as in-flight', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    expect(await storage.listMultipartUploadIds()).toContain(uploadId);

    await storage.abortMultipartUpload(key, uploadId);

    expect(await storage.listMultipartUploadIds()).not.toContain(uploadId);
  });

  it('writes a thumbnail readable without a signature from the public bucket', async () => {
    const videoId = randomUUID();
    const key = thumbnailObjectKey(videoId);
    await storage.putThumbnail(key, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    // No presigning: the thumbnails bucket is public-read on purpose.
    const url = `${process.env.S3_PUBLIC_ENDPOINT}/${storage.thumbnailsBucket}/${key}`;
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('keeps the videos bucket private to unsigned requests', async () => {
    const key = videoObjectKey(randomUUID(), 'clip.mp4');
    await uploadViaMultipart(key, Buffer.alloc(256, 5));

    const unsigned = `${process.env.S3_PUBLIC_ENDPOINT}/${storage.videosBucket}/${key}`;
    const res = await fetch(unsigned);

    expect(res.status).toBe(403);
  });
});
