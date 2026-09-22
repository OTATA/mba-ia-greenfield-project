import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage/storage.service';
import { VideosService, type VideoProcessJob } from './videos.service';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** 200 MiB — spans several parts with a short final part. */
const MULTI_PART_SIZE = 209_715_200;

/** 6 MiB — smallest payload that still plans two parts at the test part size. */
const TWO_PART_PAYLOAD = 6 * 1024 * 1024;

/**
 * Proves the database and object-storage contracts that a mocked repository
 * cannot: that the row really lands in `uploading` with the derived title and
 * the caller's channel, that the issued part plan adds up to the declared
 * size, and that completion genuinely assembles the object and enqueues work.
 */
describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue<VideoProcessJob>;
  let channel: Channel;

  const openedUploads: { key: string; uploadId: string }[] = [];
  const storedKeys: string[] = [];

  beforeAll(async () => {
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
      providers: [VideosService, StorageService, ChannelsService],
    }).compile();

    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue<VideoProcessJob>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  afterAll(async () => {
    // Uploads left open would accumulate in the bucket across runs; the
    // janitor that would otherwise reclaim them ships in a later SI.
    for (const { key, uploadId } of openedUploads) {
      await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    }
    for (const key of storedKeys) {
      await storage.deleteVideoObject(key).catch(() => undefined);
    }
    // BullMQ holds Redis sockets open — closing the queue keeps Jest from
    // hanging after the run.
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
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

  /** Runs createUpload and registers the opened upload for teardown. */
  const createUpload = async (filename: string, sizeBytes: number) => {
    const result = await service.createUpload(channel.user_id, {
      filename,
      size_bytes: sizeBytes,
      content_type: 'video/mp4',
    });
    const row = await videoRepository.findOneByOrFail({
      public_id: result.public_id,
    });
    openedUploads.push({ key: row.storage_key!, uploadId: result.upload_id });
    return { result, row };
  };

  /** Pushes real bytes to storage through the presigned URLs and returns the ETags. */
  const uploadParts = async (
    parts: { part_number: number; url: string; content_length: number }[],
  ): Promise<{ part_number: number; etag: string }[]> => {
    const completed: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const chunk = Buffer.alloc(part.content_length, part.part_number);
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
    }
    return completed;
  };

  describe('createUpload', () => {
    it('persists the draft as uploading, owned by the caller channel', async () => {
      const { result, row } = await createUpload(
        'Minha Viagem.mp4',
        MULTI_PART_SIZE,
      );

      expect(row.status).toBe(VideoStatus.UPLOADING);
      expect(row.title).toBe('Minha Viagem');
      expect(row.channel_id).toBe(channel.id);
      expect(row.declared_size_bytes).toBe(MULTI_PART_SIZE);
      expect(row.declared_content_type).toBe('video/mp4');
      expect(row.upload_id).toBe(result.upload_id);
      expect(row.storage_key).toBe(`videos/${row.id}/original.mp4`);
    });

    it('reads declared_size_bytes back as a number, not a bigint string', async () => {
      // The column is bigint precisely because 10 GiB overflows int4; the
      // transformer is what keeps callers from having to parse it.
      const { row } = await createUpload('ceiling.mp4', 10_737_418_240);

      expect(typeof row.declared_size_bytes).toBe('number');
      expect(row.declared_size_bytes).toBe(10_737_418_240);
    });

    it('issues a contiguous part plan that sums to the declared size', async () => {
      const { result } = await createUpload('clip.mp4', MULTI_PART_SIZE);

      expect(result.parts.length).toBeGreaterThan(1);
      expect(result.parts.length).toBeLessThanOrEqual(10_000);
      expect(result.parts.map((p) => p.part_number)).toEqual(
        result.parts.map((_, i) => i + 1),
      );
      expect(result.parts.reduce((sum, p) => sum + p.content_length, 0)).toBe(
        MULTI_PART_SIZE,
      );
      expect(result.part_size).toBe(storage.uploadPartSizeBytes);
    });

    it('gives every video a distinct public id', async () => {
      const first = await createUpload('a.mp4', 1024);
      const second = await createUpload('b.mp4', 1024);

      expect(first.result.public_id).not.toBe(second.result.public_id);
      expect(first.row.public_id.length).toBeLessThanOrEqual(16);
    });

    it('opens a multipart upload that storage really knows about', async () => {
      const { result } = await createUpload('tracked.mp4', 1024);

      await expect(storage.listMultipartUploadIds()).resolves.toContain(
        result.upload_id,
      );
    });
  });

  describe('completeUpload', () => {
    it('assembles the object, flips to processing and enqueues the job', async () => {
      const { result, row } = await createUpload('done.mp4', TWO_PART_PAYLOAD);
      const parts = await uploadParts(result.parts);
      expect(parts.length).toBe(2);

      const completed = await service.completeUpload(
        channel.user_id,
        result.public_id,
        { parts },
      );
      storedKeys.push(row.storage_key!);

      expect(completed).toEqual({
        public_id: result.public_id,
        status: VideoStatus.PROCESSING,
      });

      // The object really exists, with exactly the bytes that were declared.
      await expect(storage.headObjectSize(row.storage_key!)).resolves.toBe(
        TWO_PART_PAYLOAD,
      );

      const persisted = await videoRepository.findOneByOrFail({ id: row.id });
      expect(persisted.status).toBe(VideoStatus.PROCESSING);
      expect(persisted.storage_key).toBe(row.storage_key);
      // Cleared: the upload is no longer in flight, and the janitor reads this
      // field to decide what to abort.
      expect(persisted.upload_id).toBeNull();

      const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
      const forThisVideo = jobs.filter((job) => job.data.videoId === row.id);
      expect(forThisVideo).toHaveLength(1);
      expect(forThisVideo[0].name).toBe(VIDEO_JOBS.PROCESS);
      expect(forThisVideo[0].data).toEqual({
        videoId: row.id,
        bucket: storage.videosBucket,
        storageKey: row.storage_key,
      });
    });

    it('leaves the row untouched and enqueues nothing when the part list is short', async () => {
      const { result, row } = await createUpload('short.mp4', TWO_PART_PAYLOAD);
      const parts = await uploadParts(result.parts);

      await expect(
        service.completeUpload(channel.user_id, result.public_id, {
          parts: parts.slice(0, 1),
        }),
      ).rejects.toThrow();

      const persisted = await videoRepository.findOneByOrFail({ id: row.id });
      expect(persisted.status).toBe(VideoStatus.UPLOADING);
      expect(persisted.upload_id).toBe(result.upload_id);
      await expect(queue.getJobs(['waiting', 'delayed'])).resolves.toHaveLength(
        0,
      );
    });
  });
});
