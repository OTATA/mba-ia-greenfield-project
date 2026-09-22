import { Injectable } from '@nestjs/common';
import { ProcessRunner } from './process-runner';

/** The subset of `ffprobe -show_format -show_streams` this phase relies on. */
export interface ProbeResult {
  /** Container duration in whole seconds, or null when the container omits it. */
  durationSeconds: number | null;
  /** Codec of the first video stream, or null when there is no video stream. */
  videoCodec: string | null;
  /** `format_name` as reported by the container, e.g. `mov,mp4,m4a,...`. */
  formatName: string | null;
  /** Everything ffprobe returned, persisted verbatim for later diagnosis. */
  raw: Record<string, unknown>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string };
  streams?: FfprobeStream[];
}

/**
 * Turns raw ffprobe JSON into the typed shape the processor needs.
 *
 * Exported separately from the service because every field here is optional
 * in ffprobe's output — a container can omit `duration`, and an audio-only or
 * image file has no video stream at all. Those absences are the signal the
 * verification step acts on, so the parsing has to preserve them faithfully
 * rather than coerce them to zero.
 */
export function parseFfprobeOutput(stdout: string): ProbeResult {
  const parsed = JSON.parse(stdout) as FfprobeOutput;

  const rawDuration = parsed.format?.duration;
  const duration = rawDuration === undefined ? NaN : Number(rawDuration);
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');

  return {
    durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
    videoCodec: videoStream?.codec_name ?? null,
    formatName: parsed.format?.format_name ?? null,
    raw: parsed as unknown as Record<string, unknown>,
  };
}

/**
 * Where to grab the poster frame.
 *
 * Frame zero of a real video is very often black or a fade-in, so a second in
 * gives a more representative image — but only when the clip is long enough
 * for one second to exist. Halfway is the fallback for very short clips, and
 * zero for clips whose duration the container never reported.
 */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.min(1, durationSeconds / 2);
}

@Injectable()
export class FfmpegService {
  constructor(private readonly runner: ProcessRunner) {}

  /** Reads container and stream metadata without decoding the media. */
  async probe(filePath: string): Promise<ProbeResult> {
    const { stdout } = await this.runner.run('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    return parseFfprobeOutput(stdout.toString('utf8'));
  }

  /**
   * Grabs a single frame as JPEG, written to stdout so no intermediate file
   * has to be managed.
   *
   * `-ss` is placed **before** `-i` deliberately: that makes ffmpeg seek by
   * index instead of decoding from the start, which is the difference between
   * instant and minutes on a multi-gigabyte file.
   */
  async extractThumbnail(filePath: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await this.runner.run('ffmpeg', [
      '-ss',
      String(atSeconds),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);

    if (stdout.length === 0) {
      throw new Error('ffmpeg produced no thumbnail frame');
    }
    return stdout;
  }
}
