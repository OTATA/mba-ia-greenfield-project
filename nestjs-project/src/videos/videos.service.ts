import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UnsupportedContentTypeException,
  UploadTooLargeException,
} from '../common/exceptions/domain.exception';
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
} from './videos.constants';

/** Response of `POST /videos` — the client's instructions for uploading. */
export interface CreatedUpload {
  public_id: string;
  upload_id: string;
  part_size: number;
  parts: PresignedUploadPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
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
