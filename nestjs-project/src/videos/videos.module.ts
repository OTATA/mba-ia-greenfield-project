import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from './storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
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
    ChannelsModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, BullModule, VideosService],
})
export class VideosModule {}
