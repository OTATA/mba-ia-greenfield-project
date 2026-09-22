import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from './storage/storage.module';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

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
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  exports: [TypeOrmModule, BullModule],
})
export class VideosModule {}
