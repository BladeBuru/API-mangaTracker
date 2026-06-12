import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserFriendship } from './user-friendship.entity';
import { FriendsService } from './friends.service';
import { FriendsController } from './friends.controller';

/**
 * Module Amis (Phase 6). Expose CRUD complet sur les relations
 * d'amitié : envoyer/accepter/rejeter/bloquer/supprimer + recherche,
 * et la bibliothèque d'un ami accepté (`GET /friends/:id/library`).
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, UserFriendship, UserManga])],
  controllers: [FriendsController],
  providers: [FriendsService],
  exports: [FriendsService],
})
export class FriendsModule {}
