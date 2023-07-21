import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FavoriteService } from '@/api/favorites/favorite.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { FavoritesDto } from '@/api/favorites/dto/favorite.dto';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { JwtAuthGuard } from "@/api/user/auth/guard/auth.guard";

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
    @UserDecorator() user: any,
  ): Promise<MangaQuickViewDto[]> {
    return await this.service.addFavoriteManga(body.mangaId, user.id);
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
  async getFavorites(@UserDecorator() user: any): Promise<MangaQuickViewDto[]> {
    return await this.service.getFavoriteManga(user.id);
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
    @UserDecorator() user: any,
  ): Promise<MangaQuickViewDto[]> {
    return await this.service.deleteFavoriteManga(body.mangaId, user.id);
  }
}
