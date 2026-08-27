import {
  Body,
  Controller,
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
import { ChapterReportService } from './chapter-report.service';
import {
  ReportChaptersDto,
  ReportChaptersResultDto,
} from './dto/report-chapters.dto';
import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * Sous-controller du module Library dédié au signalement « plus de
 * chapitres » (Chantier A). Séparé de `LibraryController` qui dépasse déjà
 * la limite de 200 lignes (règle : les fichiers au-dessus du seuil ne
 * doivent pas grossir — découpage en sous-controllers par domaine).
 */
@ApiTags('Library')
@ApiBearerAuth()
@Controller('library')
export class ChapterReportController {
  constructor(private readonly chapterReportService: ChapterReportService) {}

  @ApiOperation({
    summary:
      'Signaler que le manga a plus de chapitres que le total officiel connu',
    description:
      "Le report devient l'override personnel de l'user : son total effectif = max(total officiel, total signalé). " +
      'Quand au moins 2 users distincts signalent un total concordant, le total officiel est consolidé (bump au MIN des totaux signalés). ' +
      'Le manga doit être dans la bibliothèque (gate anti-abus), le total signalé strictement supérieur au total officiel et borné à total + 200.',
  })
  @ApiResponse({
    status: 201,
    description: 'Report enregistré',
    type: ReportChaptersResultDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Total signalé ≤ total officiel, ou > total officiel + 200 (garde-fou anti-typo)',
  })
  @ApiResponse({
    status: 404,
    description: "Manga inconnu ou absent de la bibliothèque de l'utilisateur",
  })
  @ApiResponse({
    status: 429,
    description: 'Trop de signalements (10/heure et par utilisateur)',
  })
  // Rate-limit strict 10/h PAR UTILISATEUR (et non par IP) : cf.
  // `UserThrottlerGuard`. Le tracking par IP serait un budget global partagé
  // derrière le reverse proxy NPMplus. Le garde DOIT suivre `JwtAuthGuard`
  // (ordre des gardes de route) pour disposer de `req.user`.
  @Post(':muId/report-chapters')
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  async reportChapters(
    @Param('muId', ParseIntPipe) muId: number,
    @Body() body: ReportChaptersDto,
    @UserDecorator() user: any,
  ): Promise<ReportChaptersResultDto> {
    return this.chapterReportService.reportMoreChapters(
      user.id,
      muId,
      body.reportedTotal,
    );
  }
}
