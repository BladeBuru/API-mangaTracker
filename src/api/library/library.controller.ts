import {
  Body,
  Controller,
  Delete,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { NotFoundInterceptor } from 'src/api/interceptors/not-found.interceptor';
import { MangaDetailsDto } from 'src/api/mangas/dto/manga-details.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MangaQuickViewDto } from 'src/api/mangas/dto/manga-quick-view.dto';
import { SaveMangaDto } from './dto/save-manga.dto';
import { SavedMangaDto } from './dto/saved-manga.dto';
import { LibraryService } from './library.service';

@ApiTags('Library')
@Controller('library')
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @ApiOperation({
    summary: "Add a manga to user's collection",
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      "Request has been validated. Add the manga with given id to user's collection",
    type: MangaDetailsDto,
  })
  @UseInterceptors(NotFoundInterceptor)
  @Post('save')
  async save(@Body() saveMangaDto: SaveMangaDto): Promise<MangaDetailsDto> {
    return await this.libraryService.saveManga(
      saveMangaDto.muId,
      saveMangaDto.userId,
    );
  }

  @ApiOperation({ summary: 'Return all mangas in user library' })
  @ApiResponse({
    status: 200,
    description: 'Request has been validated. Return mangas in user library',
    type: MangaQuickViewDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @Post('all')
  async all(
    @Body() savedMangaDto: SavedMangaDto,
  ): Promise<MangaQuickViewDto[]> {
    return this.libraryService.getMangas(savedMangaDto.userId);
  }

  @ApiOperation({ summary: 'Delete given manga in user library' })
  @ApiResponse({
    status: 200,
    description: 'Return true if the manga has been deleted from user library',
    type: MangaQuickViewDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  @Delete('delete')
  async delete(@Body() deleteMangaDto: SaveMangaDto): Promise<boolean> {
    return await this.libraryService.deleteManga(
      deleteMangaDto.userId,
      deleteMangaDto.muId,
    );
  }
}
