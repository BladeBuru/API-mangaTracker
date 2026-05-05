import {
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Query,
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
import { Throttle } from '@nestjs/throttler';

@ApiTags('Mangas')
@ApiBearerAuth()
@Controller('mangas')
export class MangaCoversController {
  constructor(
    private readonly configService: ConfigService,
    private readonly mangaSyncService: MangaSyncService,
    private readonly updateMangaService: UpdateMangaService,
  ) {}

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
