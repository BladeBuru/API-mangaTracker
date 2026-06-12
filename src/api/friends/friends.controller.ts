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
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { FriendsService } from './friends.service';
import {
  FriendshipDto,
  SendFriendRequestDto,
  UpdateFriendshipStatusDto,
  UserSearchResultDto,
} from './dto/friend.dto';

@ApiTags('Friends')
@ApiBearerAuth()
@Controller('friends')
@UseGuards(JwtAuthGuard)
export class FriendsController {
  constructor(private readonly service: FriendsService) {}

  @ApiOperation({ summary: "Envoyer une demande d'amitié" })
  @ApiResponse({ status: 201, type: FriendshipDto })
  @ApiResponse({
    status: 400,
    description: 'Relation déjà existante / self-add',
  })
  @ApiResponse({ status: 403, description: 'Relation bloquée' })
  @ApiResponse({ status: 404, description: 'Utilisateur introuvable' })
  // Anti-spam : 5 demandes par minute par user (throttler explicite).
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('request')
  async request(
    @Body() body: SendFriendRequestDto,
    @UserDecorator() user: any,
  ): Promise<FriendshipDto> {
    return this.service.sendRequest(user.id, body);
  }

  @ApiOperation({ summary: 'Liste des amis acceptés' })
  @ApiResponse({ status: 200, type: [FriendshipDto] })
  @Get()
  async listAccepted(@UserDecorator() user: any): Promise<FriendshipDto[]> {
    return this.service.listAccepted(user.id);
  }

  @ApiOperation({ summary: 'Demandes reçues en attente' })
  @ApiResponse({ status: 200, type: [FriendshipDto] })
  @Get('pending')
  async listPending(@UserDecorator() user: any): Promise<FriendshipDto[]> {
    return this.service.listPendingReceived(user.id);
  }

  @ApiOperation({ summary: "Recherche d'utilisateurs pour autocomplete" })
  @ApiResponse({ status: 200, type: [UserSearchResultDto] })
  @Get('search')
  async search(
    @Query('q') query: string,
    @UserDecorator() user: any,
  ): Promise<UserSearchResultDto[]> {
    return this.service.searchUsers(user.id, query ?? '');
  }

  @ApiOperation({
    summary: "Bibliothèque d'un ami (amitié acceptée requise)",
  })
  @ApiResponse({ status: 200, type: [MangaQuickViewDto] })
  @ApiResponse({ status: 403, description: 'Pas amis' })
  @Get(':id/library')
  async friendLibrary(
    @Param('id', ParseIntPipe) id: number,
    @UserDecorator() user: any,
  ): Promise<MangaQuickViewDto[]> {
    return this.service.getFriendLibrary(user.id, id);
  }

  @ApiOperation({
    summary: "Accepter / rejeter / bloquer une demande (par l'addressee)",
  })
  @ApiResponse({ status: 200, type: FriendshipDto })
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateFriendshipStatusDto,
    @UserDecorator() user: any,
  ): Promise<FriendshipDto> {
    return this.service.updateStatus(user.id, id, body.status);
  }

  @ApiOperation({ summary: 'Supprimer une amitié' })
  @ApiResponse({ status: 200 })
  @Delete(':id')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @UserDecorator() user: any,
  ): Promise<{ deleted: boolean }> {
    await this.service.deleteFriendship(user.id, id);
    return { deleted: true };
  }
}
