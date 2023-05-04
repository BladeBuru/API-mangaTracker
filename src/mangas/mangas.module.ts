import { Module } from '@nestjs/common';
import { MangasController } from './mangas.controller';
import { MangasService } from './mangas.service';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HelperService } from './helper.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { UserManga } from './user-manga.entity';
import User from 'src/user/user.entity';
import { UserService } from 'src/user/user.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        timeout: configService.get('HTTP_TIMEOUT'),
        maxRedirects: configService.get('HTTP_MAX_REDIRECTS'),
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([Manga, User, UserManga]),
  ],
  controllers: [MangasController],
  providers: [MangasService, HelperService, UserService],
})
export class MangasModule {}
