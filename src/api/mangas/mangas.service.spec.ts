import { Test, TestingModule } from '@nestjs/testing';
import { MangasService } from './mangas.service';
import { HttpModule } from '@nestjs/axios';
import { HelperService } from './helper.service';

describe('MangasService', () => {
  let service: MangasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MangasService, HelperService],
      imports: [HttpModule],
    }).compile();

    service = module.get<MangasService>(MangasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
