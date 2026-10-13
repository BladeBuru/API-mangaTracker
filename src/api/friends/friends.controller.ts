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
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { FriendsService } from './friends.service';
import { FriendRequestThrottlerGuard } from './friend-request-throttler.guard';
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
    description: 'Auto-ajout ou cible manquante',
  })
  @ApiResponse({
    status: 409,
    description:
      "Relation déjà existante : « Demande d'amitié déjà envoyée » ou « Vous êtes déjà amis »",
  })
  @ApiResponse({ status: 403, description: 'Relation bloquée' })
  @ApiResponse({ status: 404, description: 'Utilisateur introuvable' })
  // Anti-spam : 5 demandes par minute PAR UTILISATEUR (garde nominatif,
  // exécuté après le JwtAuthGuard de la classe).
  @UseGuards(FriendRequestThrottlerGuard)
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

  @ApiOperation({
    summary: 'Demandes envoyées en attente (autre utilisateur = destinataire)',
  })
  @ApiResponse({ status: 200, type: [FriendshipDto] })
  @Get('sent')
  async listSent(@UserDecorator() user: any): Promise<FriendshipDto[]> {
    return this.service.listPendingSent(user.id);
  }

  @ApiOperation({
    summary:
      "Recherche d'utilisateurs (username ou nom affiché, sans casse ni accents) avec l'état de la relation",
  })
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

  @ApiOperation({
    summary:
      'Supprimer une amitié, annuler sa demande envoyée ou refuser une demande reçue',
  })
  @ApiResponse({ status: 200, description: '{ deleted: true }' })
  @ApiResponse({ status: 403, description: 'Pas dans cette relation' })
  @ApiResponse({ status: 404, description: 'Relation introuvable' })
  @Delete(':id')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @UserDecorator() user: any,
  ): Promise<{ deleted: boolean }> {
    await this.service.deleteFriendship(user.id, id);
    return { deleted: true };
  }
}
