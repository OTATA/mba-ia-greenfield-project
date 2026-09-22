import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos.module';
import { FfmpegService } from './ffmpeg.service';
import { ProcessRunner } from './process-runner';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Consumer side of `video-processing`, deliberately **not** imported by
 * `AppModule`.
 *
 * Registering a `@Processor` is what turns a process into a consumer of the
 * queue. If the API loaded this module it would start processing videos
 * itself, defeating the separate-worker topology and putting FFmpeg work on
 * the process that must stay responsive to HTTP. Only `WorkerModule` imports
 * it, which is what keeps the two roles apart despite the shared codebase.
 */
@Module({
  imports: [VideosModule, StorageModule],
  providers: [VideoProcessingProcessor, FfmpegService, ProcessRunner],
})
export class VideoProcessingModule {}
