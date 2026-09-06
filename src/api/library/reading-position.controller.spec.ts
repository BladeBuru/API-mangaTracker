import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ReadingPositionController } from './reading-position.controller';
import { ReadingPositionService } from './reading-position.service';
import { ReadingPositionDto } from './dto/reading-position.dto';

describe('ReadingPositionController', () => {
  let controller: ReadingPositionController;
  let service: {
    saveReadingPosition: jest.Mock;
    getReadingPosition: jest.Mock;
  };
  let res: { status: jest.Mock };

  // Instanciation directe : passer par `Test.createTestingModule` obligerait
  // à monter les gardes déclarées en `@UseGuards` (JWT + throttler), qui ne
  // sont pas l'objet de ces tests.
  beforeEach(() => {
    service = {
      saveReadingPosition: jest.fn().mockResolvedValue({ ok: true }),
      getReadingPosition: jest.fn(),
    };
    res = { status: jest.fn().mockReturnThis() };

    controller = new ReadingPositionController(
      service as unknown as ReadingPositionService,
    );
  });

  it('transmet le corps validé au service et renvoie { ok: true }', async () => {
    await expect(
      controller.saveReadingPosition(
        { muId: 42, chapter: 13, positionPercent: 40 },
        { id: 1 },
      ),
    ).resolves.toEqual({ ok: true });

    expect(service.saveReadingPosition).toHaveBeenCalledWith(1, 42, 13, 40);
  });

  it("répond 204 sans corps quand aucune position n'est enregistrée", async () => {
    service.getReadingPosition.mockResolvedValue(null);

    const result = await controller.getReadingPosition(
      42,
      { id: 1 },
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(HttpStatus.NO_CONTENT);
    expect(result).toBeUndefined();
  });

  it('répond 200 avec la position quand il y en a une', async () => {
    const position: ReadingPositionDto = {
      chapter: 13,
      positionPercent: 42,
      updatedAt: '2026-09-06T12:34:56.000Z',
    };
    service.getReadingPosition.mockResolvedValue(position);

    const result = await controller.getReadingPosition(
      42,
      { id: 1 },
      res as unknown as Response,
    );

    // Statut laissé au 200 posé par Nest avant le handler.
    expect(res.status).not.toHaveBeenCalled();
    expect(result).toEqual(position);
  });
});
