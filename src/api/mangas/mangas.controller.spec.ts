import { Test, TestingModule } from '@nestjs/testing';
import { MangasController } from './mangas.controller';
import { MangasService } from './mangas.service';
import { LibraryService } from '@/api/library/library.service';
import { DescriptionTranslationService } from './translation/description-translation.service';
import { MangaDetailsDto } from './dto/manga-details.dto';

describe('MangasController — mangaDetails / translated_description', () => {
  let controller: MangasController;
  let mangasService: {
    getMangaDetails: jest.Mock;
    getCommunityRatings: jest.Mock;
  };
  let libraryService: { getUserManga: jest.Mock };
  let translationService: {
    parsePrimaryLang: jest.Mock;
    getTranslatedDescription: jest.Mock;
  };

  const baseDetails = () => {
    const dto = new MangaDetailsDto();
    dto.muId = 42;
    dto.title = 'Test Manga';
    dto.description = 'Original English description.';
    dto.rating = 8.2;
    return dto;
  };

  beforeEach(async () => {
    mangasService = {
      getMangaDetails: jest.fn().mockResolvedValue(baseDetails()),
      getCommunityRatings: jest.fn().mockResolvedValue(new Map()),
    };
    libraryService = { getUserManga: jest.fn().mockResolvedValue(null) };
    translationService = {
      parsePrimaryLang: jest.fn().mockReturnValue(null),
      getTranslatedDescription: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MangasController],
      providers: [
        { provide: MangasService, useValue: mangasService },
        { provide: LibraryService, useValue: libraryService },
        {
          provide: DescriptionTranslationService,
          useValue: translationService,
        },
      ],
    }).compile();

    controller = module.get<MangasController>(MangasController);
  });

  it('should return translated_description when Accept-Language requests a supported lang', async () => {
    translationService.parsePrimaryLang.mockReturnValue('fr');
    translationService.getTranslatedDescription.mockResolvedValue(
      'Description originale traduite.',
    );

    const result = await controller.mangaDetails(
      42,
      { id: 7 },
      'fr-FR,fr;q=0.9',
    );

    expect(translationService.parsePrimaryLang).toHaveBeenCalledWith(
      'fr-FR,fr;q=0.9',
    );
    expect(translationService.getTranslatedDescription).toHaveBeenCalledWith(
      42,
      'Original English description.',
      'fr',
    );
    expect(result.translated_description).toBe(
      'Description originale traduite.',
    );
    // La description originale reste TOUJOURS renvoyée telle quelle.
    expect(result.description).toBe('Original English description.');
  });

  it('should not return translated_description without Accept-Language header', async () => {
    const result = await controller.mangaDetails(42, { id: 7 }, undefined);

    expect(translationService.parsePrimaryLang).toHaveBeenCalledWith(undefined);
    expect(translationService.getTranslatedDescription).toHaveBeenCalledWith(
      42,
      'Original English description.',
      null,
    );
    expect(result.translated_description).toBeUndefined();
    expect(result.description).toBe('Original English description.');
  });
});
