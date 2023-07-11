import {
  Body,
  Controller,
  Delete,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { NotFoundInterceptor } from 'src/api/interceptors/not-found.interceptor';
import { MangaDetailsDto } from 'src/api/mangas/dto/manga-details.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MangaQuickViewDto } from 'src/api/mangas/dto/manga-quick-view.dto';
import { SaveMangaDto } from './dto/save-manga.dto';
import { LibraryService } from './library.service';
import { JwtAuthGuard } from '@/api/user/auth/auth.guard';
import {UserDecorator} from "@/shared/Decorator/user.decorator";

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
  @UseGuards(JwtAuthGuard)
  async save(@Body() saveMangaDto: SaveMangaDto,@UserDecorator() user : any): Promise<MangaDetailsDto> {
    return await this.libraryService.saveManga(
      saveMangaDto.muId,
      user.id,
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
  @UseGuards(JwtAuthGuard)
  async all(
    @UserDecorator() user : any,
  ): Promise<MangaQuickViewDto[]> {
    return this.libraryService.getMangas(user.id);
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
  @UseGuards(JwtAuthGuard)
  async delete(@Body() deleteMangaDto: SaveMangaDto,@UserDecorator() user : any): Promise<boolean> {
    return await this.libraryService.deleteManga(
      user.id,
      deleteMangaDto.muId,
    );
  }
}
