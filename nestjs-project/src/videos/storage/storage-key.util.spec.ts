import {
  safeExtensionFrom,
  thumbnailObjectKey,
  thumbnailPublicUrl,
  videoObjectKey,
} from './storage-key.util';

describe('safeExtensionFrom', () => {
  it('lowercases a normal extension', () => {
    expect(safeExtensionFrom('Minha Viagem.MP4')).toBe('.mp4');
  });

  it('returns empty string when the filename has no extension', () => {
    expect(safeExtensionFrom('no-extension')).toBe('');
  });

  it('rejects an extension carrying path separators', () => {
    expect(safeExtensionFrom('evil.tar/../../etc/passwd')).toBe('');
  });

  it('rejects an implausibly long extension', () => {
    expect(safeExtensionFrom(`file.${'a'.repeat(20)}`)).toBe('');
  });

  it('rejects an extension with non-alphanumeric characters', () => {
    expect(safeExtensionFrom('file.mp4;rm')).toBe('');
  });

  it('handles a filename with several dots by taking the last segment', () => {
    expect(safeExtensionFrom('my.holiday.video.mkv')).toBe('.mkv');
  });
});

describe('videoObjectKey', () => {
  it('keys by the internal videoId, not the public id', () => {
    expect(
      videoObjectKey('11111111-2222-3333-4444-555555555555', 'clip.mp4'),
    ).toBe('videos/11111111-2222-3333-4444-555555555555/original.mp4');
  });

  it('omits the extension when the filename has none', () => {
    expect(videoObjectKey('abc', 'clip')).toBe('videos/abc/original');
  });

  it('always lands under the videos/ prefix', () => {
    expect(videoObjectKey('abc', 'clip.webm').startsWith('videos/')).toBe(true);
  });
});

describe('thumbnailObjectKey', () => {
  it('uses a fixed frame.jpg name under the thumbnails prefix', () => {
    expect(thumbnailObjectKey('abc')).toBe('thumbnails/abc/frame.jpg');
  });
});

describe('thumbnailPublicUrl', () => {
  it('builds a path-style URL against the public endpoint', () => {
    expect(
      thumbnailPublicUrl(
        'http://localhost:9000',
        'streamtube-thumbnails',
        'thumbnails/abc/frame.jpg',
      ),
    ).toBe(
      'http://localhost:9000/streamtube-thumbnails/thumbnails/abc/frame.jpg',
    );
  });

  it('does not double the slash when the endpoint has a trailing one', () => {
    expect(
      thumbnailPublicUrl(
        'http://localhost:9000/',
        'b',
        'thumbnails/a/frame.jpg',
      ),
    ).toBe('http://localhost:9000/b/thumbnails/a/frame.jpg');
  });

  it('carries no query string — the thumbnails bucket is public-read', () => {
    const url = thumbnailPublicUrl('http://localhost:9000', 'b', 'k');
    expect(url).not.toContain('?');
    expect(url).not.toContain('X-Amz-Signature');
  });
});
