import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Request } from 'express';
import { UpdatePasswordDto } from './dto/update-password.dto';
import User from './user.entity';
import { UpdateNameDto } from './dto/update-name.dto';
import { UserInformationDto } from '@/api/user/dto/user-information.dto';

@Injectable()
export class UserService {
  @InjectRepository(User)
  private readonly repository: Repository<User>;

  public async updateName(
    body: UpdateNameDto,
    req: Request,
  ): Promise<UserInformationDto> {
    const user: User = <User>req.user;
    user.username = body.name;
    await this.repository.save(user);
    return UserInformationDto.fromEntity(user);
  }

  public async updatePassword(
    body: UpdatePasswordDto,
    req: Request,
  ): Promise<UserInformationDto> {
    const user: User = <User>req.user;
    user.password = bcrypt.hashSync(body.password, bcrypt.genSaltSync(10));
    await this.repository.save(user);
    return UserInformationDto.fromEntity(user);
  }

  public async deleteUser(req: Request): Promise<UserInformationDto> {
    const user: User = <User>req.user;
    await this.repository.remove(user);
    return UserInformationDto.fromEntity(user);
  }

  async returnUserIfExist(userId: number): Promise<User> {
    return await this.repository.findOneBy({
      id: userId,
    });
  }

  async getUserItems(userId: number): Promise<number[]> {
    const user = await this.returnUserIfExist(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    return Array.isArray(user.items) ? user.items.map((i) => Number(i)) : [];
  }
}
