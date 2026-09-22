import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class CreateVideoUploadDto {
  /** Used to derive the title and the storage-key extension. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /**
   * Deliberately **not** capped with `@Max(10 GiB)` here.
   *
   * The contract distinguishes a malformed request (`400`) from a well-formed
   * request that asks for more than the platform allows (`413
   * UPLOAD_TOO_LARGE`). A `@Max` decorator would collapse both into `400` and
   * break the documented error catalog, so the ceiling is enforced as a domain
   * rule in `VideosService.createUpload`. Only structural validity lives here.
   */
  @IsInt()
  @Min(1)
  size_bytes: number;

  /**
   * The MIME allowlist is likewise enforced in the service, so a rejected type
   * answers `415 UNSUPPORTED_CONTENT_TYPE` rather than a generic `400`.
   */
  @IsString()
  @IsNotEmpty()
  content_type: string;
}
