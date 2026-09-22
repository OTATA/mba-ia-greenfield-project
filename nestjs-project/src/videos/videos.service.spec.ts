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
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage/storage.service';
import { VideosService, type VideoProcessJob } from './videos.service';
import { MAX_UPLOAD_SIZE_BYTES } from './videos.constants';

const PART_SIZE = 5 * 1024 * 1024;

interface Mocks {
  videoRepository: {
    save: jest.Mock;
    create: jest.Mock;
    findOneBy: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  channelsService: { findByUserId: jest.Mock };
  storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    uploadPartSizeBytes: number;
    videosBucket: string;
  };
  queue: { add: jest.Mock };
}

function build(): { service: VideosService } & Mocks {
  const mocks: Mocks = {
    videoRepository: {
      save: jest.fn(),
      create: jest.fn(),
      findOneBy: jest.fn(),
      // The real transaction hands a manager to the callback; the callback is
      // what the tests care about, so run it with a manager stub.
      manager: {
        transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
          cb({ update: jest.fn() }),
        ),
      },
    },
    channelsService: { findByUserId: jest.fn() },
    storageService: {
      createMultipartUpload: jest.fn(),
      presignUploadParts: jest.fn(),
      completeMultipartUpload: jest.fn(),
      uploadPartSizeBytes: PART_SIZE,
      videosBucket: 'streamtube-videos',
    },
    queue: { add: jest.fn() },
  };

  const service = new VideosService(
    mocks.videoRepository as unknown as Repository<Video>,
    mocks.channelsService as unknown as ChannelsService,
    mocks.storageService as unknown as StorageService,
    mocks.queue as unknown as Queue<VideoProcessJob>,
  );

  return { service, ...mocks };
}

/**
 * Admission control is pure branching, so it is unit-tested with every
 * collaborator mocked. What matters is not only the exception raised but that
 * a rejected request leaves no trace: no row, no multipart upload. The janitor
 * sweep is meant to find abandoned uploads, and a rejected request that opened
 * one would pollute that signal.
 *
 * The happy path is covered by the integration and e2e suites, which exercise
 * the real database and real object storage.
 */
describe('VideosService.createUpload — admission control', () => {
  it('rejects a declared size above the ceiling', async () => {
    const { service, videoRepository, storageService } = build();

    await expect(
      service.createUpload('user-1', {
        filename: 'big.mp4',
        size_bytes: MAX_UPLOAD_SIZE_BYTES + 1,
        content_type: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(UploadTooLargeException);

    expect(videoRepository.save).not.toHaveBeenCalled();
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('admits a declared size exactly at the ceiling', async () => {
    // Boundary in the other direction: the ceiling is inclusive, so this must
    // get past admission and reach the channel lookup.
    const { service, channelsService } = build();
    channelsService.findByUserId.mockResolvedValue(null);

    await expect(
      service.createUpload('user-1', {
        filename: 'exact.mp4',
        size_bytes: MAX_UPLOAD_SIZE_BYTES,
        content_type: 'video/mp4',
      }),
    ).rejects.toThrow('has no channel');

    expect(channelsService.findByUserId).toHaveBeenCalledWith('user-1');
  });

  it('rejects a content type outside the allowlist', async () => {
    const { service, videoRepository, storageService } = build();

    await expect(
      service.createUpload('user-1', {
        filename: 'notes.pdf',
        size_bytes: 1024,
        content_type: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UnsupportedContentTypeException);

    expect(videoRepository.save).not.toHaveBeenCalled();
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('checks the size before the content type', async () => {
    // A payload violating both rules answers 413, not 415. Pinning the order
    // keeps the response deterministic for clients.
    const { service } = build();

    await expect(
      service.createUpload('user-1', {
        filename: 'huge.pdf',
        size_bytes: MAX_UPLOAD_SIZE_BYTES + 1,
        content_type: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UploadTooLargeException);
  });
});

/**
 * Completion is the only write that can be attempted by someone other than
 * the owner, on a row in any state, with a client-supplied list. Each guard is
 * isolated here; the assembled object and the real enqueue are proven by the
 * integration and e2e suites.
 */
describe('VideosService.completeUpload — guards', () => {
  /** An `uploading` row whose declared size plans exactly two parts. */
  const uploadingVideo = (): Video =>
    ({
      id: 'video-uuid',
      public_id: 'abc123',
      channel_id: 'channel-1',
      status: VideoStatus.UPLOADING,
      storage_key: 'videos/video-uuid/original.mp4',
      upload_id: 'upload-1',
      declared_size_bytes: PART_SIZE + 1024,
    }) as Video;

  const twoParts = [
    { part_number: 1, etag: 'etag-1' },
    { part_number: 2, etag: 'etag-2' },
  ];

  it('rejects an unknown public id', async () => {
    const { service, videoRepository } = build();
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      service.completeUpload('user-1', 'missing', { parts: twoParts }),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('rejects a caller whose channel does not own the video', async () => {
    const { service, videoRepository, channelsService, storageService } =
      build();
    videoRepository.findOneBy.mockResolvedValue(uploadingVideo());
    channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });

    await expect(
      service.completeUpload('stranger', 'abc123', { parts: twoParts }),
    ).rejects.toBeInstanceOf(NotVideoOwnerException);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects a video that is not uploading', async () => {
    const { service, videoRepository, channelsService, storageService } =
      build();
    videoRepository.findOneBy.mockResolvedValue({
      ...uploadingVideo(),
      status: VideoStatus.PROCESSING,
    });
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

    await expect(
      service.completeUpload('user-1', 'abc123', { parts: twoParts }),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('checks ownership before upload state', async () => {
    // A stranger must not learn *why* the call failed beyond "not yours" —
    // answering 409 here would disclose the video's processing state.
    const { service, videoRepository, channelsService } = build();
    videoRepository.findOneBy.mockResolvedValue({
      ...uploadingVideo(),
      status: VideoStatus.READY,
    });
    channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });

    await expect(
      service.completeUpload('stranger', 'abc123', { parts: twoParts }),
    ).rejects.toBeInstanceOf(NotVideoOwnerException);
  });

  describe('part list reconciliation', () => {
    const expectMismatch = async (
      parts: { part_number: number; etag: string }[],
    ) => {
      const {
        service,
        videoRepository,
        channelsService,
        storageService,
        queue,
      } = build();
      videoRepository.findOneBy.mockResolvedValue(uploadingVideo());
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

      await expect(
        service.completeUpload('user-1', 'abc123', { parts }),
      ).rejects.toBeInstanceOf(UploadPartMismatchException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    };

    it('rejects a list missing a planned part', async () => {
      await expectMismatch([{ part_number: 1, etag: 'etag-1' }]);
    });

    it('rejects a list carrying a part that was never planned', async () => {
      await expectMismatch([...twoParts, { part_number: 3, etag: 'etag-3' }]);
    });

    it('rejects duplicated part numbers that merely reach the right count', async () => {
      // Length alone is not enough: two copies of part 1 would pass a naive
      // count check while leaving part 2 unaccounted for.
      await expectMismatch([
        { part_number: 1, etag: 'etag-1' },
        { part_number: 1, etag: 'etag-1' },
      ]);
    });

    it('accepts the planned list regardless of the order it arrives in', async () => {
      const {
        service,
        videoRepository,
        channelsService,
        storageService,
        queue,
      } = build();
      videoRepository.findOneBy.mockResolvedValue(uploadingVideo());
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

      const result = await service.completeUpload('user-1', 'abc123', {
        parts: [...twoParts].reverse(),
      });

      expect(result).toEqual({
        public_id: 'abc123',
        status: VideoStatus.PROCESSING,
      });
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-uuid/original.mp4',
        'upload-1',
        expect.any(Array),
      );
      expect(queue.add).toHaveBeenCalledWith('video.process', {
        videoId: 'video-uuid',
        bucket: 'streamtube-videos',
        storageKey: 'videos/video-uuid/original.mp4',
      });
    });
  });
});
