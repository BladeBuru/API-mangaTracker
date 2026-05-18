import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from '@/api/user/user.entity';
import { UserFriendship } from './user-friendship.entity';
import { FriendsService } from './friends.service';
import { FriendsController } from './friends.controller';

/**
 * Module Amis (Phase 6). Expose CRUD complet sur les relations
 * d'amitié : envoyer/accepter/rejeter/bloquer/supprimer + recherche.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, UserFriendship])],
  controllers: [FriendsController],
  providers: [FriendsService],
  exports: [FriendsService],
})
export class FriendsModule {}
