import { Test, TestingModule } from '@nestjs/testing';
import { MangasService } from './mangas.service';
import { HttpModule } from '@nestjs/axios';
import { HelperService } from './helper.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { MangaRecommendation } from './manga-recommendation.entity';
import { UserManga } from './user-manga.entity';

const mockRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  })),
});

describe('MangasService', () => {
  let service: MangasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MangasService,
        HelperService,
        { provide: getRepositoryToken(Manga), useValue: mockRepo() },
        {
          provide: getRepositoryToken(MangaRecommendation),
          useValue: mockRepo(),
        },
        { provide: getRepositoryToken(UserManga), useValue: mockRepo() },
      ],
      imports: [HttpModule],
    }).compile();

    service = module.get<MangasService>(MangasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
