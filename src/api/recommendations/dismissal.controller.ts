import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { DismissalService } from './dismissal.service';
import { DismissMangaDto, DismissalDto } from './dto/dismiss-manga.dto';
import { DismissalThrottlerGuard } from './dismissal-throttler.guard';

/**
 * Routes « pas intéressé / déjà vu » du module Recommendations.
 *
 * Controller dédié plutôt qu'un ajout à `RecommendationController` : ce
 * dernier n'expose que des lectures de recommandations, alors qu'il s'agit
 * ici de mutations d'une préférence utilisateur (rate-limitées, avec leur
 * propre garde).
 */
@ApiTags('Recommendations')
@ApiBearerAuth()
@Controller('recommendations/dismissals')
export class DismissalController {
  constructor(private readonly dismissalService: DismissalService) {}

  @ApiOperation({
    summary:
      'Écarter un manga des recommandations (« pas intéressé / déjà vu »)',
    description:
      'Le titre ne remonte plus dans AUCUN chemin de recommandation (liste paginée, sections par genre, pépites, cold start, recos de la fiche détail) tant que le rejet existe. ' +
      "Rejeter deux fois le même titre ne crée qu'une ligne : la raison la plus récente écrase la précédente. " +
      "Le cache de recommandations est invalidé immédiatement — pas besoin d'attendre le TTL.",
  })
  @ApiResponse({
    status: 201,
    description: 'Rejet enregistré',
    type: DismissalDto,
  })
  @ApiResponse({ status: 400, description: 'Raison absente ou inconnue' })
  @ApiResponse({ status: 404, description: 'Manga inconnu' })
  @ApiResponse({
    status: 429,
    description: 'Trop de rejets (60/heure et par utilisateur)',
  })
  // Le garde de throttle DOIT suivre `JwtAuthGuard` : il tracke `req.user.id`.
  @Post(':muId')
  @UseGuards(JwtAuthGuard, DismissalThrottlerGuard)
  async dismiss(
    @Param('muId', ParseIntPipe) muId: number,
    @Body() body: DismissMangaDto,
    @UserDecorator() user: any,
  ): Promise<DismissalDto> {
    return this.dismissalService.dismiss(user.id, muId, body.reason);
  }

  @ApiOperation({
    summary: 'Annuler un rejet — le titre redevient recommandable',
    description:
      "Utilisé par l'action « Annuler » proposée juste après un rejet, et par un retrait ultérieur depuis la liste des titres écartés.",
  })
  @ApiResponse({ status: 204, description: 'Rejet annulé' })
  @ApiResponse({
    status: 404,
    description: 'Aucun rejet enregistré pour ce manga',
  })
  @Delete(':muId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, DismissalThrottlerGuard)
  async restore(
    @Param('muId', ParseIntPipe) muId: number,
    @UserDecorator() user: any,
  ): Promise<void> {
    return this.dismissalService.restore(user.id, muId);
  }

  @ApiOperation({
    summary:
      "Liste des titres écartés par l'utilisateur (du plus récent au plus ancien)",
    description:
      "Rend un rejet accidentel récupérable même après la disparition du SnackBar d'annulation : le titre étant exclu des recommandations, l'utilisateur ne le recroiserait jamais autrement.",
  })
  @ApiResponse({
    status: 200,
    description: 'Titres écartés avec leur raison',
    type: DismissalDto,
    isArray: true,
  })
  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@UserDecorator() user: any): Promise<DismissalDto[]> {
    return this.dismissalService.listDismissals(user.id);
  }
}
