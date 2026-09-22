import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadStateException,
  NotVideoOwnerException,
  UnsupportedContentTypeException,
  UploadPartMismatchException,
  UploadTooLargeException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateUniquePublicId } from './public-id.util';
import { videoObjectKey } from './storage/storage-key.util';
import {
  StorageService,
  type PresignedUploadPart,
} from './storage/storage.service';
import { deriveTitleFromFilename } from './title.util';
import {
  ACCEPTED_VIDEO_MIME_TYPES,
  MAX_UPLOAD_SIZE_BYTES,
  VIDEO_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

/** Response of `POST /videos` — the client's instructions for uploading. */
export interface CreatedUpload {
  public_id: string;
  upload_id: string;
  part_size: number;
  parts: PresignedUploadPart[];
}

/** Response of `POST /videos/:publicId/complete`. */
export interface CompletedUpload {
  public_id: string;
  status: VideoStatus;
}

/** Payload of the `video.process` job consumed by the worker container. */
export interface VideoProcessJob {
  videoId: string;
  bucket: string;
  storageKey: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<VideoProcessJob>,
  ) {}

  /**
   * Opens an upload: admits the request, pre-registers the row, and hands back
   * one presigned URL per planned part.
   *
   * Admission happens **before** anything is written, because both rejections
   * are cheap and a rejected upload must leave no trace (the janitor should
   * only ever find genuinely abandoned uploads, not rejected ones).
   *
   * The row is saved before the multipart upload is opened so that the object
   * key can be derived from the generated `id`. That ordering means a storage
   * failure can leave a `draft` row with no upload behind it — deliberate, and
   * exactly what the janitor sweep reclaims.
   */
  async createUpload(
    userId: string,
    dto: CreateVideoUploadDto,
  ): Promise<CreatedUpload> {
    this.assertAdmissible(dto);

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Registration creates a channel for every user, so this is a broken
      // invariant rather than a user-facing error.
      throw new Error(`User ${userId} has no channel`);
    }

    const publicId = await generateUniquePublicId((candidate) =>
      this.videoRepository.existsBy({ public_id: candidate }),
    );

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: deriveTitleFromFilename(dto.filename),
        status: VideoStatus.DRAFT,
        declared_size_bytes: dto.size_bytes,
        declared_content_type: dto.content_type,
      }),
    );

    const storageKey = videoObjectKey(video.id, dto.filename);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );
    const parts = await this.storageService.presignUploadParts(
      storageKey,
      uploadId,
      dto.size_bytes,
    );

    await this.videoRepository.update(video.id, {
      storage_key: storageKey,
      upload_id: uploadId,
      status: VideoStatus.UPLOADING,
    });

    return {
      public_id: video.public_id,
      upload_id: uploadId,
      part_size: this.storageService.uploadPartSizeBytes,
      parts,
    };
  }

  /**
   * Closes the multipart upload and hands the video to the worker.
   *
   * There is no storage webhook: this call *is* the completion signal, which
   * is why assembling the object, flipping the status and enqueueing the job
   * all belong to one request.
   *
   * The status flip and the enqueue share a transaction so the system can
   * never end up with a video marked `processing` that no worker will ever
   * pick up. The opposite residue — a job enqueued for a row that stayed
   * `uploading` because the commit failed — is recoverable: the worker sees a
   * video that is not `processing` and the janitor reclaims the row.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteVideoUploadDto,
  ): Promise<CompletedUpload> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new NotVideoOwnerException();
    }

    if (video.status !== VideoStatus.UPLOADING) {
      throw new InvalidUploadStateException(video.status);
    }

    this.assertPartsMatchPlan(video, dto.parts);

    // `storage_key` and `upload_id` are written at create-upload, and the
    // status guard above guarantees both are set on an `uploading` row.
    const storageKey = video.storage_key!;
    await this.storageService.completeMultipartUpload(
      storageKey,
      video.upload_id!,
      dto.parts,
    );

    await this.videoRepository.manager.transaction(async (manager) => {
      await manager.update(Video, video.id, {
        status: VideoStatus.PROCESSING,
        // No longer in flight — keeping it would misrepresent the row to the
        // janitor sweep, which reads `upload_id` to abort abandoned uploads.
        upload_id: null,
      });
      await this.processingQueue.add(VIDEO_JOBS.PROCESS, {
        videoId: video.id,
        bucket: this.storageService.videosBucket,
        storageKey,
      });
    });

    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
  }

  /**
   * The part plan is not stored: it is a pure function of the declared size
   * and the configured part size, so it is recomputed here rather than
   * persisted and kept in sync. A submitted list matches only if it covers
   * exactly part numbers `1..N`, with no gaps, extras or duplicates.
   */
  private assertPartsMatchPlan(
    video: Video,
    submitted: { part_number: number }[],
  ): void {
    const expectedCount = Math.ceil(
      video.declared_size_bytes / this.storageService.uploadPartSizeBytes,
    );
    const submittedNumbers = new Set(submitted.map((p) => p.part_number));

    if (
      submitted.length !== expectedCount ||
      submittedNumbers.size !== expectedCount
    ) {
      throw new UploadPartMismatchException();
    }

    for (let partNumber = 1; partNumber <= expectedCount; partNumber++) {
      if (!submittedNumbers.has(partNumber)) {
        throw new UploadPartMismatchException();
      }
    }
  }

  /**
   * The declare half of TD-13's declare-then-bind admission control. What the
   * client *claims* is checked here; what it actually uploaded is verified
   * against storage after completion, because these two can disagree.
   */
  private assertAdmissible(dto: CreateVideoUploadDto): void {
    if (dto.size_bytes > MAX_UPLOAD_SIZE_BYTES) {
      throw new UploadTooLargeException(dto.size_bytes, MAX_UPLOAD_SIZE_BYTES);
    }

    const accepted = ACCEPTED_VIDEO_MIME_TYPES as readonly string[];
    if (!accepted.includes(dto.content_type)) {
      throw new UnsupportedContentTypeException(dto.content_type);
    }
  }
}
