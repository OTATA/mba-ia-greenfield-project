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
  VideoNotReadyException,
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
import { deriveTitleFromFilename, downloadFilename } from './title.util';
import {
  ACCEPTED_VIDEO_MIME_TYPES,
  MAX_UPLOAD_SIZE_BYTES,
  VIDEO_JOBS,
  VIDEO_PROCESS_JOB_OPTIONS,
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

/** Response of `GET /videos/:publicId`. */
export interface VideoDetails {
  public_id: string;
  title: string;
  status: VideoStatus;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  processing_error: string | null;
}

/** Response of the stream and download endpoints. */
export interface IssuedUrl {
  url: string;
  expires_in: number;
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
      await this.processingQueue.add(
        VIDEO_JOBS.PROCESS,
        {
          videoId: video.id,
          bucket: this.storageService.videosBucket,
          storageKey,
        },
        VIDEO_PROCESS_JOB_OPTIONS,
      );
    });

    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
  }

  /**
   * Resolves the per-video URL to its current state — the endpoint a client
   * polls while processing runs.
   *
   * A video that is not `ready` is visible only to its owner, and an
   * unauthorized caller gets `404`, never `403`: answering "forbidden" would
   * confirm that an unpublished video exists behind that id.
   */
  async findByPublicId(
    publicId: string,
    userId?: string,
  ): Promise<VideoDetails> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    if (
      video.status !== VideoStatus.READY &&
      !(await this.isOwner(video, userId))
    ) {
      throw new VideoNotFoundException();
    }

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_url: video.thumbnail_key
        ? this.storageService.thumbnailUrl(video.thumbnail_key)
        : null,
      // Only meaningful on a terminal failure; null otherwise keeps the field
      // from reading as "no error yet" on a video still being processed.
      processing_error:
        video.status === VideoStatus.FAILED ? video.processing_error : null,
    };
  }

  /**
   * Short-lived presigned GET for playback. The client issues its own `Range`
   * requests against this URL and storage answers `206` natively, so no range
   * handling exists in the API.
   */
  async issuePlaybackUrl(publicId: string): Promise<IssuedUrl> {
    const video = await this.findPlayable(publicId);

    return {
      url: await this.storageService.presignPlaybackUrl(video.storage_key!),
      expires_in: this.storageService.presignedUrlTtlSeconds,
    };
  }

  /** Same primitive as playback, differing only by the attachment override. */
  async issueDownloadUrl(publicId: string): Promise<IssuedUrl> {
    const video = await this.findPlayable(publicId);

    return {
      url: await this.storageService.presignDownloadUrl(
        video.storage_key!,
        downloadFilename(video.title, video.storage_key!),
      ),
      expires_in: this.storageService.presignedUrlTtlSeconds,
    };
  }

  /**
   * Shared lookup for the two delivery endpoints.
   *
   * Unlike metadata, these disclose that an unready video exists — answering
   * `409 VIDEO_NOT_READY` rather than `404` is what the contract specifies,
   * because a player polling a known id needs to tell "not yet" from "gone".
   */
  private async findPlayable(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException(video.status);
    }
    return video;
  }

  private async isOwner(video: Video, userId?: string): Promise<boolean> {
    if (!userId) return false;
    const channel = await this.channelsService.findByUserId(userId);
    return channel?.id === video.channel_id;
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
