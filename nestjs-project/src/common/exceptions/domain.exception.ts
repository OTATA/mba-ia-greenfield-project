export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class UploadTooLargeException extends DomainException {
  constructor(declaredBytes: number, maxBytes: number) {
    super(
      'UPLOAD_TOO_LARGE',
      413,
      `Declared size of ${declaredBytes} bytes exceeds the maximum of ${maxBytes} bytes`,
    );
  }
}

export class UnsupportedContentTypeException extends DomainException {
  constructor(contentType: string) {
    super(
      'UNSUPPORTED_CONTENT_TYPE',
      415,
      `Content type "${contentType}" is not an accepted video type`,
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class NotVideoOwnerException extends DomainException {
  constructor() {
    super('NOT_VIDEO_OWNER', 403, 'Video belongs to another channel');
  }
}

export class InvalidUploadStateException extends DomainException {
  constructor(currentStatus: string) {
    super(
      'INVALID_UPLOAD_STATE',
      409,
      `Upload cannot be completed while the video is "${currentStatus}"`,
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor(currentStatus: string) {
    super(
      'VIDEO_NOT_READY',
      409,
      `Video is "${currentStatus}" and cannot be played or downloaded yet`,
    );
  }
}

export class UploadPartMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_PART_MISMATCH',
      400,
      'Submitted part list does not match the plan issued at create-upload',
    );
  }
}
