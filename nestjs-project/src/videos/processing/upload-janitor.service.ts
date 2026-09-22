import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { ABANDONED_UPLOAD_TTL_MS } from '../videos.constants';

@Injectable()
export class UploadJanitorService {
  private readonly logger = new Logger(UploadJanitorService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Reclaims uploads that were opened and never finished.
   *
   * The completion handshake is the only signal that bytes landed, so a
   * client that uploads every part and then disappears leaves a row stuck in
   * `uploading` forever and multipart parts billing in the bucket. Nothing
   * else in the system will ever notice — this sweep is that noticing.
   *
   * @param ttlMs - how old a row must be to count as abandoned; parameterised
   *                so tests can exercise the boundary without waiting a day
   * @returns how many rows were reclaimed
   */
  async sweep(ttlMs: number = ABANDONED_UPLOAD_TTL_MS): Promise<number> {
    const cutoff = new Date(Date.now() - ttlMs);

    const abandoned = await this.videoRepository.find({
      where: { status: VideoStatus.UPLOADING, updated_at: LessThan(cutoff) },
    });

    for (const video of abandoned) {
      await this.reclaim(video);
    }

    if (abandoned.length > 0) {
      this.logger.log(`Reclaimed ${abandoned.length} abandoned upload(s)`);
    }
    return abandoned.length;
  }

  private async reclaim(video: Video): Promise<void> {
    if (video.upload_id && video.storage_key) {
      // Storage first: once the row stops saying `uploading` nothing will
      // ever look at this upload_id again, so failing to abort here would
      // orphan the parts permanently. A failure is logged and swallowed
      // rather than thrown — one unreachable upload must not stop the sweep
      // from reclaiming the rest.
      await this.storageService
        .abortMultipartUpload(video.storage_key, video.upload_id)
        .catch((error: Error) =>
          this.logger.warn(
            `Could not abort upload ${video.upload_id} for video ${video.id}: ${error.message}`,
          ),
        );
    }

    await this.videoRepository.update(video.id, {
      status: VideoStatus.FAILED,
      processing_error: 'Upload was never completed and has been abandoned',
      upload_id: null,
    });
  }
}
