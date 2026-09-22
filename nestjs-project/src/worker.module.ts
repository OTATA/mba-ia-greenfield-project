import { Module } from '@nestjs/common';
import { AppModule } from './app.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/**
 * Root module of the worker process.
 *
 * It composes `AppModule` rather than re-declaring the infrastructure so that
 * config, validation schema, `DataSource` and queue connection are the same
 * objects the API uses — a worker that connected to a different database or
 * parsed env differently would be a subtle and expensive bug. Running under
 * `createApplicationContext`, no HTTP listener is started, so the controllers
 * `AppModule` brings along are inert.
 *
 * The one thing the API does not have is `VideoProcessingModule`: registering
 * the `@Processor` here, and only here, is what makes this process the
 * consumer.
 */
@Module({
  imports: [AppModule, VideoProcessingModule],
})
export class WorkerModule {}
