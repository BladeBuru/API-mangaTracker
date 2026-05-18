import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
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
import { ReadingGroupsService } from './reading-groups.service';
import {
  CreateReadingGroupDto,
  InviteToGroupDto,
  ReadingGroupDto,
} from './dto/reading-group.dto';

/**
 * Endpoints "lecture à deux" (Phase 8.3). Throttle modéré sur les mutations
 * (10/min suffisent pour l'usage attendu : créer un groupe = action rare).
 */
@ApiTags('Reading Groups')
@ApiBearerAuth()
@Controller('reading-groups')
@UseGuards(JwtAuthGuard)
export class ReadingGroupsController {
  constructor(private readonly service: ReadingGroupsService) {}

  @ApiOperation({ summary: 'Créer un groupe de lecture à deux' })
  @ApiResponse({ status: 201, type: ReadingGroupDto })
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post()
  async create(
    @Body() body: CreateReadingGroupDto,
    @UserDecorator() user: any,
  ): Promise<ReadingGroupDto> {
    return this.service.createGroup(user.id, body);
  }

  @ApiOperation({ summary: 'Liste de mes groupes de lecture' })
  @ApiResponse({ status: 200, type: [ReadingGroupDto] })
  @Get()
  async listMine(@UserDecorator() user: any): Promise<ReadingGroupDto[]> {
    return this.service.listMyGroups(user.id);
  }

  @ApiOperation({
    summary: "Détail d'un groupe (avec progression des autres membres)",
  })
  @ApiResponse({ status: 200, type: ReadingGroupDto })
  @ApiResponse({ status: 403, description: 'Non membre' })
  @Get(':id')
  async getOne(
    @Param('id', ParseIntPipe) id: number,
    @UserDecorator() user: any,
  ): Promise<ReadingGroupDto> {
    return this.service.getGroup(user.id, id);
  }

  @ApiOperation({
    summary: 'Inviter un ami (propriétaire uniquement)',
  })
  @ApiResponse({ status: 200, type: ReadingGroupDto })
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post(':id/invite')
  async invite(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: InviteToGroupDto,
    @UserDecorator() user: any,
  ): Promise<ReadingGroupDto> {
    return this.service.inviteToGroup(user.id, id, body.friendId);
  }

  @ApiOperation({
    summary: 'Quitter le groupe (transfère ownership si dernier owner)',
  })
  @ApiResponse({ status: 200 })
  @Delete(':id/leave')
  async leave(
    @Param('id', ParseIntPipe) id: number,
    @UserDecorator() user: any,
  ): Promise<{ left: boolean }> {
    await this.service.leaveGroup(user.id, id);
    return { left: true };
  }

  @ApiOperation({
    summary: 'Supprimer définitivement le groupe (propriétaire uniquement)',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'Non propriétaire' })
  @Delete(':id')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @UserDecorator() user: any,
  ): Promise<{ deleted: boolean }> {
    await this.service.deleteGroup(user.id, id);
    return { deleted: true };
  }
}
