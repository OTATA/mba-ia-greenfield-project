import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { StorageService } from './storage/storage.service';
import { User } from '../users/entities/user.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { createTestDataSource } from '../test/create-test-data-source';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * DI wiring errors surface only at runtime — TypeScript cannot catch a missing
 * import or a wrong provider token. The testing guide names
 * `BullModule.registerQueue()` explicitly as a configured import that requires
 * a compilation test.
 *
 * The module is built once and torn down in `afterAll`. Closing the queue
 * explicitly matters: BullMQ holds open Redis sockets, and leaving them open
 * makes Jest hang after the run instead of exiting.
 */
describe('VideosModule', () => {
  let moduleRef: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.redisHost, port: cfg.redisPort },
          }),
        }),
        VideosModule,
      ],
    }).compile();

    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
  });

  afterAll(async () => {
    // Order matters: drop queue state, close the Redis sockets, then the app.
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await moduleRef.close();
  });

  it('compiles with the queue and the Video repository wired', () => {
    expect(
      moduleRef.get(getRepositoryToken(Video), { strict: false }),
    ).toBeDefined();
    expect(queue).toBeDefined();
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(moduleRef.get(StorageService, { strict: false })).toBeInstanceOf(
      StorageService,
    );
  });

  it('reaches Redis using the Compose service name as host', async () => {
    // waitUntilReady settles only once the connection attempt finishes: it
    // resolves (as void, in bullmq 6) when the backend is established and
    // rejects when it is unreachable. Resolution is itself the proof, so the
    // assertion is on the promise settling, not on a return value.
    await expect(queue.waitUntilReady()).resolves.toBeUndefined();
    expect(process.env.REDIS_HOST).toBe('redis');
    expect(process.env.REDIS_HOST).not.toBe('localhost');
  });

  it('round-trips a job payload through the real queue', async () => {
    await queue.drain(true);

    const payload = {
      videoId: '11111111-2222-3333-4444-555555555555',
      bucket: 'streamtube-videos',
      storageKey: 'videos/11111111/original.mp4',
    };
    const enqueued = await queue.add(VIDEO_JOBS.PROCESS, payload);

    const readBack = await queue.getJob(enqueued.id!);
    expect(readBack).toBeDefined();
    expect(readBack!.name).toBe(VIDEO_JOBS.PROCESS);
    expect(readBack!.data).toEqual(payload);
  });
});
