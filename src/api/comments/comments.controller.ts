import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { CommentsService } from './comments.service';
import { CommentWriteThrottlerGuard } from './comment-write-throttler.guard';
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
 * Throttle agressif sur les écritures : 10 commentaires / heure PAR
 * UTILISATEUR et par route (`CommentWriteThrottlerGuard`, anti-spam).
 * Lectures non throttlées au-delà du throttler global.
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
  @UseGuards(CommentWriteThrottlerGuard)
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
  @UseGuards(CommentWriteThrottlerGuard)
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
  @ApiResponse({ status: 200, description: '{ reported: true }' })
  // 200 explicite : l'app teste `== 200` (un POST Nest répond 201 par défaut).
  @HttpCode(200)
  @UseGuards(CommentWriteThrottlerGuard)
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
