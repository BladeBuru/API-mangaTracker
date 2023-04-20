import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import user from '../Entity/user.entity';
import { UserService } from '../Service/user/user.service';
import { UsersController } from '../Controller/users/users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([user])],
  controllers: [UsersController],
  providers: [UserService],
})
export class UserModule {}
