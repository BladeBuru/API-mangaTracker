import {
  extractReleaseUpdates,
  maxTimeAdded,
  MuReleaseResult,
  parseChapterNumber,
} from './mu-release.mapper';

/** Construit un record `releases/search` proche du vrai payload MU. */
function release(opts: {
  seriesId?: number | string | null;
  chapter?: string | null;
  timeAdded?: number | null;
  releaseId?: number;
}): MuReleaseResult {
  return {
    record: {
      // Volontairement DIFFÉRENT du series_id : c'est tout le piège de cette
      // API, et un mapping qui confondrait les deux doit échouer ici.
      id: opts.releaseId ?? 1262426,
      title: 'Peu importe',
      volume: null,
      chapter: opts.chapter === undefined ? '42' : opts.chapter,
      time_added:
        opts.timeAdded === null
          ? null
          : { timestamp: opts.timeAdded ?? 1787934483 },
    },
    metadata:
      opts.seriesId === null
        ? null
        : { series: { series_id: opts.seriesId ?? 64156727159 } },
  };
}

describe('parseChapterNumber', () => {
  // Formes réellement observées sur 100 sorties consécutives (2026-08-29).
  it.each([
    ['166', 166],
    ['7', 7],
    ['12.5', 12],
    ['18b', 18],
    ['112 + Afterword 1-3', 112],
  ])('should parse %s as chapter %s', (raw, expected) => {
    expect(parseChapterNumber(raw)).toBe(expected);
  });

  it('should take the HIGH bound of a range: 12-13 means chapter 13 is out', () => {
    expect(parseChapterNumber('12-13')).toBe(13);
    expect(parseChapterNumber('120 - 122')).toBe(122);
  });

  it('should return null for anything without a leading number', () => {
    expect(parseChapterNumber(null)).toBeNull();
    expect(parseChapterNumber(undefined)).toBeNull();
    expect(parseChapterNumber('')).toBeNull();
    expect(parseChapterNumber('   ')).toBeNull();
    expect(parseChapterNumber('Oneshot')).toBeNull();
    expect(parseChapterNumber('Extra')).toBeNull();
  });

  it('should prefer under-estimating: "5 (of 10)" is chapter 5, not 10', () => {
    // total_chapters est monotone croissant : une sous-estimation se corrige
    // au passage suivant, une surestimation est DÉFINITIVE.
    expect(parseChapterNumber('5 (of 10)')).toBe(5);
  });

  it('should reject chapter 0 (not a real release)', () => {
    expect(parseChapterNumber('0')).toBeNull();
  });
});

describe('extractReleaseUpdates', () => {
  it('should read the series id from metadata, never from record.id', () => {
    const [update] = extractReleaseUpdates([
      release({ seriesId: 64156727159, releaseId: 1262426, chapter: '7' }),
    ]);

    expect(update.muId).toBe('64156727159');
    // Non-régression du piège principal de cette API.
    expect(update.muId).not.toBe('1262426');
    expect(update.chapter).toBe(7);
  });

  it('should skip records without a series id (nothing to match in DB)', () => {
    expect(extractReleaseUpdates([release({ seriesId: null })])).toEqual([]);
    expect(extractReleaseUpdates([release({ seriesId: 0 })])).toEqual([]);
  });

  it('should skip records whose chapter is not parsable', () => {
    expect(extractReleaseUpdates([release({ chapter: 'Oneshot' })])).toEqual(
      [],
    );
    expect(extractReleaseUpdates([release({ chapter: null })])).toEqual([]);
  });

  it('should skip records without a usable time_added', () => {
    expect(extractReleaseUpdates([release({ timeAdded: null })])).toEqual([]);
  });

  it('should deduplicate a series to its HIGHEST chapter', () => {
    const updates = extractReleaseUpdates([
      release({ seriesId: 111, chapter: '10', timeAdded: 1000 }),
      release({ seriesId: 111, chapter: '12', timeAdded: 1200 }),
      release({ seriesId: 111, chapter: '11', timeAdded: 1100 }),
    ]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      muId: '111',
      chapter: 12,
      timeAdded: 1200,
    });
  });

  it('should keep distinct series apart', () => {
    const updates = extractReleaseUpdates([
      release({ seriesId: 111, chapter: '10' }),
      release({ seriesId: 222, chapter: '3' }),
    ]);

    expect(updates.map((u) => u.muId).sort()).toEqual(['111', '222']);
  });
});

describe('maxTimeAdded', () => {
  it('should count records that were SEEN but not exploitable', () => {
    // Une sortie sans chapitre parsable n'écrit rien, mais elle a été vue :
    // si le curseur ne l'englobait pas, elle serait re-parcourue chaque nuit.
    const max = maxTimeAdded([
      release({ chapter: '10', timeAdded: 1000 }),
      release({ chapter: 'Oneshot', timeAdded: 5000 }),
    ]);

    expect(max).toBe(5000);
  });

  it('should return 0 on an empty page', () => {
    expect(maxTimeAdded([])).toBe(0);
  });
});
