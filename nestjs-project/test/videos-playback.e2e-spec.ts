import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  body,
  type AuthTokensBody,
  type CreatedUploadBody,
  type ErrorBody,
} from '../src/test/http-body';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { StorageService } from '../src/videos/storage/storage.service';

/** 6 MiB — spans two parts at the test part size. */
const PAYLOAD_BYTES = 6 * 1024 * 1024;

interface VideoDetailsBody {
  public_id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  processing_error: string | null;
}

interface IssuedUrlBody {
  url: string;
  expires_in: number;
}

describe('Video read endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let strangerToken: string;

  let readyPublicId: string;
  let processingPublicId: string;

  const openedUploads: { key: string; uploadId: string }[] = [];
  const storedKeys: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    // Abort only what is genuinely still open: aborting a completed upload
    // fails, and the SDK retries with backoff before giving up.
    const stillOpen = new Set(
      await storage.listMultipartUploadIds().catch(() => []),
    );
    await Promise.all([
      ...openedUploads
        .filter(({ uploadId }) => stillOpen.has(uploadId))
        .map(({ key, uploadId }) =>
          storage.abortMultipartUpload(key, uploadId).catch(() => undefined),
        ),
      ...storedKeys.map((key) =>
        storage.deleteVideoObject(key).catch(() => undefined),
      ),
    ]);
    await app.close();
  }, 30_000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();

    ownerToken = await registerConfirmAndLogin('owner@example.com');
    strangerToken = await registerConfirmAndLogin('stranger@example.com');

    readyPublicId = await seedReadyVideo();
    processingPublicId = await seedProcessingVideo();
  }, 30_000);

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    let confirmationToken = '';
    jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, token: string) => {
          confirmationToken = token;
          return Promise.resolve();
        },
      );

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return body<AuthTokensBody>(res).access_token;
  }

  /** Opens an upload as the owner and pushes every planned part to storage. */
  async function openAndUpload() {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'Holiday.mp4',
        size_bytes: PAYLOAD_BYTES,
        content_type: 'video/mp4',
      })
      .expect(201);

    const created = body<CreatedUploadBody>(res);
    const row = await videoRepository.findOneByOrFail({
      public_id: created.public_id,
    });
    openedUploads.push({ key: row.storage_key!, uploadId: created.upload_id });

    const parts: { part_number: number; etag: string }[] = [];
    for (const part of created.parts) {
      const chunk = Buffer.alloc(part.content_length, part.part_number);
      const put = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(chunk),
        headers: { 'content-length': String(part.content_length) },
      });
      expect(put.status).toBe(200);
      parts.push({
        part_number: part.part_number,
        etag: put.headers.get('etag')!,
      });
    }

    return { created, row, parts };
  }

  /** A fully processed video: real object in storage, duration and thumbnail set. */
  async function seedReadyVideo(): Promise<string> {
    const { created, row, parts } = await openAndUpload();
    await request(app.getHttpServer())
      .post(`/videos/${created.public_id}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts })
      .expect(202);
    storedKeys.push(row.storage_key!);

    // Stand in for the worker, which ships in a later SI.
    await videoRepository.update(row.id, {
      status: VideoStatus.READY,
      duration_seconds: 42,
      thumbnail_key: `thumbnails/${row.id}/frame.jpg`,
    });
    return created.public_id;
  }

  /** A video mid-pipeline: no object worth reading yet. */
  async function seedProcessingVideo(): Promise<string> {
    const { created, row, parts } = await openAndUpload();
    await request(app.getHttpServer())
      .post(`/videos/${created.public_id}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts })
      .expect(202);
    storedKeys.push(row.storage_key!);
    return created.public_id;
  }

  describe('GET /videos/:publicId', () => {
    it('returns metadata for a ready video without a token', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}`)
        .expect(200);

      const details = body<VideoDetailsBody>(res);
      expect(details.public_id).toBe(readyPublicId);
      expect(details.status).toBe('ready');
      expect(details.title).toBe('Holiday');
      expect(details.duration_seconds).toBeGreaterThan(0);
      expect(details.thumbnail_url).toBeTruthy();
      // Stable URL from the public-read bucket: no signature, so a listing
      // does not pay one presign per item.
      expect(new URL(details.thumbnail_url!).search).toBe('');
    });

    it('hides an unready video from an anonymous caller but shows it to the owner', async () => {
      const anonymous = await request(app.getHttpServer())
        .get(`/videos/${processingPublicId}`)
        .expect(404);
      expect(body<ErrorBody>(anonymous).error).toBe('VIDEO_NOT_FOUND');

      // Same answer as a genuinely unknown id — existence is not disclosed.
      const unknown = await request(app.getHttpServer())
        .get('/videos/does-not-exist')
        .expect(404);
      expect(body<ErrorBody>(unknown).error).toBe(
        body<ErrorBody>(anonymous).error,
      );

      const asOwner = await request(app.getHttpServer())
        .get(`/videos/${processingPublicId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(body<VideoDetailsBody>(asOwner).status).toBe('processing');
    });

    it('hides an unready video from an authenticated stranger', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${processingPublicId}`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(404);

      expect(body<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('issues an anonymous playback URL that serves Range requests', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}/stream`)
        .expect(200);

      const issued = body<IssuedUrlBody>(res);
      expect(issued.url).toBeTruthy();
      expect(issued.expires_in).toBeGreaterThan(0);
      expect(new URL(issued.url).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
      );

      const ranged = await fetch(issued.url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBeTruthy();
      expect((await ranged.arrayBuffer()).byteLength).toBe(1024);

      const full = await fetch(issued.url);
      expect(full.status).toBe(200);
      expect((await full.arrayBuffer()).byteLength).toBe(PAYLOAD_BYTES);
    });

    it('refuses to stream a video that is not ready', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${processingPublicId}/stream`)
        .expect(409);

      expect(body<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('requires authentication and serves an attachment', async () => {
      await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}/download`)
        .expect(401);

      const res = await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}/download`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(200);

      const issued = body<IssuedUrlBody>(res);
      expect(issued.url).toBeTruthy();
      expect(issued.expires_in).toBeGreaterThan(0);

      const fetched = await fetch(issued.url);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-disposition')).toContain(
        'attachment',
      );
    });

    it('refuses to hand out a download for a video that is not ready', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${processingPublicId}/download`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(409);

      expect(body<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    });
  });
});
