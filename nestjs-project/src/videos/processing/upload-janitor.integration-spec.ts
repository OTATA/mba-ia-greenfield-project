import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { UploadJanitorService } from './upload-janitor.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** Sweeping with a zero TTL treats every `uploading` row as abandoned. */
const TTL_EVERYTHING = 0;

/** A TTL far in the future means nothing is old enough to reclaim. */
const TTL_NOTHING = 60 * 60 * 1000;

/**
 * The janitor's whole job is to reconcile two systems, so a mocked storage
 * would test nothing: the assertion that matters is that the multipart upload
 * genuinely disappears from `ListMultipartUploads`.
 */
describe('UploadJanitorService (integration)', () => {
  let moduleRef: TestingModule;
  let janitor: UploadJanitorService;
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
      providers: [UploadJanitorService, StorageService],
    }).compile();

    janitor = moduleRef.get(UploadJanitorService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    const stillOpen = new Set(
      await storage.listMultipartUploadIds().catch(() => []),
    );
    await Promise.all(
      openedUploads
        .filter(({ uploadId }) => stillOpen.has(uploadId))
        .map(({ key, uploadId }) =>
          storage.abortMultipartUpload(key, uploadId).catch(() => undefined),
        ),
    );
    await moduleRef.close();
  }, 30_000);

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

  /** A row in `uploading` backed by a genuinely open multipart upload. */
  async function seedOpenUpload(): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        channel_id: channel.id,
        title: 'Abandoned',
        status: VideoStatus.UPLOADING,
        declared_size_bytes: 1024,
        declared_content_type: 'video/mp4',
      }),
    );

    const key = `videos/${video.id}/original.mp4`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    openedUploads.push({ key, uploadId });

    await videoRepository.update(video.id, {
      storage_key: key,
      upload_id: uploadId,
    });
    return await videoRepository.findOneByOrFail({ id: video.id });
  }

  it('reclaims an expired row and aborts its multipart upload', async () => {
    const video = await seedOpenUpload();
    await expect(storage.listMultipartUploadIds()).resolves.toContain(
      video.upload_id,
    );

    await expect(janitor.sweep(TTL_EVERYTHING)).resolves.toBe(1);

    const reclaimed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(reclaimed.status).toBe(VideoStatus.FAILED);
    expect(reclaimed.processing_error).toBeTruthy();
    // Cleared so a later sweep does not try to abort an upload twice.
    expect(reclaimed.upload_id).toBeNull();

    await expect(storage.listMultipartUploadIds()).resolves.not.toContain(
      video.upload_id,
    );
  }, 30_000);

  it('leaves a row still inside the TTL untouched', async () => {
    const video = await seedOpenUpload();

    await expect(janitor.sweep(TTL_NOTHING)).resolves.toBe(0);

    const untouched = await videoRepository.findOneByOrFail({ id: video.id });
    expect(untouched.status).toBe(VideoStatus.UPLOADING);
    expect(untouched.upload_id).toBe(video.upload_id);
    // The upload is still in flight and must remain usable.
    await expect(storage.listMultipartUploadIds()).resolves.toContain(
      video.upload_id,
    );
  }, 30_000);

  it('is idempotent — a second sweep finds nothing left to do', async () => {
    await seedOpenUpload();

    await expect(janitor.sweep(TTL_EVERYTHING)).resolves.toBe(1);
    const afterFirst = await videoRepository.find();

    await expect(janitor.sweep(TTL_EVERYTHING)).resolves.toBe(0);
    const afterSecond = await videoRepository.find();

    expect(afterSecond).toEqual(afterFirst);
  }, 30_000);

  it('ignores rows that are not uploading', async () => {
    // `draft` rows have no open upload yet, and `processing`/`ready`/`failed`
    // are past the window the janitor guards. Sweeping them would destroy
    // perfectly good videos.
    const video = await seedOpenUpload();
    await videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
    });

    await expect(janitor.sweep(TTL_EVERYTHING)).resolves.toBe(0);

    const untouched = await videoRepository.findOneByOrFail({ id: video.id });
    expect(untouched.status).toBe(VideoStatus.PROCESSING);
  }, 30_000);

  it('still reclaims the row when the abort fails', async () => {
    // A row whose upload storage no longer knows about must not stay stuck in
    // `uploading` forever just because the cleanup call errors.
    const video = await seedOpenUpload();
    await storage.abortMultipartUpload(video.storage_key!, video.upload_id!);

    await expect(janitor.sweep(TTL_EVERYTHING)).resolves.toBe(1);

    const reclaimed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(reclaimed.status).toBe(VideoStatus.FAILED);
  }, 30_000);
});
