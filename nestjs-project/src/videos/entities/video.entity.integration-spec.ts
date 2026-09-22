import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { User } from '../../users/entities/user.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** The 10GB ceiling in bytes — overflows int4 (max 2 147 483 647). */
const TEN_GB_BYTES = 10 * 1024 * 1024 * 1024;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `owner-${Date.now()}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Owner Channel',
        nickname: `owner_${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  const buildVideo = (overrides: Partial<Video> = {}): Video =>
    videoRepository.create({
      public_id: `pub${Date.now()}`.slice(0, 16),
      channel_id: channel.id,
      title: 'Minha Viagem',
      declared_size_bytes: 1024,
      declared_content_type: 'video/mp4',
      ...overrides,
    });

  it('defaults status to draft when not set explicitly', async () => {
    const saved = await videoRepository.save(buildVideo());

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(reloaded.status).toBe(VideoStatus.DRAFT);
  });

  it('leaves worker-populated columns null until processing runs', async () => {
    const saved = await videoRepository.save(buildVideo());

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(reloaded.duration_seconds).toBeNull();
    expect(reloaded.metadata).toBeNull();
    expect(reloaded.thumbnail_key).toBeNull();
    expect(reloaded.processing_error).toBeNull();
    // Phase 04 owns this field; Phase 03 never writes it.
    expect(reloaded.description).toBeNull();
  });

  it('rejects a duplicate public_id', async () => {
    await videoRepository.save(buildVideo({ public_id: 'duplicated_id' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'duplicated_id' })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('rejects a channel_id that does not exist', async () => {
    await expect(
      videoRepository.save(
        buildVideo({ channel_id: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('persists the full 10GB ceiling without overflowing', async () => {
    // int4 tops out at 2 147 483 647; this value is 10 737 418 240.
    const saved = await videoRepository.save(
      buildVideo({ declared_size_bytes: TEN_GB_BYTES }),
    );

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(reloaded.declared_size_bytes).toBe(TEN_GB_BYTES);
    expect(typeof reloaded.declared_size_bytes).toBe('number');
  });

  it('persists every status of the lifecycle', async () => {
    for (const status of Object.values(VideoStatus)) {
      const saved = await videoRepository.save(
        buildVideo({ public_id: `st_${status}`.slice(0, 16), status }),
      );
      const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
      expect(reloaded.status).toBe(status);
    }
  });

  it('rejects a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "title", "status", "declared_size_bytes", "declared_content_type")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['bad_status', channel.id, 'T', 'nonexistent', 1024, 'video/mp4'],
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('links the video to its owning channel', async () => {
    const saved = await videoRepository.save(buildVideo());

    const withChannel = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });
    expect(withChannel.channel.id).toBe(channel.id);
  });

  it('cascades deletion when the owning channel is removed', async () => {
    const saved = await videoRepository.save(buildVideo());

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    const found = await videoRepository.findOneBy({ id: saved.id });
    expect(found).toBeNull();
  });

  it('round-trips jsonb metadata written by the worker', async () => {
    const metadata = { format: { format_name: 'mov,mp4' }, streams: [{}] };
    const saved = await videoRepository.save(buildVideo({ metadata }));

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(reloaded.metadata).toEqual(metadata);
  });
});
