import {
  FfmpegService,
  parseFfprobeOutput,
  thumbnailTimestamp,
} from './ffmpeg.service';
import {
  CommandFailedError,
  ProcessRunner,
  type CommandResult,
} from './process-runner';

function build() {
  // Typed so `mock.calls` keeps its shape — the argv assertions below index
  // into it, and an untyped jest.fn() would degrade them to `any`.
  const runner = {
    run: jest.fn<Promise<CommandResult>, [command: string, args: string[]]>(),
  };
  const service = new FfmpegService(runner as unknown as ProcessRunner);
  return { service, runner };
}

const probeJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: { duration: '2.000000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    streams: [
      { codec_type: 'video', codec_name: 'h264' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    ...overrides,
  });

/**
 * Every field ffprobe reports is optional, and the *absences* are what the
 * verification step acts on: a file with no video stream must be
 * distinguishable from one whose codec merely went unread. So these tests are
 * mostly about what happens when something is missing.
 */
describe('parseFfprobeOutput', () => {
  it('extracts duration, codec and format from a real probe', () => {
    const result = parseFfprobeOutput(probeJson());

    expect(result.durationSeconds).toBe(2);
    expect(result.videoCodec).toBe('h264');
    expect(result.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');
  });

  it('keeps the whole payload for later diagnosis', () => {
    const result = parseFfprobeOutput(probeJson());

    expect(result.raw).toMatchObject({
      format: expect.objectContaining({ duration: '2.000000' }) as unknown,
    });
  });

  it('rounds a fractional duration to whole seconds', () => {
    const result = parseFfprobeOutput(
      probeJson({ format: { duration: '12.6' } }),
    );

    expect(result.durationSeconds).toBe(13);
  });

  it('reports a null codec when there is no video stream', () => {
    // An mp3 or a JPEG probes fine — it simply has no video stream. That null
    // is the signal that the upload is not a video.
    const result = parseFfprobeOutput(
      probeJson({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }),
    );

    expect(result.videoCodec).toBeNull();
  });

  it('reports a null duration when the container omits it', () => {
    const result = parseFfprobeOutput(probeJson({ format: {} }));

    expect(result.durationSeconds).toBeNull();
  });

  it('reports a null duration when ffprobe writes "N/A"', () => {
    // Streamed or truncated containers do this; Number("N/A") is NaN, which
    // must not reach the database as a duration.
    const result = parseFfprobeOutput(
      probeJson({ format: { duration: 'N/A' } }),
    );

    expect(result.durationSeconds).toBeNull();
  });

  it('survives a probe with no streams array at all', () => {
    const result = parseFfprobeOutput(JSON.stringify({ format: {} }));

    expect(result.videoCodec).toBeNull();
    expect(result.durationSeconds).toBeNull();
  });
});

describe('thumbnailTimestamp', () => {
  it('seeks one second in for a clip long enough to have one', () => {
    expect(thumbnailTimestamp(120)).toBe(1);
  });

  it('seeks to the midpoint of a very short clip', () => {
    expect(thumbnailTimestamp(1)).toBe(0.5);
  });

  it.each([[null], [0]])('falls back to frame zero for %p', (duration) => {
    expect(thumbnailTimestamp(duration)).toBe(0);
  });
});

describe('FfmpegService', () => {
  it('asks ffprobe for JSON on both format and streams', async () => {
    const { service, runner } = build();
    runner.run.mockResolvedValue({
      stdout: Buffer.from(probeJson()),
      stderr: '',
    });

    await service.probe('/tmp/source');

    expect(runner.run).toHaveBeenCalledWith('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '/tmp/source',
    ]);
  });

  it('propagates a non-zero exit instead of returning empty metadata', async () => {
    const { service, runner } = build();
    runner.run.mockRejectedValue(
      new CommandFailedError('ffprobe', 1, 'Invalid data found'),
    );

    await expect(service.probe('/tmp/source')).rejects.toBeInstanceOf(
      CommandFailedError,
    );
  });

  it('seeks before the input so a large file is not decoded from the start', async () => {
    const { service, runner } = build();
    runner.run.mockResolvedValue({
      stdout: Buffer.from([0xff, 0xd8]),
      stderr: '',
    });

    await service.extractThumbnail('/tmp/source', 1);

    const [, args] = runner.run.mock.calls[0];
    expect(runner.run).toHaveBeenCalledWith('ffmpeg', expect.any(Array));
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });

  it('returns the frame bytes ffmpeg wrote to stdout', async () => {
    const { service, runner } = build();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    runner.run.mockResolvedValue({ stdout: jpeg, stderr: '' });

    await expect(service.extractThumbnail('/tmp/source', 0)).resolves.toBe(
      jpeg,
    );
  });

  it('fails loudly when ffmpeg exits cleanly but writes no frame', async () => {
    // ffmpeg can exit 0 having produced nothing; storing a zero-byte object
    // would leave a video that looks processed but has a broken thumbnail.
    const { service, runner } = build();
    runner.run.mockResolvedValue({ stdout: Buffer.alloc(0), stderr: '' });

    await expect(service.extractThumbnail('/tmp/source', 0)).rejects.toThrow(
      'no thumbnail frame',
    );
  });
});
