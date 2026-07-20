import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DescriptionTranslationService } from './description-translation.service';
import { MangaTranslation } from '../manga-translation.entity';
import { DeeplProvider } from './deepl.provider';
import { GtxProvider } from './gtx.provider';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** Query builder chainable pour l'upsert insert().orUpdate() */
const createInsertQb = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['insert', 'into', 'values', 'orUpdate']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({});
  return qb;
};

describe('DescriptionTranslationService', () => {
  let service: DescriptionTranslationService;
  let repo: { findOneBy: jest.Mock; createQueryBuilder: jest.Mock };
  let insertQb: Record<string, jest.Mock>;
  let deepl: { isEnabled: jest.Mock; translate: jest.Mock };
  let gtx: { translate: jest.Mock };

  const DESCRIPTION = 'An epic story about a manga tracker.';

  const buildService = async (timeoutMs?: number) => {
    repo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => insertQb),
    };
    insertQb = createInsertQb();
    deepl = {
      isEnabled: jest.fn().mockReturnValue(false),
      translate: jest.fn().mockResolvedValue(null),
    };
    gtx = { translate: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DescriptionTranslationService,
        { provide: getRepositoryToken(MangaTranslation), useValue: repo },
        { provide: DeeplProvider, useValue: deepl },
        { provide: GtxProvider, useValue: gtx },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'TRANSLATION_TIMEOUT_MS' && timeoutMs !== undefined
                ? String(timeoutMs)
                : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<DescriptionTranslationService>(
      DescriptionTranslationService,
    );
  };

  beforeEach(async () => {
    await buildService();
  });

  describe('parsePrimaryLang', () => {
    it('should extract the primary subtag from a full Accept-Language header', () => {
      expect(service.parsePrimaryLang('fr-FR,fr;q=0.9,en;q=0.8')).toBe('fr');
      expect(service.parsePrimaryLang('pt-BR')).toBe('pt');
      expect(service.parsePrimaryLang('JA')).toBe('ja');
    });

    it('should return null for a missing or invalid header', () => {
      expect(service.parsePrimaryLang(undefined)).toBeNull();
      expect(service.parsePrimaryLang('')).toBeNull();
      expect(service.parsePrimaryLang('*')).toBeNull();
      expect(service.parsePrimaryLang('  ;q=0.9')).toBeNull();
    });
  });

  describe('passthrough (en / absent / non supporté)', () => {
    it.each(['en', null, 'zz'])(
      'should return null for lang=%p without any DB query nor provider call',
      async (lang) => {
        const result = await service.getTranslatedDescription(
          42,
          DESCRIPTION,
          lang as string | null,
        );

        expect(result).toBeNull();
        expect(repo.findOneBy).not.toHaveBeenCalled();
        expect(deepl.translate).not.toHaveBeenCalled();
        expect(gtx.translate).not.toHaveBeenCalled();
      },
    );

    it('should return null for an empty source description', async () => {
      expect(await service.getTranslatedDescription(42, '', 'fr')).toBeNull();
      expect(gtx.translate).not.toHaveBeenCalled();
    });
  });

  describe('cache hit (hash égal)', () => {
    it('should return the cached translation without calling any provider', async () => {
      repo.findOneBy.mockResolvedValue({
        mu_id: '42',
        language: 'fr',
        source_hash: sha256(DESCRIPTION),
        translated_description: 'Une histoire épique.',
      });

      const result = await service.getTranslatedDescription(
        42,
        DESCRIPTION,
        'fr',
      );

      expect(result).toBe('Une histoire épique.');
      expect(repo.findOneBy).toHaveBeenCalledWith({
        mu_id: '42',
        language: 'fr',
      });
      expect(deepl.translate).not.toHaveBeenCalled();
      expect(gtx.translate).not.toHaveBeenCalled();
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('cache miss (hash différent) → provider + upsert', () => {
    it('should re-translate and upsert when the source hash changed', async () => {
      repo.findOneBy.mockResolvedValue({
        mu_id: '42',
        language: 'fr',
        source_hash: sha256('old description'),
        translated_description: 'Traduction périmée.',
      });
      gtx.translate.mockResolvedValue('Nouvelle traduction.');

      const result = await service.getTranslatedDescription(
        42,
        DESCRIPTION,
        'fr',
      );

      expect(result).toBe('Nouvelle traduction.');
      expect(gtx.translate).toHaveBeenCalledWith(DESCRIPTION, 'fr');
      expect(insertQb.values).toHaveBeenCalledWith({
        mu_id: '42',
        language: 'fr',
        source_hash: sha256(DESCRIPTION),
        translated_description: 'Nouvelle traduction.',
      });
      expect(insertQb.orUpdate).toHaveBeenCalledWith(
        ['source_hash', 'translated_description', 'updated_at'],
        ['mu_id', 'language'],
      );
      expect(insertQb.execute).toHaveBeenCalled();
    });

    it('should try DeepL first when enabled, then fall back to gtx', async () => {
      deepl.isEnabled.mockReturnValue(true);
      deepl.translate.mockResolvedValue(null);
      gtx.translate.mockResolvedValue('Fallback gtx.');

      const result = await service.getTranslatedDescription(
        42,
        DESCRIPTION,
        'fr',
      );

      expect(result).toBe('Fallback gtx.');
      expect(deepl.translate).toHaveBeenCalledWith(DESCRIPTION, 'fr');
      expect(gtx.translate).toHaveBeenCalledWith(DESCRIPTION, 'fr');
    });

    it('should not call gtx when DeepL succeeds', async () => {
      deepl.isEnabled.mockReturnValue(true);
      deepl.translate.mockResolvedValue('Via DeepL.');

      const result = await service.getTranslatedDescription(
        42,
        DESCRIPTION,
        'fr',
      );

      expect(result).toBe('Via DeepL.');
      expect(gtx.translate).not.toHaveBeenCalled();
    });
  });

  describe('échec provider', () => {
    it('should return null (original description côté controller) when all providers fail', async () => {
      gtx.translate.mockResolvedValue(null);

      const result = await service.getTranslatedDescription(
        42,
        DESCRIPTION,
        'fr',
      );

      expect(result).toBeNull();
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return null when the provider rejects (never a 5xx)', async () => {
      gtx.translate.mockRejectedValue(new Error('network down'));

      const result = await service.getTranslatedDescription(
        42,
        DESCRIPTION,
        'fr',
      );

      expect(result).toBeNull();
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('timeout → null immédiat + upsert différé', () => {
    it('should return null after the timeout but still upsert in background', async () => {
      await buildService(20);
      gtx.translate.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve('Traduction tardive.'), 60),
          ),
      );

      const result = await service.getTranslatedDescription(
        42,
        DESCRIPTION,
        'fr',
      );

      // Timeout (20 ms) < durée provider (60 ms) → null immédiat.
      expect(result).toBeNull();
      expect(insertQb.execute).not.toHaveBeenCalled();

      // La promesse continue en arrière-plan et upserte pour le visiteur
      // suivant (pattern fire-and-forget).
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(insertQb.values).toHaveBeenCalledWith({
        mu_id: '42',
        language: 'fr',
        source_hash: sha256(DESCRIPTION),
        translated_description: 'Traduction tardive.',
      });
      expect(insertQb.execute).toHaveBeenCalled();
    });
  });

  describe('dédup in-flight', () => {
    it('should translate only once for concurrent requests on the same (manga, lang)', async () => {
      let resolveTranslate: (value: string) => void;
      gtx.translate.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveTranslate = resolve;
          }),
      );

      const p1 = service.getTranslatedDescription(42, DESCRIPTION, 'fr');
      const p2 = service.getTranslatedDescription(42, DESCRIPTION, 'fr');
      // Laisse les deux appels dépasser le findOneBy et rejoindre la même
      // promesse in-flight avant de résoudre le provider.
      await new Promise((resolve) => setTimeout(resolve, 10));
      resolveTranslate('Une seule traduction.');

      expect(await p1).toBe('Une seule traduction.');
      expect(await p2).toBe('Une seule traduction.');
      expect(gtx.translate).toHaveBeenCalledTimes(1);
    });
  });
});
