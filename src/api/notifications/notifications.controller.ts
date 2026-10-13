import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import User from '@/api/user/user.entity';
import { NotificationsService } from './notifications.service';
import {
  ListNotificationsQueryDto,
  MarkAllReadResultDto,
  MarkReadResultDto,
  NotificationListDto,
  UnreadCountDto,
} from './dto/notification.dto';

/**
 * Centre de notifications in-app (demandes et acceptations d'amitié,
 * partages, invitations à un groupe de lecture, nouveaux chapitres).
 *
 * Les acquittements répondent 200 (et non 201, défaut Nest d'un POST) :
 * l'app teste `== 200`.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @ApiOperation({
    summary: 'Mes notifications, plus récentes d’abord (pagination `before`)',
  })
  @ApiResponse({ status: 200, type: NotificationListDto })
  @ApiResponse({ status: 400, description: '`limit` ou `before` invalide' })
  @Get()
  async list(
    @Query() query: ListNotificationsQueryDto,
    @UserDecorator() user: User,
  ): Promise<NotificationListDto> {
    return this.service.list(user.id, query);
  }

  @ApiOperation({ summary: 'Nombre de notifications non lues (badge)' })
  @ApiResponse({ status: 200, type: UnreadCountDto })
  @Get('unread-count')
  async unreadCount(@UserDecorator() user: User): Promise<UnreadCountDto> {
    return { count: await this.service.unreadCount(user.id) };
  }

  @ApiOperation({ summary: 'Marquer toutes mes notifications comme lues' })
  @ApiResponse({ status: 200, type: MarkAllReadResultDto })
  @HttpCode(200)
  @Post('read-all')
  async readAll(@UserDecorator() user: User): Promise<MarkAllReadResultDto> {
    return this.service.markAllRead(user.id);
  }

  @ApiOperation({ summary: 'Marquer une notification comme lue' })
  @ApiResponse({ status: 200, type: MarkReadResultDto })
  @ApiResponse({
    status: 404,
    description: 'Inconnue, ou appartient à un autre utilisateur',
  })
  @HttpCode(200)
  @Post(':id/read')
  async markRead(
    // Identifiant mal formé → 404 comme une notification inconnue.
    @Param(
      'id',
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND }),
    )
    id: string,
    @UserDecorator() user: User,
  ): Promise<MarkReadResultDto> {
    return this.service.markRead(user.id, id);
  }
}
