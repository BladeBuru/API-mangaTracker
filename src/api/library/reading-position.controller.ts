import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { ReadingPositionService } from './reading-position.service';
import {
  ReadingPositionAckDto,
  ReadingPositionDto,
  UpdateReadingPositionDto,
} from './dto/reading-position.dto';
import { ReadingPositionThrottlerGuard } from './reading-position-throttler.guard';

/** Utilisateur injecté par `JwtAuthGuard` dans `req.user` (stratégie JWT). */
interface AuthenticatedUser {
  id: number;
}

/**
 * Sous-controller du module Library dédié à la reprise de lecture
 * inter-appareils. Séparé de `LibraryController`, qui dépasse déjà la limite
 * de 200 lignes (règle : les fichiers au-dessus du seuil ne doivent pas
 * grossir — découpage en sous-controllers par domaine, comme
 * `ChapterReportController`).
 */
@ApiTags('Library')
@ApiBearerAuth()
@Controller('library')
export class ReadingPositionController {
  constructor(
    private readonly readingPositionService: ReadingPositionService,
  ) {}

  @ApiOperation({
    summary: "Enregistrer où l'utilisateur en est DANS un chapitre",
    description:
      'Permet de reprendre la lecture au même endroit sur un autre appareil. ' +
      "N'écrit QUE la position en cours : `readChapters` (dernier chapitre " +
      'terminé), `readingStatus` et `lastUpdated` ne sont jamais touchés. ' +
      'Écriture idempotente et tolérante — une position en retrait sur le ' +
      'chapitre en cours, reçue moins de deux minutes après la dernière ' +
      "position enregistrée, est ignorée silencieusement (200) pour qu'un " +
      'appareil en retard ne fasse pas reculer un appareil à jour.',
  })
  @ApiResponse({
    status: 200,
    description: 'Position prise en compte (ou volontairement ignorée)',
    type: ReadingPositionAckDto,
  })
  @ApiResponse({
    status: 400,
    description: 'positionPercent hors de [0, 100], ou chapter négatif',
  })
  @ApiResponse({
    status: 404,
    description: "Manga absent de la bibliothèque de l'utilisateur",
  })
  @ApiResponse({
    status: 429,
    description: "Trop d'écritures de position (60/min et par utilisateur)",
  })
  // Le throttler `default` global compte par IP — derrière NPMplus, ce serait
  // un budget partagé par tous les lecteurs. On le neutralise pour cette route
  // (uniquement le throttler nommé `default`) et on lui substitue un quota
  // nominatif porté par `ReadingPositionThrottlerGuard`, dont le throttler
  // s'appelle `reading-position` et n'est donc pas concerné par ce skip.
  @SkipThrottle({ default: true })
  @Put('reading-position')
  @UseGuards(JwtAuthGuard, ReadingPositionThrottlerGuard)
  async saveReadingPosition(
    @Body() body: UpdateReadingPositionDto,
    @UserDecorator() user: AuthenticatedUser,
  ): Promise<ReadingPositionAckDto> {
    return this.readingPositionService.saveReadingPosition(
      user.id,
      body.muId,
      body.chapter,
      body.positionPercent,
    );
  }

  @ApiOperation({
    summary: 'Position de lecture en cours pour UN manga',
    description:
      "Interrogée à l'ouverture du lecteur, pour proposer la reprise. " +
      "Répond 204 sans corps quand il n'y a aucune position en cours — y " +
      "compris si le manga n'est plus dans la bibliothèque : « pas de " +
      'position » est la seule information utile au lecteur. Les mêmes ' +
      'champs sont exposés en bloc par `GET /library/all`.',
  })
  @ApiResponse({ status: 200, type: ReadingPositionDto })
  @ApiResponse({ status: 204, description: 'Aucune position en cours' })
  @Get(':muId/reading-position')
  @UseGuards(JwtAuthGuard)
  async getReadingPosition(
    @Param('muId', ParseIntPipe) muId: number,
    @UserDecorator() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadingPositionDto | undefined> {
    const position = await this.readingPositionService.getReadingPosition(
      user.id,
      muId,
    );

    if (!position) {
      // `passthrough` : Nest a déjà posé le 200 par défaut avant le handler
      // et ne le réécrit pas après — le statut fixé ici fait foi, corps vide.
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }

    return position;
  }
}
