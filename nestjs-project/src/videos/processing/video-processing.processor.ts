import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Video, VideoStatus } from '../entities/video.entity';
import { thumbnailObjectKey } from '../storage/storage-key.util';
import { StorageService } from '../storage/storage.service';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { FfmpegService, thumbnailTimestamp } from './ffmpeg.service';
import { CommandFailedError } from './process-runner';
import { UploadJanitorService } from './upload-janitor.service';
import type { VideoProcessJob } from '../videos.service';

/**
 * A failure that retrying cannot fix: the stored bytes are not what was
 * declared, or are not a video at all. These settle terminally on the first
 * attempt instead of burning the retry budget.
 */
export class VideoVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoVerificationError';
  }
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    private readonly uploadJanitorService: UploadJanitorService,
  ) {
    super();
  }

  /**
   * Delivery is at-least-once, so this must tolerate being run twice for the
   * same video. The guard is the status check: a video already `ready` is
   * left untouched rather than re-probed and re-thumbnailed, which keeps a
   * redelivery from overwriting good metadata with the result of a second,
   * possibly failing, pass.
   */
  async process(job: Job<VideoProcessJob>): Promise<void> {
    // One queue carries both job kinds, so the handler routes on the name.
    // The janitor's payload is empty — reading `job.data.videoId` for it
    // would quietly operate on `undefined`.
    if (job.name === VIDEO_JOBS.UPLOAD_JANITOR) {
      await this.uploadJanitorService.sweep();
      return;
    }

    const { videoId, storageKey } = job.data;

    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      // The row was deleted between enqueue and pickup; nothing to do, and
      // failing the job would only retry against a row that will never exist.
      this.logger.warn(`Video ${videoId} no longer exists — dropping job`);
      return;
    }
    if (video.status === VideoStatus.READY) {
      this.logger.log(`Video ${videoId} already processed — skipping`);
      return;
    }

    try {
      await this.verifyAndProcess(video, storageKey);
    } catch (error) {
      if (error instanceof VideoVerificationError) {
        // Terminal by nature: discard the useless object, record the verdict,
        // and return normally so BullMQ does not retry something that will
        // not change.
        //
        // Deleting *before* flipping the status keeps the two consistent for
        // any observer: once a video reads `failed`, its object is already
        // gone, rather than gone a moment later.
        await this.storageService
          .deleteVideoObject(storageKey)
          .catch(() => undefined);
        await this.markFailed(videoId, error.message);
        return;
      }
      throw error;
    }
  }

  private async verifyAndProcess(
    video: Video,
    storageKey: string,
  ): Promise<void> {
    // The verification half of the declare-then-bind admission control: what
    // the client said at create-upload is now checked against what landed.
    const actualSize = await this.storageService.headObjectSize(storageKey);
    if (actualSize !== video.declared_size_bytes) {
      throw new VideoVerificationError(
        `Stored object is ${actualSize} bytes but ${video.declared_size_bytes} were declared`,
      );
    }

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-'));
    const localPath = join(workDir, 'source');

    try {
      await pipeline(
        await this.storageService.getObjectStream(storageKey),
        createWriteStream(localPath),
      );

      const probe = await this.probeOrReject(localPath);
      if (!probe.videoCodec) {
        throw new VideoVerificationError(
          'Uploaded file contains no video stream',
        );
      }

      const thumbnail = await this.ffmpegService.extractThumbnail(
        localPath,
        thumbnailTimestamp(probe.durationSeconds),
      );
      const thumbnailKey = thumbnailObjectKey(video.id);
      await this.storageService.putThumbnail(thumbnailKey, thumbnail);

      // Cast at the boundary: TypeORM maps an update payload through
      // `QueryDeepPartialEntity`, which cannot express an open
      // `Record<string, unknown>` destined for a jsonb column. The runtime
      // value is exactly what the column stores.
      await this.videoRepository.update(video.id, {
        duration_seconds: probe.durationSeconds,
        metadata: probe.raw,
        thumbnail_key: thumbnailKey,
        status: VideoStatus.READY,
        // A previous attempt may have written one; succeeding must clear it.
        processing_error: null,
      } as QueryDeepPartialEntity<Video>);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * ffprobe refusing a file is a verdict about the bytes, not a transient
   * fault: retrying will read the same unparseable content three times and
   * only delay the inevitable. Translating the process failure here is what
   * keeps a junk upload from burning the whole retry budget with backoff.
   */
  private async probeOrReject(localPath: string) {
    try {
      return await this.ffmpegService.probe(localPath);
    } catch (error) {
      if (error instanceof CommandFailedError) {
        throw new VideoVerificationError(
          `Uploaded file could not be parsed as media: ${error.stderr.trim() || 'ffprobe rejected it'}`,
        );
      }
      throw error;
    }
  }

  /**
   * Retries exhausted. Only now does a transient failure become a terminal
   * state — until then the queue owns the problem and the database is not
   * told about it.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessJob>, error: Error): Promise<void> {
    // The janitor carries no video, so there is no row to mark; a failed
    // sweep simply runs again on the next interval.
    if (job.name !== VIDEO_JOBS.PROCESS) return;

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;

    await this.markFailed(job.data.videoId, error.message);
  }

  private async markFailed(videoId: string, reason: string): Promise<void> {
    this.logger.error(`Video ${videoId} failed processing: ${reason}`);
    await this.videoRepository.update(videoId, {
      status: VideoStatus.FAILED,
      processing_error: reason,
    });
  }
}
