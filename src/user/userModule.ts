import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import user from './user.entity';
import { UserService } from './user.service';
import { UsersController } from './users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([user])],
  controllers: [UsersController],
  providers: [UserService],
})
export class UserModule {}
