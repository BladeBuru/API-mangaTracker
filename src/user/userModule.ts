import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UsersController } from './users.controller';
import { Manga } from 'src/mangas/manga.entity';
import User from './user.entity';
import { UserManga } from 'src/mangas/user-manga.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Manga, UserManga])],
  controllers: [UsersController],
  providers: [UserService],
})
export class UserModule {}
