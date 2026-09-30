import {
  AUTHOR_BIO_MAX_LENGTH,
  mapMuAuthor,
  mapMuAuthorWorks,
  toPlainText,
} from './mu-author.mapper';

describe('mu-author.mapper', () => {
  describe('mapMuAuthor', () => {
    it('lit une fiche MangaUpdates complète', () => {
      const info = mapMuAuthor({
        id: 30768624283,
        name: 'ODA Eiichiro',
        actualname: '尾田 栄一郎',
        associated: [{ name: 'Oda Eiichirou' }, { name: 'ODA Eiichiro' }],
        image: {
          url: { original: 'https://cdn/x.jpg', thumb: 'https://cdn/t.jpg' },
        },
        comments: 'Auteur de <b>One Piece</b>.<br>Né à Kumamoto.',
        birthday: {
          year: 1975,
          month: 1,
          day: 1,
          as_string: 'January 1, 1975',
        },
        birthplace: 'Kumamoto',
        genres: [
          { genre: 'Action' },
          { genre: 'Adventure' },
          { genre: 'Smut' },
        ],
        social: { officialsite: [{ url: 'https://one-piece.com' }] },
      });
      expect(info).toEqual({
        name: 'ODA Eiichiro',
        actualName: '尾田 栄一郎',
        associatedNames: ['Oda Eiichirou'],
        imageUrl: 'https://cdn/x.jpg',
        bio: 'Auteur de One Piece.\nNé à Kumamoto.',
        birthday: 'January 1, 1975',
        birthplace: 'Kumamoto',
        genres: ['Action', 'Adventure'],
        officialSite: 'https://one-piece.com',
      });
    });

    it('tolère une fiche minimale et renvoie null sans nom', () => {
      expect(mapMuAuthor({ name: 'X' })).toMatchObject({
        name: 'X',
        bio: null,
        imageUrl: null,
        genres: [],
        associatedNames: [],
        officialSite: null,
      });
      expect(mapMuAuthor({})).toBeNull();
      expect(mapMuAuthor(null)).toBeNull();
      expect(mapMuAuthor('oops')).toBeNull();
    });
  });

  describe('mapMuAuthorWorks', () => {
    it('lit series_list, retire doublons et œuvres adultes', () => {
      const works = mapMuAuthorWorks({
        series_list: [
          {
            series_id: 1,
            title: 'One Piece',
            year: '1997',
            genres: [{ genre: 'Action' }],
          },
          { series_id: 1, title: 'One Piece (doublon)', year: '1997' },
          { series_id: 2, title: 'Wanted!', year: '1998' },
          { series_id: 3, title: 'Adulte', genres: [{ genre: 'Hentai' }] },
          { series_id: 0, title: 'Invalide' },
          { title: 'Sans id' },
        ],
      });
      expect(works).toEqual([
        { muId: 1, title: 'One Piece', year: 1997, genres: ['Action'] },
        { muId: 2, title: 'Wanted!', year: 1998, genres: [] },
      ]);
    });

    it('accepte les formes alternatives (results / record)', () => {
      expect(
        mapMuAuthorWorks({
          results: [{ record: { series_id: 9, title: 'T' } }],
        }),
      ).toEqual([{ muId: 9, title: 'T', year: null, genres: [] }]);
      expect(mapMuAuthorWorks(undefined)).toEqual([]);
    });
  });

  describe('toPlainText', () => {
    it('retire HTML et BBCode et coupe les longues biographies', () => {
      expect(toPlainText('[b]Gras[/b] &amp; <i>fin</i>')).toBe('Gras & fin');
      const long = 'mot '.repeat(1000);
      const plain = toPlainText(long) ?? '';
      expect(plain.length).toBeLessThanOrEqual(AUTHOR_BIO_MAX_LENGTH + 1);
      expect(plain.endsWith('…')).toBe(true);
      expect(toPlainText('   ')).toBeNull();
    });
  });
});
