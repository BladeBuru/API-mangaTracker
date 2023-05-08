import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { Manga } from 'src/api/mangas/manga.entity';
import User from './user.entity';
import { UserManga } from 'src/api/mangas/user-manga.entity';
import { AuthModule } from './auth/auth.module';
import { UserController } from '@/api/user/users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, Manga, UserManga]), AuthModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
