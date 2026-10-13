import { MangaQuickViewDto } from './manga-quick-view.dto';
import { UserManga } from '../user-manga.entity';

/** Entrée bibliothèque minimale ; `rating` tel que le renvoie le driver pg. */
const libraryEntry = (rating: unknown): UserManga =>
  ({
    manga: {
      mu_id: '42',
      title: 'Test Manga',
      year: 2020,
      medium_cover_url: 'cover.jpg',
      rating,
      total_chapters: 100,
      associated: [],
    },
    user_read_chapters: 12,
    readingStatus: 'reading',
    user_rating: 0,
    custom_link: null,
    currentChapter: null,
    currentPositionPercent: null,
    currentPositionUpdatedAt: null,
  } as unknown as UserManga);

describe('MangaQuickViewDto.fromLibrary — rating', () => {
  it('should return a number, not the Postgres decimal string ("7.50")', () => {
    const dto = MangaQuickViewDto.fromLibrary(libraryEntry('7.50'));
    expect(dto.rating).toBe(7.5);
    expect(typeof dto.rating).toBe('number');
  });

  it('should keep null when the rating is unknown', () => {
    expect(MangaQuickViewDto.fromLibrary(libraryEntry(null)).rating).toBeNull();
  });

  it('should leave an already numeric rating unchanged', () => {
    expect(MangaQuickViewDto.fromLibrary(libraryEntry(8.42)).rating).toBe(8.42);
  });
});
