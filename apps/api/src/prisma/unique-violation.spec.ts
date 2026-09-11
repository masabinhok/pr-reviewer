import { Prisma } from '../generated/prisma/client.js';
import { retryOnUniqueViolation } from './unique-violation.js';

const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

describe('retryOnUniqueViolation', () => {
  it('returns the first result when nothing races', async () => {
    const write = vi.fn().mockResolvedValue('row');

    await expect(retryOnUniqueViolation(write)).resolves.toBe('row');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('runs the write once more after losing a race to a concurrent insert', async () => {
    const write = vi.fn().mockRejectedValueOnce(p2002()).mockResolvedValueOnce('updated');

    await expect(retryOnUniqueViolation(write)).resolves.toBe('updated');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not retry any other error', async () => {
    const write = vi.fn().mockRejectedValue(new Error('connection lost'));

    await expect(retryOnUniqueViolation(write)).rejects.toThrow('connection lost');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('retries only once — a second violation is a real conflict', async () => {
    const write = vi.fn().mockRejectedValue(p2002());

    await expect(retryOnUniqueViolation(write)).rejects.toMatchObject({ code: 'P2002' });
    expect(write).toHaveBeenCalledTimes(2);
  });
});
