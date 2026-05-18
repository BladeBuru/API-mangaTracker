import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Redirect,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
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
   * Proxy de couverture (Phase 4 — refactoré en 302 redirect).
   * Endpoint PUBLIC (pas de JWT). Redirige vers l'URL MU upstream.
   *
   * **Cache strategy** : 5 min seulement (`max-age=300`). Sans `immutable`
   * — sinon le browser cache la 404 à vie si l'URL est temporairement
   * cassée. Au pire on refait un round-trip API toutes les 5 min, ce qui
   * est négligeable face à la robustesse gagnée.
   */
  @ApiOperation({
    summary: 'Redirige vers la cover MangaUpdates du manga',
  })
  @ApiResponse({ status: 302, description: 'Redirection vers URL upstream' })
  @ApiResponse({ status: 404, description: 'Manga ou cover introuvable' })
  @Get(':muId/cover')
  @Header('Cache-Control', 'public, max-age=300')
  @Redirect(undefined, 302)
  async getCover(
    @Param('muId', ParseIntPipe) muId: number,
    @Query('size') sizeRaw: string | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    const size: CoverSize = this.parseSize(sizeRaw);
    const url = await this.coverProxyService.resolveUpstreamUrl(muId, size);
    return { url, statusCode: 302 };
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
