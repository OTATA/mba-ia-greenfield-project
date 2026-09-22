import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { thumbnailObjectKey } from '../storage/storage-key.util';
import {
  VIDEO_JOBS,
  VIDEO_PROCESS_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { ProcessRunner } from './process-runner';
import { UploadJanitorService } from './upload-janitor.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { VideoProcessJob } from '../videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const FIXTURE = join(__dirname, '__fixtures__', 'tiny.mp4');

/**
 * Runs the **real** worker loop against real MinIO, Redis, Postgres and
 * FFmpeg binaries.
 *
 * This spec requires `ffmpeg`/`ffprobe`, which live only in the worker image
 * (TD-06 keeps them out of the API image deliberately). It is therefore
 * excluded from the API container's `npm test` and run with
 * `docker compose exec video-worker npm run test:worker`.
 */
describe('VideoProcessingProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue<VideoProcessJob>;
  let channel: Channel;
  let fixture: Buffer;

  const storedKeys: string[] = [];

  beforeAll(async () => {
    fixture = await readFile(FIXTURE);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.redisHost, port: cfg.redisPort },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [
        VideoProcessingProcessor,
        FfmpegService,
        ProcessRunner,
        StorageService,
        UploadJanitorService,
      ],
    }).compile();

    // Registering the @Processor only starts the BullMQ worker once lifecycle
    // hooks run, which `compile()` alone does not trigger.
    await moduleRef.init();

    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue<VideoProcessJob>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.all(
      storedKeys.map((key) =>
        storage.deleteVideoObject(key).catch(() => undefined),
      ),
    );
    await queue.obliterate({ force: true }).catch(() => undefined);
    await moduleRef.close();
  }, 30_000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true }).catch(() => undefined);

    const user = await dataSource.getRepository(User).save({
      email: 'uploader@example.com',
      password: 'hashed',
      is_confirmed: true,
    });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'uploader', nickname: 'uploader', user_id: user.id });
  });

  /** Puts bytes in the private videos bucket through the multipart path. */
  async function putVideoObject(key: string, body: Buffer): Promise<void> {
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
      completed.push({
        part_number: part.part_number,
        etag: res.headers.get('etag')!,
      });
      offset += part.content_length;
    }

    await storage.completeMultipartUpload(key, uploadId, completed);
    storedKeys.push(key);
  }

  /** A row in `processing` whose object really exists in storage. */
  async function seedProcessing(body: Buffer): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `p${Date.now().toString(36)}`,
        channel_id: channel.id,
        title: 'Fixture',
        status: VideoStatus.PROCESSING,
        declared_size_bytes: body.length,
        declared_content_type: 'video/mp4',
      }),
    );
    const key = `videos/${video.id}/original.mp4`;
    await putVideoObject(key, body);
    await videoRepository.update(video.id, { storage_key: key });
    return await videoRepository.findOneByOrFail({ id: video.id });
  }

  /** Waits for the worker to move the row out of the status it started in. */
  async function waitForSettled(
    videoId: string,
    from: VideoStatus = VideoStatus.PROCESSING,
    timeoutMs = 30_000,
  ): Promise<Video> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await videoRepository.findOneByOrFail({ id: videoId });
      if (row.status !== from) return row;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Video ${videoId} never left ${from}`);
  }

  const enqueue = (video: Video) =>
    queue.add(
      VIDEO_JOBS.PROCESS,
      {
        videoId: video.id,
        bucket: storage.videosBucket,
        storageKey: video.storage_key!,
      },
      VIDEO_PROCESS_JOB_OPTIONS,
    );

  it('takes a real video all the way to ready with duration and thumbnail', async () => {
    const video = await seedProcessing(fixture);

    await enqueue(video);
    const settled = await waitForSettled(video.id);

    expect(settled.status).toBe(VideoStatus.READY);
    // The fixture is a 2-second clip; the duration must reflect the file, not
    // anything the client declared.
    expect(settled.duration_seconds).toBe(2);
    expect(settled.processing_error).toBeNull();
    expect(settled.thumbnail_key).toBe(thumbnailObjectKey(video.id));
    expect(settled.metadata).toMatchObject({
      format: expect.objectContaining({
        format_name: expect.stringContaining('mp4') as unknown,
      }) as unknown,
    });
  }, 60_000);

  it('publishes the thumbnail at a stable unsigned URL', async () => {
    const video = await seedProcessing(fixture);

    await enqueue(video);
    const settled = await waitForSettled(video.id);

    const url = storage.thumbnailUrl(settled.thumbnail_key!);
    // No query string: the thumbnails bucket is public-read precisely so a
    // listing does not pay one signature per item.
    expect(new URL(url).search).toBe('');

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 60_000);

  it('fails a file that is not a video and discards the object', async () => {
    const notAVideo = Buffer.from('this is plainly not a video'.repeat(50));
    const video = await seedProcessing(notAVideo);

    await enqueue(video);
    const settled = await waitForSettled(video.id);

    expect(settled.status).toBe(VideoStatus.FAILED);
    expect(settled.processing_error).toBeTruthy();
    // The original is worthless — keeping it would bill storage for garbage.
    await expect(storage.headObjectSize(video.storage_key!)).rejects.toThrow();
  }, 60_000);

  it('fails when the stored bytes do not match the declared size', async () => {
    const video = await seedProcessing(fixture);
    // Simulate a client that declared one size and uploaded another.
    await videoRepository.update(video.id, {
      declared_size_bytes: fixture.length + 1,
    });

    await enqueue(await videoRepository.findOneByOrFail({ id: video.id }));
    const settled = await waitForSettled(video.id);

    expect(settled.status).toBe(VideoStatus.FAILED);
    expect(settled.processing_error).toContain('declared');
  }, 60_000);

  it('routes a janitor job to the sweep instead of the video pipeline', async () => {
    // One queue carries both job kinds. If the name dispatch is wrong the
    // janitor simply never runs, and nothing else in the system notices —
    // so the routing is worth an explicit test.
    const stale = await seedProcessing(fixture);
    await videoRepository.update(stale.id, {
      status: VideoStatus.UPLOADING,
      upload_id: 'upload-that-no-longer-exists',
    });
    // Backdate past the 24h TTL with raw SQL: `repository.update` would
    // refresh `updated_at` through @UpdateDateColumn and undo it.
    await dataSource.query(
      `UPDATE videos SET updated_at = now() - interval '48 hours' WHERE id = $1`,
      [stale.id],
    );

    await queue.add(VIDEO_JOBS.UPLOAD_JANITOR, {} as VideoProcessJob);

    const settled = await waitForSettled(stale.id, VideoStatus.UPLOADING);
    expect(settled.status).toBe(VideoStatus.FAILED);
    expect(settled.processing_error).toContain('never completed');
  }, 60_000);

  it('leaves an already-ready video untouched when the job is redelivered', async () => {
    const video = await seedProcessing(fixture);
    await enqueue(video);
    const first = await waitForSettled(video.id);

    // Delivery is at-least-once, so a redelivery must be a no-op rather than
    // a second pass that could overwrite good metadata.
    await enqueue(first);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.status).toBe(VideoStatus.READY);
    expect(second.duration_seconds).toBe(first.duration_seconds);
    expect(second.thumbnail_key).toBe(first.thumbnail_key);
    expect(second.updated_at.getTime()).toBe(first.updated_at.getTime());
  }, 60_000);
});
