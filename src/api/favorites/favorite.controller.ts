import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Request,
  UseGuards
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/auth.guard';
import { FavoriteService } from '@/api/favorites/favorite.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { FavoritesDto } from '@/api/favorites/dto/favorite.dto';

@ApiTags('favorites)')
@Controller('favorites')
export class FavoriteController {
  @Inject(FavoriteService)
  private readonly service: FavoriteService;

  @ApiOperation({
    summary: 'Add a manga to users favorites mangas',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description: 'Request has been validated. the favoris has been added',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Post('favorites')
  async favorites(
      @Body() body: FavoritesDto,
  ): Promise<MangaQuickViewDto[]> {
    return await this.service.addFavoriteManga(body.mangaId, body.userId);
  }


  @ApiOperation({
    summary: 'Get the list of users favorites mangas',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description: 'list of users favorites mangas',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get('favorites')
  async getFavorites(
      @Request() req
  ): Promise<MangaQuickViewDto[]> {
    return await this.service.getFavoriteManga(req.user.id);
  }

  @ApiOperation({
    summary: 'Delete a manga from users favorites',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description: 'the manga has been deleted from users favorites',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Delete('delete')
  async deleteFavorites(
    @Body() body: FavoritesDto,
  ): Promise<MangaQuickViewDto[]> {
    return await this.service.deleteFavoriteManga(body.mangaId, body.userId);
  }
}
