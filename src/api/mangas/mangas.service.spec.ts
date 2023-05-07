import { Test, TestingModule } from '@nestjs/testing';
import { MangasService } from './mangas.service';

describe('MangasService', () => {
  let service: MangasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MangasService],
    }).compile();

    service = module.get<MangasService>(MangasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
