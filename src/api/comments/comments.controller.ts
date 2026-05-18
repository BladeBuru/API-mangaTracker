import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { CommentsService } from './comments.service';
import {
  CommentDto,
  CreateCommentDto,
  ListCommentsQueryDto,
  ReportCommentDto,
  UpdateCommentDto,
} from './dto/comment.dto';

/**
 * Endpoints commentaires (Phase 7).
 *
 * Throttle agressif sur les écritures : 10 commentaires / heure / user
 * (anti-spam). Lectures non throttlées au-delà du throttler global.
 */
@ApiTags('Comments')
@ApiBearerAuth()
@Controller('mangas')
@UseGuards(JwtAuthGuard)
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @ApiOperation({ summary: "Liste paginée des commentaires d'un manga" })
  @ApiResponse({ status: 200, type: [CommentDto] })
  @Get(':muId/comments')
  async list(
    @Param('muId', ParseIntPipe) muId: number,
    @Query() query: ListCommentsQueryDto,
  ): Promise<{ items: CommentDto[]; page: number; hasMore: boolean }> {
    return this.service.listForManga(muId, query);
  }

  @ApiOperation({ summary: "Réponses d'un commentaire" })
  @ApiResponse({ status: 200, type: [CommentDto] })
  @Get('comments/:commentId/replies')
  async listReplies(
    @Param('commentId', ParseIntPipe) commentId: number,
  ): Promise<CommentDto[]> {
    return this.service.listReplies(commentId);
  }

  @ApiOperation({ summary: 'Poster un commentaire top-level' })
  @ApiResponse({ status: 201, type: CommentDto })
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @Post(':muId/comments')
  async create(
    @Param('muId', ParseIntPipe) muId: number,
    @Body() body: CreateCommentDto,
    @UserDecorator() user: any,
  ): Promise<CommentDto> {
    return this.service.createTopLevel(user.id, muId, body);
  }

  @ApiOperation({ summary: 'Répondre à un commentaire' })
  @ApiResponse({ status: 201, type: CommentDto })
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @Post('comments/:commentId/reply')
  async reply(
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() body: CreateCommentDto,
    @UserDecorator() user: any,
  ): Promise<CommentDto> {
    return this.service.createReply(user.id, commentId, body);
  }

  @ApiOperation({ summary: 'Éditer son commentaire' })
  @ApiResponse({ status: 200, type: CommentDto })
  @Patch('comments/:commentId')
  async update(
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() body: UpdateCommentDto,
    @UserDecorator() user: any,
  ): Promise<CommentDto> {
    return this.service.update(user.id, commentId, body);
  }

  @ApiOperation({ summary: 'Supprimer son commentaire (soft delete)' })
  @ApiResponse({ status: 200 })
  @Delete('comments/:commentId')
  async delete(
    @Param('commentId', ParseIntPipe) commentId: number,
    @UserDecorator() user: any,
  ): Promise<{ deleted: boolean }> {
    await this.service.softDelete(user.id, commentId);
    return { deleted: true };
  }

  @ApiOperation({ summary: 'Signaler un commentaire (modération)' })
  @ApiResponse({ status: 200 })
  @Post('comments/:commentId/report')
  async report(
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() body: ReportCommentDto,
    @UserDecorator() user: any,
  ): Promise<{ reported: boolean }> {
    await this.service.reportComment(user.id, commentId, body.reason);
    return { reported: true };
  }
}
