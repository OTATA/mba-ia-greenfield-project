import * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_INTERNAL_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({}) as {
      value: { SWAGGER_ENABLED: string };
      error?: Joi.ValidationError;
    };
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue (phase 03)', () => {
  const omit = (key: string) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
  };

  it.each([
    'S3_INTERNAL_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
  ])('should reject a missing %s', (key) => {
    const { error } = omit(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject a non-URI storage endpoint', () => {
    const { error } = validate({ S3_INTERNAL_ENDPOINT: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_INTERNAL_ENDPOINT');
  });

  it('should reject an upload part size below the 5 MiB S3 minimum', () => {
    const { error } = validate({ S3_UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_UPLOAD_PART_SIZE_BYTES');
  });

  it('should apply storage and queue defaults when they are not set', () => {
    const { value, error } = validate({}) as {
      value: {
        S3_VIDEOS_BUCKET: string;
        S3_THUMBNAILS_BUCKET: string;
        S3_UPLOAD_PART_SIZE_BYTES: number;
        REDIS_HOST: string;
        REDIS_PORT: number;
        QUEUE_PROCESSING_ATTEMPTS: number;
      };
      error?: Joi.ValidationError;
    };
    expect(error).toBeUndefined();
    expect(value.S3_VIDEOS_BUCKET).toBe('streamtube-videos');
    expect(value.S3_THUMBNAILS_BUCKET).toBe('streamtube-thumbnails');
    // 64 MiB — 10GB spans ~160 parts, far under the 10 000-part S3 ceiling.
    expect(value.S3_UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PROCESSING_ATTEMPTS).toBe(3);
  });

  it('should accept the two storage endpoints pointing at different hosts', () => {
    // The whole point of TD-12: internal is the Compose service name, public is
    // browser-reachable. They are expected to differ in development.
    const { error } = validate({
      S3_INTERNAL_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
    });
    expect(error).toBeUndefined();
  });
});
