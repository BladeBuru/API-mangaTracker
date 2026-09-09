import { ConfigService } from '@nestjs/config';
import {
  READER_HASH_LENGTH,
  READER_HASH_MIN_SALT_LENGTH,
  ReaderHashService,
} from './reader-hash.service';

const SALT_A = 'a'.repeat(READER_HASH_MIN_SALT_LENGTH);
const SALT_B = 'b'.repeat(READER_HASH_MIN_SALT_LENGTH);

function serviceWith(salt: string | undefined): ReaderHashService {
  const config = {
    get: (key: string) =>
      key === 'READER_SIGNAL_HASH_SALT' ? salt : undefined,
  } as unknown as ConfigService;
  return new ReaderHashService(config);
}

/**
 * La pseudonymisation est la pierre angulaire du dispositif RGPD : si elle
 * cède, tout le reste devient de la collecte de données personnelles brutes.
 * Ces tests couvrent les trois propriétés dont dépend cette promesse —
 * déterminisme, dépendance au sel, et refus de fonctionner sans sel.
 */
describe('ReaderHashService', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('produit le MÊME hash pour la même entrée et le même sel', () => {
    const first = serviceWith(SALT_A);
    const second = serviceWith(SALT_A);
    expect(first.hash(75503901)).toBe(second.hash(75503901));
    // La forme numérique et la forme chaîne désignent le même lecteur : MU
    // renvoie tantôt l'une tantôt l'autre selon l'endpoint.
    expect(first.hash(75503901)).toBe(first.hash('75503901'));
  });

  it('produit un hash DIFFÉRENT avec un sel différent', () => {
    expect(serviceWith(SALT_A).hash(75503901)).not.toBe(
      serviceWith(SALT_B).hash(75503901),
    );
  });

  it('produit un hash différent pour deux lecteurs différents', () => {
    const service = serviceWith(SALT_A);
    expect(service.hash(75503901)).not.toBe(service.hash(75503902));
  });

  it('produit un hexadécimal de 64 caractères (SHA-256)', () => {
    const hash = serviceWith(SALT_A).hash(114128543);
    expect(hash).toHaveLength(READER_HASH_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ne laisse JAMAIS transparaître l’identifiant d’origine', () => {
    // Un hash qui contiendrait l'identifiant en clair (ou sa forme hexa)
    // annulerait la pseudonymisation.
    const userId = '75503901';
    const hash = serviceWith(SALT_A).hash(userId);
    expect(hash).not.toContain(userId);
    expect(hash).not.toContain(Number(userId).toString(16));
    expect(hash).not.toContain(SALT_A);
  });

  describe('fail-closed', () => {
    it('se déclare non configuré et refuse de hacher sans sel', () => {
      const service = serviceWith(undefined);
      expect(service.isConfigured).toBe(false);
      expect(() => service.hash(1)).toThrow(/non configuré/i);
    });

    it('refuse un sel vide ou uniquement composé d’espaces', () => {
      expect(serviceWith('').isConfigured).toBe(false);
      expect(serviceWith('    ').isConfigured).toBe(false);
    });

    it('refuse un sel trop court plutôt que de le compléter', () => {
      const service = serviceWith('trop-court');
      expect(service.isConfigured).toBe(false);
      expect(() => service.hash(1)).toThrow();
    });

    it('n’invente jamais de sel par défaut', () => {
      // Deux instances sans sel ne doivent surtout PAS se mettre d'accord
      // sur une valeur de repli : elles doivent toutes deux refuser.
      expect(() => serviceWith(undefined).hash(1)).toThrow();
      expect(() => serviceWith(undefined).hash(1)).toThrow();
    });
  });

  describe('hashAll', () => {
    it('dédoublonne et associe chaque identifiant brut à son hash', () => {
      const service = serviceWith(SALT_A);
      const map = service.hashAll([1, '1', 2]);
      expect(map.size).toBe(2);
      expect(map.get('1')).toBe(service.hash(1));
      expect(map.get('2')).toBe(service.hash(2));
    });
  });
});
