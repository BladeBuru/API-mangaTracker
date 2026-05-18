import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { NotFoundInterceptor } from 'src/api/interceptors/not-found.interceptor';
import { MangaDetailsDto } from 'src/api/mangas/dto/manga-details.dto';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MangaQuickViewDto } from 'src/api/mangas/dto/manga-quick-view.dto';
import { SaveMangaDto } from './dto/save-manga.dto';
import { LibraryService } from './library.service';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { UpdateChapterDto } from '@/api/library/dto/update-chapter-dto';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UpdateReadingStatusDto } from '@/api/library/dto/update-reading-status-dto';
import { UpdateCustomLinkDto } from './dto/update-custom-link.dto';
import { UpdateRatingDto } from './dto/update-rating.dto';
import { ChapterLogService } from './chapter-log.service';
import {
  ChapterLogEntryDto,
  RecordChapterLogDto,
  ToggleChapterSkipDto,
} from './dto/chapter-log.dto';

@ApiTags('Library')
@ApiBearerAuth()
@Controller('library')
export class LibraryController {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly chapterLogService: ChapterLogService,
  ) {}

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
  async save(
    @Body() saveMangaDto: SaveMangaDto,
    @UserDecorator() user: any,
  ): Promise<MangaDetailsDto> {
    return await this.libraryService.saveManga(saveMangaDto.muId, user.id);
  }

  @ApiOperation({ summary: 'Return all mangas in user library' })
  @ApiResponse({
    status: 200,
    description: 'Request has been validated. Return mangas in user library',
    type: MangaQuickViewDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @Get('all')
  @UseGuards(JwtAuthGuard)
  async all(@UserDecorator() user: any): Promise<MangaQuickViewDto[]> {
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
  async delete(
    @Body() deleteMangaDto: SaveMangaDto,
    @UserDecorator() user: any,
  ): Promise<boolean> {
    return await this.libraryService.deleteManga(user.id, deleteMangaDto.muId);
  }

  @ApiOperation({
    summary: 'Update given user manga progress with specified value',
  })
  @ApiResponse({ status: 200, description: 'Chapter has been updated' })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({ status: 404, description: 'Manga or User not found' })
  @ApiResponse({
    status: 406,
    description: 'Provided chapter parameter is not a valid value',
  })
  @Put('chapter')
  @UseGuards(JwtAuthGuard)
  async updateChapter(
    @Body() updateChapterDto: UpdateChapterDto,
    @UserDecorator() user: any,
  ): Promise<UpdateChapterDto> {
    await this.libraryService.updateChapter(
      user.id,
      updateChapterDto.muId,
      updateChapterDto.readChapters,
    );

    return updateChapterDto;
  }

  @ApiOperation({
    summary: 'Update given user manga reading status with specified value',
  })
  @ApiResponse({ status: 200, description: 'Reading status has been updated' })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({ status: 404, description: 'Manga or User not found' })
  @ApiResponse({
    status: 406,
    description: 'Provided status parameter is not a valid value',
  })
  @Put('status')
  @UseGuards(JwtAuthGuard)
  async updateReadingStatus(
    @Body() updateReadingStatusDto: UpdateReadingStatusDto,
    @UserDecorator() user: any,
  ): Promise<UpdateReadingStatusDto> {
    await this.libraryService.updateReadingStatus(
      user.id,
      updateReadingStatusDto.muId,
      updateReadingStatusDto.readingStatus,
    );

    return updateReadingStatusDto;
  }

  @ApiOperation({
    summary: 'Add or update a custom link for a manga in user library',
  })
  @ApiResponse({
    status: 200,
    description: 'Custom link has been added/updated',
  })
  @Put('custom-link')
  @UseGuards(JwtAuthGuard)
  async updateCustomLink(
    @Body() updateCustomLinkDto: UpdateCustomLinkDto,
    @UserDecorator() user: any,
  ): Promise<boolean> {
    return await this.libraryService.updateCustomLink(
      user.id,
      updateCustomLinkDto.muId,
      updateCustomLinkDto.customLink,
    );
  }

  @ApiOperation({
    summary: 'Delete the custom link for a manga in user library',
  })
  @ApiResponse({ status: 200, description: 'Custom link has been deleted' })
  @Delete('custom-link')
  @UseGuards(JwtAuthGuard)
  async deleteCustomLink(
    @Body() updateCustomLinkDto: UpdateCustomLinkDto,
    @UserDecorator() user: any,
  ): Promise<boolean> {
    return await this.libraryService.deleteCustomLink(
      user.id,
      updateCustomLinkDto.muId,
    );
  }

  // ─────── Phase 5 : log additif des sessions de lecture ───────

  @ApiOperation({
    summary: "Enregistrer une session de lecture d'un chapitre (Phase 5)",
    description:
      "Insertion additive — N appels = N lignes (replays). Le compteur `user_read_chapters` reste géré par PUT /library/chapter.",
  })
  @ApiResponse({ status: 201, type: ChapterLogEntryDto })
  @Post(':muId/chapter-log')
  @UseGuards(JwtAuthGuard)
  async recordChapterLog(
    @Param('muId', ParseIntPipe) muId: number,
    @Body() body: RecordChapterLogDto,
    @UserDecorator() user: any,
  ): Promise<ChapterLogEntryDto> {
    return this.chapterLogService.recordChapterRead(user.id, muId, body);
  }

  @ApiOperation({
    summary: "Historique des sessions de lecture pour un manga (Phase 5)",
  })
  @ApiResponse({ status: 200, type: [ChapterLogEntryDto] })
  @Get(':muId/chapter-log')
  @UseGuards(JwtAuthGuard)
  async listChapterLog(
    @Param('muId', ParseIntPipe) muId: number,
    @UserDecorator() user: any,
  ): Promise<ChapterLogEntryDto[]> {
    return this.chapterLogService.listForManga(user.id, muId);
  }

  @ApiOperation({
    summary: "Marquer un chapitre comme skippé / unskippé (Phase 5)",
  })
  @ApiResponse({ status: 200, type: ChapterLogEntryDto })
  @Put(':muId/chapter/:chapterNumber/skip')
  @UseGuards(JwtAuthGuard)
  async toggleChapterSkip(
    @Param('muId', ParseIntPipe) muId: number,
    @Param('chapterNumber') chapterNumberRaw: string,
    @Body() body: ToggleChapterSkipDto,
    @UserDecorator() user: any,
  ): Promise<ChapterLogEntryDto> {
    const chapterNumber = Number(chapterNumberRaw);
    return this.chapterLogService.toggleSkip(
      user.id,
      muId,
      chapterNumber,
      body.skipped,
    );
  }

  @ApiOperation({
    summary: 'Mettre à jour la note personnelle (1-10) pour un manga',
  })
  @ApiResponse({ status: 200, description: 'Note mise à jour' })
  @ApiResponse({ status: 404, description: 'Manga non trouvé dans la bibliothèque' })
  @Put('rating')
  @UseGuards(JwtAuthGuard)
  async updateRating(
    @Body() updateRatingDto: UpdateRatingDto,
    @UserDecorator() user: any,
  ): Promise<boolean> {
    return await this.libraryService.updateRating(
      user.id,
      updateRatingDto.muId,
      updateRatingDto.rating,
    );
  }
}
