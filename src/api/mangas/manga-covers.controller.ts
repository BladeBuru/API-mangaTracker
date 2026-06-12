import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { ConfigService } from '@nestjs/config';
import { MangaSyncService } from './sync-manga.service';
import { UpdateMangaService } from './update-manga.service';
import { CoverProxyService, CoverSize } from './cover-proxy.service';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Mangas')
@ApiBearerAuth()
@Controller('mangas')
export class MangaCoversController {
  constructor(
    private readonly configService: ConfigService,
    private readonly mangaSyncService: MangaSyncService,
    private readonly updateMangaService: UpdateMangaService,
    private readonly coverProxyService: CoverProxyService,
  ) {}

  /**
   * Proxy de couverture — hybride 302 / stream (hotfix-v0-10-1 US-2).
   * Endpoint PUBLIC (pas de JWT — une balise <img> ne peut pas envoyer de
   * header Authorization).
   *
   * - `mode=redirect` (défaut, mobile) : 302 vers l'URL MU upstream.
   *   Cache 5 min seulement (`max-age=300`), sans `immutable` — sinon le
   *   browser cache la 404 à vie si l'URL est temporairement cassée.
   * - `mode=stream` (Flutter Web) : sert les bytes directement (même
   *   origine → CORS OK, le 302 vers le CDN MU est bloqué en CanvasKit).
   *   Cache 24h (les bytes sont stables, le cache disque API absorbe).
   *   Échec upstream → fallback 302 (dégradation douce).
   */
  @ApiOperation({
    summary:
      'Cover MangaUpdates du manga (302 par défaut, bytes si mode=stream)',
  })
  @ApiResponse({ status: 302, description: 'Redirection vers URL upstream' })
  @ApiResponse({ status: 200, description: 'Bytes image (mode=stream)' })
  @ApiResponse({ status: 404, description: 'Manga ou cover introuvable' })
  @Get(':muId/cover')
  async getCover(
    @Param('muId', ParseIntPipe) muId: number,
    @Query('size') sizeRaw: string | undefined,
    @Query('mode') modeRaw: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const size: CoverSize = this.parseSize(sizeRaw);

    if (modeRaw === 'stream') {
      try {
        const { data, contentType } = await this.coverProxyService.streamCover(
          muId,
          size,
        );
        res
          .status(200)
          .setHeader('Content-Type', contentType)
          .setHeader('Cache-Control', 'public, max-age=86400')
          .send(data);
        return;
      } catch (err) {
        if (err instanceof NotFoundException) throw err;
        // Upstream inaccessible en stream → fallback 302 ci-dessous.
      }
    }

    const url = await this.coverProxyService.resolveUpstreamUrl(muId, size);
    res.setHeader('Cache-Control', 'public, max-age=300').redirect(302, url);
  }

  private parseSize(raw: string | undefined): CoverSize {
    if (raw === 'small' || raw === 'medium' || raw === 'large') return raw;
    return 'medium';
  }

  @ApiOperation({ summary: 'Refresh manga covers from MangaUpdates' })
  @ApiResponse({
    status: 200,
    description: 'Covers refreshed; returns the updated MangaQuickViewDto',
    type: MangaQuickViewDto,
  })
  @ApiResponse({ status: 404, description: 'Manga not found' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseGuards(JwtAuthGuard)
  @Post(':muId/refresh-cover')
  async refreshCover(
    @Param('muId', ParseIntPipe) muId: number,
  ): Promise<MangaQuickViewDto> {
    return this.updateMangaService.refreshCovers(muId);
  }

  @Post('admin/sync-all')
  async syncAllMangas(@Query('secret') secret: string) {
    const adminSecret = this.configService.get<string>('DATABASE_PASSWORD');
    if (secret !== adminSecret) {
      throw new UnauthorizedException('Invalid secret');
    }
    await this.mangaSyncService.syncAllMangasWithApi();
    return { message: 'Synchronisation lancée' };
  }
}
