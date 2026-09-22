import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from './storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import {
  UPLOAD_JANITOR_INTERVAL_MS,
  VIDEO_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

/**
 * Owns the videos domain: the entity's repository, the object-storage adapter,
 * and the queue that hands processing work to the worker container.
 *
 * Registering `Video` via `forFeature` here is also what makes the entity
 * visible to the app-level DataSource (`autoLoadEntities: true`), which is why
 * relations pointing at it can only be declared once this module is loaded.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, BullModule, VideosService],
})
export class VideosModule implements OnModuleInit {
  private readonly logger = new Logger(VideosModule.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Schedules the abandoned-upload sweep.
   *
   * The schedule is *declared* here, in the module the API loads, and the
   * jobs it emits are consumed by the worker — the same producer/consumer
   * split as `video.process`.
   *
   * `upsertJobScheduler` (BullMQ 6 replaced the old `repeat` job option with
   * it) is idempotent on the scheduler id: restarting the API re-declares the
   * same schedule instead of stacking a second one, and changing the interval
   * replaces the entry rather than leaving both running.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      VIDEO_JOBS.UPLOAD_JANITOR,
      { every: UPLOAD_JANITOR_INTERVAL_MS },
      {
        name: VIDEO_JOBS.UPLOAD_JANITOR,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    );
    this.logger.log(
      `Scheduled ${VIDEO_JOBS.UPLOAD_JANITOR} every ${UPLOAD_JANITOR_INTERVAL_MS}ms`,
    );
  }
}
