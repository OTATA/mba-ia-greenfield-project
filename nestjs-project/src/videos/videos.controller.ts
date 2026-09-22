import {
  Body,
  Controller,
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
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import {
  VideosService,
  type CompletedUpload,
  type CreatedUpload,
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
}
