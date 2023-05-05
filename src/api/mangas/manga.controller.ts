import {
    Body,
    Controller, Get,
    Inject, Post, Request, UseGuards,
} from '@nestjs/common';

import {ApiTags} from "@nestjs/swagger";
import {MangasService} from "@/api/mangas/mangas.service";
import {JwtAuthGuard} from "@/api/user/auth/auth.guard";
import {Manga} from "@/api/mangas/manga.entity";
@ApiTags('mangas')
@Controller('mangas')
export class MangaController {
    @Inject(MangasService)
    private readonly service: MangasService;

    @UseGuards(JwtAuthGuard)
    @Post('favorites')
    async favorites(@Body() body: { mangaId: number }, @Request() req): Promise<void>{
        await this.service.addFavoriteManga(body.mangaId, req.user.id);
    }

    @UseGuards(JwtAuthGuard)
    @Get('favorites')
    async getFavorites(@Request() req): Promise<Manga[]>{
         return await this.service.getFavoriteManga(req.user.id);
    }
    @UseGuards(JwtAuthGuard)
    @Post('favorites/delete')
    async deleteFavorites(@Body() body: { mangaId: number }, @Request() req): Promise<void>{
        await this.service.deleteFavoriteManga(body.mangaId, req.user.id);
    }
}

