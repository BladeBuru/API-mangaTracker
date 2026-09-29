import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { AuthorsService } from './authors.service';
import { MuAuthorsClient } from './mu-authors.client';

describe('AuthorsService', () => {
  let fetchAuthor: jest.Mock;
  let fetchAuthorSeries: jest.Mock;
  let find: jest.Mock;
  let insertExecute: jest.Mock;
  let service: AuthorsService;

  beforeEach(() => {
    fetchAuthor = jest.fn().mockResolvedValue({ name: 'ODA Eiichiro' });
    fetchAuthorSeries = jest.fn().mockResolvedValue({
      series_list: [
        { series_id: 1, title: 'One Piece', year: '1997' },
        { series_id: 2, title: 'Wanted!', year: '1998' },
      ],
    });
    find = jest.fn().mockResolvedValue([
      {
        mu_id: '1',
        title: 'One Piece',
        rating: '8.90',
        medium_cover_url: 'https://cdn/op.jpg',
        type: 'Manga',
        genres: ['Action'],
      },
    ]);
    insertExecute = jest.fn().mockResolvedValue({});
    const qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: insertExecute,
    };
    const repo = {
      find,
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<Manga>;
    service = new AuthorsService(
      { fetchAuthor, fetchAuthorSeries } as unknown as MuAuthorsClient,
      repo,
    );
  });

  it('assemble fiche + œuvres, enrichies par le catalogue, plus récentes en tête', async () => {
    const author = await service.getAuthor(42);
    expect(author.name).toBe('ODA Eiichiro');
    expect(author.worksComplete).toBe(true);
    expect(author.works).toEqual([
      {
        muId: 2,
        title: 'Wanted!',
        year: 1998,
        mediumCoverUrl: null,
        rating: null,
        type: null,
        genres: [],
      },
      {
        muId: 1,
        title: 'One Piece',
        year: 1997,
        mediumCoverUrl: 'https://cdn/op.jpg',
        rating: 8.9,
        type: 'Manga',
        genres: ['Action'],
      },
    ]);
    // L'œuvre inconnue reçoit une fiche minimale.
    expect(insertExecute).toHaveBeenCalledTimes(1);
  });

  it('un seul appel MU par auteur : cache et requêtes simultanées dédupliquées', async () => {
    await Promise.all([service.getAuthor(42), service.getAuthor(42)]);
    await service.getAuthor(42);
    expect(fetchAuthor).toHaveBeenCalledTimes(1);
    expect(fetchAuthorSeries).toHaveBeenCalledTimes(1);
  });

  it('auteur inconnu → 404, mémorisé', async () => {
    fetchAuthor.mockResolvedValue(null);
    await expect(service.getAuthor(7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getAuthor(7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fetchAuthor).toHaveBeenCalledTimes(1);
  });

  it('MangaUpdates en panne → 503, sans marteler MU', async () => {
    fetchAuthor.mockRejectedValue(new Error('timeout'));
    await expect(service.getAuthor(8)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getAuthor(8)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchAuthor).toHaveBeenCalledTimes(1);
  });

  it("liste des œuvres en échec → fiche partielle plutôt qu'une erreur", async () => {
    fetchAuthorSeries.mockRejectedValue(new Error('500'));
    const author = await service.getAuthor(9);
    expect(author.worksComplete).toBe(false);
    expect(author.works).toEqual([]);
    expect(author.name).toBe('ODA Eiichiro');
  });
});
