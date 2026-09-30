import { BadRequestException } from '@nestjs/common';
import { ParseMuIdPipe } from './parse-mu-id.pipe';

describe('ParseMuIdPipe', () => {
  const pipe = new ParseMuIdPipe();

  it('should accept a positive MangaUpdates id', () => {
    expect(pipe.transform('55099564912')).toBe(55099564912);
  });

  it.each(['0', '-7', 'abc', '1.5', '', '123456789012345678901'])(
    'should reject %p',
    (raw) => {
      expect(() => pipe.transform(raw)).toThrow(BadRequestException);
    },
  );
});
