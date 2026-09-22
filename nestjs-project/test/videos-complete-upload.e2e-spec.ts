import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
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
import {
  VIDEO_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from '../src/videos/videos.constants';
import type { VideoProcessJob } from '../src/videos/videos.service';

/** 6 MiB — smallest payload that still plans two parts at the test part size. */
const TWO_PART_PAYLOAD = 6 * 1024 * 1024;

interface CompletedUploadBody {
  public_id: string;
  status: string;
}

describe('POST /videos/:publicId/complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue<VideoProcessJob>;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let strangerToken: string;

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
    queue = moduleFixture.get<Queue<VideoProcessJob>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    for (const { key, uploadId } of openedUploads) {
      await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    }
    for (const key of storedKeys) {
      await storage.deleteVideoObject(key).catch(() => undefined);
    }
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true }).catch(() => undefined);
    throttlerStorage.storage.clear();

    ownerToken = await registerConfirmAndLogin('owner@example.com');
    strangerToken = await registerConfirmAndLogin('stranger@example.com');
  });

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
  async function openAndUpload(sizeBytes = TWO_PART_PAYLOAD) {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'holiday.mp4',
        size_bytes: sizeBytes,
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

  const complete = (
    publicId: string,
    parts: { part_number: number; etag: string }[],
    token = ownerToken,
  ) =>
    request(app.getHttpServer())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });

  describe('guard conditions', () => {
    it('rejects a caller who does not own the video', async () => {
      const { created, row, parts } = await openAndUpload();

      const res = await complete(
        created.public_id,
        parts,
        strangerToken,
      ).expect(403);

      expect(body<ErrorBody>(res).error).toBe('NOT_VIDEO_OWNER');
      await expect(
        videoRepository.findOneByOrFail({ id: row.id }),
      ).resolves.toMatchObject({ status: VideoStatus.UPLOADING });
    });

    it('rejects completing a video that is no longer uploading', async () => {
      const { created, row, parts } = await openAndUpload();
      await complete(created.public_id, parts).expect(202);
      storedKeys.push(row.storage_key!);

      const res = await complete(created.public_id, parts).expect(409);

      expect(body<ErrorBody>(res).error).toBe('INVALID_UPLOAD_STATE');
    });

    it('rejects a part list that does not match the issued plan', async () => {
      const { created, row, parts } = await openAndUpload();

      const missing = await complete(
        created.public_id,
        parts.slice(0, parts.length - 1),
      ).expect(400);
      expect(body<ErrorBody>(missing).error).toBe('UPLOAD_PART_MISMATCH');
      await expect(
        videoRepository.findOneByOrFail({ id: row.id }),
      ).resolves.toMatchObject({ status: VideoStatus.UPLOADING });

      const extra = await complete(created.public_id, [
        ...parts,
        { part_number: parts.length + 1, etag: '"never-planned"' },
      ]).expect(400);
      expect(body<ErrorBody>(extra).error).toBe('UPLOAD_PART_MISMATCH');
    });

    it('rejects an unknown public id', async () => {
      const res = await complete('does-not-exist', [
        { part_number: 1, etag: '"x"' },
      ]).expect(404);

      expect(body<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('rejects a malformed body — ValidationPipe is wired on this route', async () => {
      const { created } = await openAndUpload();

      const res = await complete(created.public_id, [
        { part_number: 0, etag: '' },
      ]).expect(400);

      expect(body<ErrorBody>(res).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('successful handshake', () => {
    it('assembles the object and enqueues exactly one processing job', async () => {
      const { created, row, parts } = await openAndUpload();

      const res = await complete(created.public_id, parts).expect(202);
      storedKeys.push(row.storage_key!);

      const completed = body<CompletedUploadBody>(res);
      expect(completed.public_id).toBe(created.public_id);
      expect(completed.status).toBe('processing');

      // The object exists in the private bucket with exactly the declared size.
      await expect(storage.headObjectSize(row.storage_key!)).resolves.toBe(
        TWO_PART_PAYLOAD,
      );

      const persisted = await videoRepository.findOneByOrFail({ id: row.id });
      expect(persisted.status).toBe(VideoStatus.PROCESSING);
      expect(persisted.storage_key).toBeTruthy();

      const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
      const forThisVideo = jobs.filter((job) => job.data.videoId === row.id);
      expect(forThisVideo).toHaveLength(1);
      expect(forThisVideo[0].name).toBe(VIDEO_JOBS.PROCESS);
      expect(forThisVideo[0].data).toEqual({
        videoId: row.id,
        bucket: storage.videosBucket,
        storageKey: persisted.storage_key,
      });
    });
  });
});
