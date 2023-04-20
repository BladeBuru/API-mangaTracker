import { Controller, Get } from '@nestjs/common';
import User from '../../Entity/user.entity';
import { UserService } from '../../Service/user/user.service';

@Controller('users')
export class UsersController {
  constructor(private readonly userService: UserService) {}

  @Get('findAll')
  async findAll(): Promise<User[]> {
    return await this.userService.findAll();
  }
}
