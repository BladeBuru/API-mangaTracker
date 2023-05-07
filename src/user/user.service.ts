import { Injectable, Module } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import userEntity from './user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(userEntity)
    private readonly userRepository: Repository<userEntity>,
  ) {}

  async findAll(): Promise<userEntity[]> {
    return await this.userRepository.find();
  }

  async returnUserIfExist(userId: number): Promise<userEntity> {
    const userEntity = await this.userRepository.findOneBy({
      id: userId,
    });

    return userEntity;
  }
}
@Module({
  imports: [TypeOrmModule.forFeature([userEntity])],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
