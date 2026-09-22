import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { VideosService, type CreatedUpload } from './videos.service';

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
}
