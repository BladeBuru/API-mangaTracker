import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { UpdateNameDto, UpdatePasswordDto } from './user.dto';
import userEntity from './user.entity';
import User from './user.entity';

@Injectable()
export class UserService {
  @InjectRepository(User)
  private readonly repository: Repository<User>;

  public async updateName(body: UpdateNameDto, req: Request): Promise<User> {
    const user: User = <User>req.user;

    user.username = body.name;

    return this.repository.save(user);
  }

  public async updatePassword(
    body: UpdatePasswordDto,
    req: Request,
  ): Promise<User> {
    const user: User = <User>req.user;
    user.password = body.password;
    return this.repository.save(user);
  }

  public async deleteUser(id: string, req: Request): Promise<User> {
    const user: User = <User>req.user;
    return this.repository.remove(user);
  }
  async returnUserIfExist(userId: number): Promise<userEntity> {
    const userEntity = await this.repository.findOneBy({
      id: userId,
    });

    return userEntity;
  }
}
