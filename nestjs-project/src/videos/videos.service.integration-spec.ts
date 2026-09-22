import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage/storage.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** 200 MiB — spans several 64 MiB parts with a short final part. */
const MULTI_PART_SIZE = 209_715_200;

/**
 * Proves the database and object-storage contracts that a mocked repository
 * cannot: that the row really lands in `uploading` with the derived title and
 * the caller's channel, and that the issued part plan actually adds up to the
 * declared size.
 */
describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  const openedUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [VideosService, StorageService, ChannelsService],
    }).compile();

    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    // Every createUpload opens a real multipart upload. Left dangling they
    // accumulate in the bucket across runs, so abort them explicitly — the
    // janitor that would otherwise reclaim them ships in a later SI.
    for (const { key, uploadId } of openedUploads) {
      await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    }
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

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
