import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  @IsInt()
  @Min(1)
  part_number: number;

  /** The `ETag` storage returned when this part was uploaded. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteVideoUploadDto {
  /**
   * Structural validation only. Whether the list actually *matches* the plan
   * issued at create-upload is a domain rule, answered with
   * `400 UPLOAD_PART_MISMATCH` by the service rather than a generic validation
   * error, because the two tell the client very different things.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
