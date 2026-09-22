import { generatePublicId, generateUniquePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('produces a base64url string that fits the varchar(16) column', () => {
    const id = generatePublicId();

    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeLessThanOrEqual(16);
  });

  it('does not repeat across a large draw', () => {
    const ids = new Set(Array.from({ length: 1000 }, generatePublicId));

    expect(ids.size).toBe(1000);
  });
});

describe('generateUniquePublicId', () => {
  it('returns the first candidate when it is free', async () => {
    const isTaken = jest.fn().mockResolvedValue(false);

    const id = await generateUniquePublicId(isTaken);

    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(isTaken).toHaveBeenCalledTimes(1);
  });

  it('draws again when a candidate is already taken', async () => {
    const isTaken = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const id = await generateUniquePublicId(isTaken);

    expect(isTaken).toHaveBeenCalledTimes(3);
    // The winning candidate is the third draw, not one of the rejected ones.
    const [[first], [second], [third]] = isTaken.mock.calls as [string][];
    expect(id).toBe(third);
    expect(id).not.toBe(first);
    expect(id).not.toBe(second);
  });

  it('throws rather than looping forever when every candidate collides', async () => {
    const isTaken = jest.fn().mockResolvedValue(true);

    await expect(generateUniquePublicId(isTaken, 3)).rejects.toThrow(
      'Could not generate a free public id after 3 attempts',
    );
    expect(isTaken).toHaveBeenCalledTimes(3);
  });
});
