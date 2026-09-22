import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import {
  VideosService,
  type CompletedUpload,
  type CreatedUpload,
  type IssuedUrl,
  type VideoDetails,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  /**
   * No `@Public()`: the global JWT guard inherited from Phase 02 protects this
   * route by default, which is what answers 401 to anonymous callers.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Open a video upload',
    description:
      'Validates the declared size and content type, pre-registers the video ' +
      "on the caller's channel, and returns one presigned URL per part. The " +
      'bytes are uploaded straight to object storage and never transit the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload opened',
    schema: {
      properties: {
        public_id: { type: 'string' },
        upload_id: { type: 'string' },
        part_size: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
              content_length: { type: 'integer' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds the 10GB ceiling',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Declared content type is not an accepted video type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoUploadDto,
  ): Promise<CreatedUpload> {
    return this.videosService.createUpload(user.sub, dto);
  }

  @Post(':publicId/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Finalize a video upload',
    description:
      'Assembles the uploaded parts into the stored object, moves the video ' +
      'to processing and enqueues the processing job. This call is itself the ' +
      'upload-completion signal — no storage webhook is involved. Answers 202 ' +
      'because processing continues asynchronously after the response.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload finalized and queued for processing',
    schema: {
      properties: {
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or the part list does not match the plan',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video matches the public id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in the uploading state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<CompletedUpload> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  /**
   * `@OptionalAuth()` rather than `@Public()`: the route must answer anonymous
   * callers, but an unpublished video is visible to its owner, so the token
   * has to be read when one is present.
   */
  @Get(':publicId')
  @OptionalAuth()
  @ApiBearerAuth()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Resolves the video to its current state — the endpoint a client polls ' +
      'while processing runs. Anonymous for a ready video; a video in any ' +
      'other state is visible only to its owner and answers 404 to everyone ' +
      'else, so an unpublished video is not disclosed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current state of the video',
    schema: {
      properties: {
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'ready' },
        duration_seconds: { type: 'integer', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
        processing_error: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'No video matches the public id, or it is not visible to you',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('publicId') publicId: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<VideoDetails> {
    return this.videosService.findByPublicId(publicId, user?.sub);
  }

  @Get(':publicId/stream')
  @Public()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Get a playback URL',
    description:
      'Issues a short-lived presigned URL. The client fetches bytes straight ' +
      'from storage, which answers Range requests with 206 natively — the API ' +
      'never proxies media. Anonymous viewers may watch freely.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned playback URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'No video matches the public id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('publicId') publicId: string): Promise<IssuedUrl> {
    return this.videosService.issuePlaybackUrl(publicId);
  }

  /**
   * Deliberately not `@Public()`: watching is free for anonymous viewers, but
   * downloading a copy is treated as a deliberate act requiring an account.
   */
  @Get(':publicId/download')
  @ApiBearerAuth()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Same presigned primitive as playback, differing only by a ' +
      'content-disposition override that makes the browser save the file. ' +
      'Requires authentication.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video matches the public id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('publicId') publicId: string): Promise<IssuedUrl> {
    return this.videosService.issueDownloadUrl(publicId);
  }
}
