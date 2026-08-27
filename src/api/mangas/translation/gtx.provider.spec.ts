import { of, throwError } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import {
  GtxProvider,
  GTX_MAX_CHUNK_LENGTH,
  splitOnSentenceBoundary,
} from './gtx.provider';

describe('splitOnSentenceBoundary', () => {
  it('should return the text as a single chunk when under the limit', () => {
    expect(splitOnSentenceBoundary('Short text.', 3500)).toEqual([
      'Short text.',
    ]);
  });

  it('should split on sentence boundaries without cutting a sentence in half', () => {
    const sentence = 'A'.repeat(30) + '. ';
    const text = sentence.repeat(10); // 320 caractères

    const chunks = splitOnSentenceBoundary(text, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      // Chaque chunk se termine sur une frontière de phrase.
      expect(chunk.trimEnd().endsWith('.')).toBe(true);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('should hard-split a degenerate sentence longer than the limit', () => {
    const text = 'B'.repeat(250); // aucune ponctuation

    const chunks = splitOnSentenceBoundary(text, 100);

    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});

describe('GtxProvider', () => {
  const gtxResponse = (translated: string) =>
    of({ data: [[[translated, 'source', null]]] });

  it('should translate a short text in a single call and parse the gtx payload', async () => {
    const get = jest.fn().mockReturnValue(gtxResponse('Bonjour le monde.'));
    const provider = new GtxProvider({ get } as unknown as HttpService);

    const result = await provider.translate('Hello world.', 'fr');

    expect(result).toBe('Bonjour le monde.');
    expect(get).toHaveBeenCalledTimes(1);
    const url: string = get.mock.calls[0][0];
    expect(url).toContain('client=gtx');
    expect(url).toContain('tl=fr');
    expect(url).toContain(`q=${encodeURIComponent('Hello world.')}`);
  });

  it('should chunk a long description (~3500 chars per call) and join the results', async () => {
    const sentence = 'This is a sentence about manga. ';
    const longText = sentence.repeat(200); // 6400 caractères > 3500
    const get = jest
      .fn()
      .mockReturnValueOnce(gtxResponse('Chunk un.'))
      .mockReturnValueOnce(gtxResponse('Chunk deux.'));
    const provider = new GtxProvider({ get } as unknown as HttpService);

    const result = await provider.translate(longText, 'fr');

    expect(get).toHaveBeenCalledTimes(2);
    for (const call of get.mock.calls) {
      // Chunk borné AVANT encodage URL.
      const encoded = (call[0] as string).split('&q=')[1];
      expect(decodeURIComponent(encoded).length).toBeLessThanOrEqual(
        GTX_MAX_CHUNK_LENGTH,
      );
    }
    expect(result).toBe('Chunk un. Chunk deux.');
  });

  it('should return null (never throw) when the endpoint fails', async () => {
    const get = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('403 banned')));
    const provider = new GtxProvider({ get } as unknown as HttpService);

    await expect(provider.translate('Hello.', 'fr')).resolves.toBeNull();
  });

  it('should return null when the payload has no translated segments', async () => {
    const get = jest.fn().mockReturnValue(of({ data: [] }));
    const provider = new GtxProvider({ get } as unknown as HttpService);

    await expect(provider.translate('Hello.', 'fr')).resolves.toBeNull();
  });
});
