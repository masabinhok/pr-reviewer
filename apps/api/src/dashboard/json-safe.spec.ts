import { jsonSafe } from './json-safe.js';

describe('jsonSafe', () => {
  it('turns BigInts into strings and dates into ISO strings, however deep', () => {
    const value = {
      id: 12345678901234567890n,
      when: new Date('2026-09-18T10:00:00Z'),
      nested: [{ commentId: 3990898871n, at: null, ok: true, n: 3 }],
    };

    expect(jsonSafe(value)).toEqual({
      id: '12345678901234567890',
      when: '2026-09-18T10:00:00.000Z',
      nested: [{ commentId: '3990898871', at: null, ok: true, n: 3 }],
    });
    // The point of it: this is what would have thrown.
    expect(() => JSON.stringify(jsonSafe(value))).not.toThrow();
  });
});
