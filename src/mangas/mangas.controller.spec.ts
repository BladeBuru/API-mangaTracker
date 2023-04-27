import { Test, TestingModule } from '@nestjs/testing';
import { MangasController } from './mangas.controller';

describe('MangasController', () => {
  let controller: MangasController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MangasController],
    }).compile();

    controller = module.get<MangasController>(MangasController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
