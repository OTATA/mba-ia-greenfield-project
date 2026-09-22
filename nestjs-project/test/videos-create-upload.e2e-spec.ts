import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
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

/** 10 GiB — the ceiling the phase must support. */
const CEILING_BYTES = 10_737_418_240;

/** 200 MiB — large enough to span several parts, small enough to stay quick. */
const MULTI_PART_SIZE = 209_715_200;

describe('POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let accessToken: string;

  /** Multipart uploads opened by the tests, aborted in `afterAll`. */
  const openedUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // createTestingModule does not run main.ts, so the global pipe and filters
    // have to be reproduced or the contract under test simply is not active.
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
    channelRepository = dataSource.getRepository(Channel);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    for (const { key, uploadId } of openedUploads) {
      await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    accessToken = await registerConfirmAndLogin('uploader@example.com');
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

  /** Records the upload so `afterAll` can abort it in storage. */
  async function trackUpload(publicId: string, uploadId: string) {
    const row = await videoRepository.findOneByOrFail({ public_id: publicId });
    openedUploads.push({ key: row.storage_key!, uploadId });
    return row;
  }

  const post = (payload: Record<string, unknown>, token = accessToken) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

  describe('admission control', () => {
    it('rejects a declared size above the ceiling and admits one exactly at it', async () => {
      const rejected = await post({
        filename: 'big.mp4',
        size_bytes: CEILING_BYTES + 1,
        content_type: 'video/mp4',
      }).expect(413);

      expect(body<ErrorBody>(rejected).error).toBe('UPLOAD_TOO_LARGE');
      await expect(videoRepository.count()).resolves.toBe(0);

      const admitted = await post({
        filename: 'big.mp4',
        size_bytes: CEILING_BYTES,
        content_type: 'video/mp4',
      }).expect(201);

      const created = body<CreatedUploadBody>(admitted);
      await expect(
        trackUpload(created.public_id, created.upload_id),
      ).resolves.toBeDefined();
    });

    it('rejects a content type outside the allowlist', async () => {
      const res = await post({
        filename: 'notes.pdf',
        size_bytes: 1024,
        content_type: 'application/pdf',
      }).expect(415);

      expect(body<ErrorBody>(res).error).toBe('UNSUPPORTED_CONTENT_TYPE');
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('rejects an anonymous caller', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          filename: 'clip.mp4',
          size_bytes: 1024,
          content_type: 'video/mp4',
        })
        .expect(401);

      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('rejects a malformed body — ValidationPipe is wired on this route', async () => {
      const res = await post({
        filename: '',
        size_bytes: 'not-a-number',
        content_type: 'video/mp4',
      }).expect(400);

      expect(body<ErrorBody>(res).error).toBe('VALIDATION_ERROR');
      await expect(videoRepository.count()).resolves.toBe(0);
    });
  });

  describe('draft pre-registration and part plan', () => {
    it('creates the draft row and returns a part plan', async () => {
      const res = await post({
        filename: 'Minha Viagem.mp4',
        size_bytes: MULTI_PART_SIZE,
        content_type: 'video/mp4',
      }).expect(201);

      const created = body<CreatedUploadBody>(res);
      expect(created.public_id).toBeTruthy();
      expect(created.upload_id).toBeTruthy();
      expect(created.part_size).toBeGreaterThan(0);
      expect(created.parts.length).toBeGreaterThan(0);
      for (const part of created.parts) {
        expect(part).toEqual({
          part_number: expect.any(Number) as number,
          url: expect.any(String) as string,
          content_length: expect.any(Number) as number,
        });
      }
      expect(created.parts.map((p) => p.part_number)).toEqual(
        created.parts.map((_, index) => index + 1),
      );

      const row = await trackUpload(created.public_id, created.upload_id);
      const channel = await channelRepository.findOneByOrFail({
        id: row.channel_id,
      });
      await expect(
        videoRepository.countBy({ public_id: created.public_id }),
      ).resolves.toBe(1);
      expect(row.status).toBe(VideoStatus.UPLOADING);
      expect(row.title).toBe('Minha Viagem');
      expect(row.channel_id).toBe(channel.id);
      expect(row.declared_size_bytes).toBe(MULTI_PART_SIZE);
    });

    it('issues a part plan that sums to the declared size', async () => {
      const res = await post({
        filename: 'clip.mp4',
        size_bytes: MULTI_PART_SIZE,
        content_type: 'video/mp4',
      }).expect(201);

      const created = body<CreatedUploadBody>(res);
      await trackUpload(created.public_id, created.upload_id);

      expect(
        created.parts.reduce((sum, part) => sum + part.content_length, 0),
      ).toBe(MULTI_PART_SIZE);
      // 10000 is S3's hard ceiling on part numbers for one multipart upload.
      expect(created.parts.length).toBeLessThanOrEqual(10_000);

      // Signed against the configured *public* endpoint. Under test that value
      // is deliberately pointed at the internal one (see setup-test-env.ts),
      // so the "public ≠ internal" half of this claim cannot be asserted here —
      // storage.service.integration-spec.ts covers it with two distinct hosts.
      const publicEndpoint = new URL(process.env.S3_PUBLIC_ENDPOINT!);
      expect(new URL(created.parts[0].url).host).toBe(publicEndpoint.host);
    });
  });
});
