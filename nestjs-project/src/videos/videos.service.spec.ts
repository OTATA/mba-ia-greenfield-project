import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UnsupportedContentTypeException,
  UploadTooLargeException,
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { StorageService } from './storage/storage.service';
import { VideosService } from './videos.service';
import { MAX_UPLOAD_SIZE_BYTES } from './videos.constants';

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
  let service: VideosService;
  let videoRepository: jest.Mocked<Pick<Repository<Video>, 'save' | 'create'>>;
  let channelsService: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let storageService: jest.Mocked<
    Pick<StorageService, 'createMultipartUpload' | 'presignUploadParts'>
  >;

  beforeEach(() => {
    videoRepository = { save: jest.fn(), create: jest.fn() };
    channelsService = { findByUserId: jest.fn() };
    storageService = {
      createMultipartUpload: jest.fn(),
      presignUploadParts: jest.fn(),
    };

    service = new VideosService(
      videoRepository as unknown as Repository<Video>,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
    );
  });

  it('rejects a declared size above the ceiling', async () => {
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
    await expect(
      service.createUpload('user-1', {
        filename: 'huge.pdf',
        size_bytes: MAX_UPLOAD_SIZE_BYTES + 1,
        content_type: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UploadTooLargeException);
  });
});
