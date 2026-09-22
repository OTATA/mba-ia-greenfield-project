import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Lifecycle required by the phase: rascunho → processando → pronto/erro.
 *
 * `uploading` makes the window between "draft row created" and "bytes landed"
 * explicit instead of ambiguous — the janitor sweep queries exactly this state
 * to find abandoned uploads.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/**
 * PostgreSQL returns `bigint` as a string to avoid precision loss. The values
 * stored here top out at the 10GB ceiling (10 737 418 240), far below
 * `Number.MAX_SAFE_INTEGER`, so converting to `number` is lossless and spares
 * every caller a manual parse.
 */
const bigintToNumber = {
  to: (value: number): number => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Short opaque identifier used in the public URL — never the internal PK. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  /** Derived from the uploaded filename at draft creation; editable in Phase 04. */
  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  /** Reason a terminal failure happened, so a failed video is diagnosable without worker logs. */
  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** S3 `UploadId` of the in-flight multipart upload; cleared once completed or aborted. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  /**
   * `bigint`, deliberately: the 10GB ceiling is 10 737 418 240 bytes, which
   * overflows PostgreSQL's `int4` maximum of 2 147 483 647. An `integer` column
   * here would silently break the phase's headline capability.
   */
  @Column({ type: 'bigint', transformer: bigintToNumber })
  declared_size_bytes: number;

  @Column({ type: 'varchar', length: 127 })
  declared_content_type: string;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  /** Technical metadata as returned by `ffprobe -print_format json`. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
