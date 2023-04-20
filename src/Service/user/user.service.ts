import { Injectable, Module } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import userEntity from '../../Entity/user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(userEntity)
    private readonly userRepository: Repository<userEntity>,
  ) {}

  async findAll(): Promise<userEntity[]> {
    return await this.userRepository.find();
  }
}
@Module({
  imports: [TypeOrmModule.forFeature([userEntity])],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
