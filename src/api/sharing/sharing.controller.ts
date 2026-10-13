import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { SharingService } from './sharing.service';
import { MangaShareThrottlerGuard } from './manga-share-throttler.guard';
import { MangaShareDto, ShareMangaDto } from './dto/share.dto';

/**
 * Endpoints de partage de manga entre amis (Phase 8).
 * Throttle 30 envois / minute PAR UTILISATEUR (1 envoi peut concerner
 * jusqu'à 20 amis) — `MangaShareThrottlerGuard`.
 */
@ApiTags('Sharing')
@ApiBearerAuth()
@Controller('sharing')
@UseGuards(JwtAuthGuard)
export class SharingController {
  constructor(private readonly service: SharingService) {}

  @ApiOperation({ summary: 'Partager un manga avec un ou plusieurs amis' })
  @ApiResponse({ status: 201, type: [MangaShareDto] })
  @UseGuards(MangaShareThrottlerGuard)
  @Post('manga/:muId')
  async shareManga(
    @Param('muId', ParseIntPipe) muId: number,
    @Body() body: ShareMangaDto,
    @UserDecorator() user: any,
  ): Promise<MangaShareDto[]> {
    return this.service.shareWithFriends(user.id, muId, body);
  }

  @ApiOperation({ summary: 'Inbox : shares reçus (non-vus en premier)' })
  @ApiResponse({ status: 200, type: [MangaShareDto] })
  @Get('inbox')
  async inbox(@UserDecorator() user: any): Promise<MangaShareDto[]> {
    return this.service.listInbox(user.id);
  }

  @ApiOperation({ summary: 'Marquer toutes les shares comme vues' })
  @ApiResponse({ status: 200, description: '{ updated: number }' })
  // 200 explicite : l'app teste `== 200` (un POST Nest répond 201 par défaut).
  @HttpCode(200)
  @Post('inbox/mark-seen')
  async markSeen(@UserDecorator() user: any): Promise<{ updated: number }> {
    return this.service.markAllSeen(user.id);
  }

  @ApiOperation({ summary: 'Compteur shares non-vues (pour badge UI)' })
  @ApiResponse({ status: 200 })
  @Get('inbox/unseen-count')
  async unseenCount(@UserDecorator() user: any): Promise<{ count: number }> {
    return { count: await this.service.unseenCount(user.id) };
  }
}
