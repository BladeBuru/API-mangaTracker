import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { AuthorsService } from './authors.service';
import { AuthorDetailsDto } from './dto/author-details.dto';

@ApiTags('Auteurs')
@ApiBearerAuth()
@Controller('authors')
@UseGuards(JwtAuthGuard)
export class AuthorsController {
  constructor(private readonly authors: AuthorsService) {}

  @ApiOperation({
    summary: "Fiche d'un auteur / dessinateur : mini bio et œuvres",
    description:
      'Identifiant MangaUpdates (`authors[].author_id` de la fiche manga). ' +
      'Données MangaUpdates mises en cache 24 h.',
  })
  @ApiResponse({ status: 200, type: AuthorDetailsDto })
  @ApiResponse({ status: 404, description: 'Auteur inconnu' })
  @ApiResponse({ status: 503, description: 'MangaUpdates indisponible' })
  @Get(':authorId')
  getAuthor(
    @Param('authorId', ParseIntPipe) authorId: number,
  ): Promise<AuthorDetailsDto> {
    return this.authors.getAuthor(authorId);
  }
}
