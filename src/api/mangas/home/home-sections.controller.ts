import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import {
  HomeSectionPageDto,
  HomeSectionPageQueryDto,
  HomeSectionsQueryDto,
  HomeSectionsResponseDto,
  HOME_DEFAULT_LIMIT,
  HOME_PAGE_DEFAULT_LIMIT,
} from './dto/home-sections.dto';
import { HomeSectionsService } from './home-sections.service';

/**
 * Accueil « façon Netflix » — contrat partagé avec le client Flutter (ne pas
 * modifier la forme des réponses sans bump de version). Lecture BDD
 * uniquement, réponses mises en cache ~10 min côté serveur.
 */
@ApiTags('Mangas')
@ApiBearerAuth()
@Controller('mangas/home')
@UseGuards(JwtAuthGuard)
export class HomeSectionsController {
  constructor(private readonly homeSections: HomeSectionsService) {}

  @ApiOperation({
    summary:
      "Sections de l'accueil (nouveautés, populaires, par type, genre, année…)",
    description:
      'Toutes les sections en un appel, `limit` titres chacune (5..40, défaut 20). ' +
      'Ordre décidé côté serveur ; un titre n’apparaît que dans la première ' +
      'section qui le sélectionne ; les sections de moins de 5 titres sont ' +
      'omises. Pas de titre de section : le client traduit `kind` + `params`.',
  })
  @ApiResponse({ status: 200, type: HomeSectionsResponseDto })
  @ApiResponse({ status: 400, description: 'limit hors bornes' })
  @Get('sections')
  getSections(
    @Query() query: HomeSectionsQueryDto,
  ): Promise<HomeSectionsResponseDto> {
    return this.homeSections.getHome(query.limit ?? HOME_DEFAULT_LIMIT);
  }

  @ApiOperation({
    summary: 'Une section de l’accueil, paginée',
    description:
      'Liste complète d’une section (`page` 1-indexée, `limit` 5..40, défaut 40). ' +
      'Ids acceptés : `latest`, `popular`, `top_rated`, `community`, ' +
      '`hidden_gems`, `type:<Type MU>`, `genre:<Genre>`, `year:<AAAA>`. ' +
      'Sans déduplication inter-sections (page autonome).',
  })
  @ApiParam({ name: 'id', example: 'type:Manhwa' })
  @ApiResponse({ status: 200, type: HomeSectionPageDto })
  @ApiResponse({ status: 404, description: 'Section inconnue' })
  @Get('sections/:id')
  getSection(
    @Param('id') id: string,
    @Query() query: HomeSectionPageQueryDto,
  ): Promise<HomeSectionPageDto> {
    return this.homeSections.getSection(
      id,
      query.page ?? 1,
      query.limit ?? HOME_PAGE_DEFAULT_LIMIT,
    );
  }
}
