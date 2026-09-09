import { of, throwError } from 'rxjs';
import { MU_LIST_MAX_PER_PAGE, MuListsClient } from './mu-lists.client';

function axiosError(status: number) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status },
  };
}

describe('MuListsClient', () => {
  let client: MuListsClient;
  let getMock: jest.Mock;
  let postMock: jest.Mock;

  beforeEach(() => {
    getMock = jest.fn();
    postMock = jest.fn();
    client = new MuListsClient({
      get: getMock,
      post: postMock,
    } as never);
    // Le backoff ne doit pas attendre réellement dans les tests.
    client.sleep = jest.fn(() => Promise.resolve());
  });

  describe('fetchSimilarReaders', () => {
    it('appelle l’endpoint documenté et mappe la réponse', async () => {
      getMock.mockReturnValue(
        of({
          data: {
            total_hits: 1,
            users: [{ user_id: 42, user_name: 'pseudo', user_rating: 8 }],
          },
        }),
      );
      const readers = await client.fetchSimilarReaders(
        'complete',
        '15180124327',
      );
      expect(getMock).toHaveBeenCalledWith(
        'https://api.mangaupdates.com/v1/lists/similar/complete/15180124327',
      );
      expect(readers).toEqual([{ userId: '42', rating: 8 }]);
    });

    it('traite un 404 comme « aucun lecteur », pas comme une erreur', async () => {
      // MU répond 404 pour une série que personne n'a rangée dans ce type :
      // le compter comme un échec déclencherait le disjoncteur sur un
      // fonctionnement nominal.
      getMock.mockReturnValue(throwError(() => axiosError(404)));
      await expect(client.fetchSimilarReaders('hold', '1')).resolves.toEqual(
        [],
      );
      expect(getMock).toHaveBeenCalledTimes(1);
    });

    it('réessaie un 429 puis réussit', async () => {
      getMock
        .mockReturnValueOnce(throwError(() => axiosError(429)))
        .mockReturnValueOnce(of({ data: { users: [{ user_id: 7 }] } }));
      const readers = await client.fetchSimilarReaders('read', '1');
      expect(readers).toEqual([{ userId: '7', rating: null }]);
      expect(client.sleep).toHaveBeenCalledWith(5000);
    });

    it('propage une erreur non retryable sans insister', async () => {
      getMock.mockReturnValue(throwError(() => axiosError(400)));
      await expect(
        client.fetchSimilarReaders('read', '1'),
      ).rejects.toBeDefined();
      expect(getMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchPublicLists', () => {
    it('renvoie les listes publiques exploitables', async () => {
      getMock.mockReturnValue(of({ data: [{ list_id: 2, type: 'complete' }] }));
      await expect(client.fetchPublicLists('900')).resolves.toEqual([
        { listId: '2', listType: 'complete' },
      ]);
      expect(getMock).toHaveBeenCalledWith(
        'https://api.mangaupdates.com/v1/lists/public/900',
      );
    });

    it('renvoie une liste vide pour un compte sans liste publique', async () => {
      getMock.mockReturnValue(of({ data: [] }));
      await expect(client.fetchPublicLists('900')).resolves.toEqual([]);
    });
  });

  describe('fetchListPage', () => {
    it('poste perpage et page, et remonte l’écho de perpage', async () => {
      postMock.mockReturnValue(
        of({
          data: {
            total_hits: 153,
            per_page: 1000,
            results: [{ series_id: 1, metadata: { user_rating: 9 } }],
          },
        }),
      );
      const page = await client.fetchListPage('900', '2', 'complete', 1, 1000);
      expect(postMock).toHaveBeenCalledWith(
        'https://api.mangaupdates.com/v1/lists/public/900/search/2',
        { perpage: 1000, page: 1 },
      );
      expect(page.totalHits).toBe(153);
      expect(page.perPageEcho).toBe(1000);
      expect(page.rows).toEqual([
        { muId: '1', listType: 'complete', rating: 9 },
      ]);
    });

    it('plafonne perpage à la valeur réellement acceptée par MU', async () => {
      // Au-delà, MU coerce silencieusement à 25 : une liste de 900 titres
      // serait tronquée à 25 sans que rien ne le signale.
      postMock.mockReturnValue(of({ data: { results: [] } }));
      await client.fetchListPage('900', '2', 'read', 1, 99_999);
      expect(postMock.mock.calls[0][1]).toEqual({
        perpage: MU_LIST_MAX_PER_PAGE,
        page: 1,
      });
    });

    it('traite un 404 comme une liste devenue privée', async () => {
      postMock.mockReturnValue(throwError(() => axiosError(404)));
      await expect(
        client.fetchListPage('900', '3', 'unfinished', 1, 1000),
      ).resolves.toEqual({ rows: [], totalHits: 0, perPageEcho: 0 });
    });
  });
});
