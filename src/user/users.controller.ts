import { Controller, Get } from '@nestjs/common';
import { UserService } from './user.service';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FindAllUserDto } from './dto/find-all-user.dto';
import { plainToClass } from 'class-transformer';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly userService: UserService) {}

  @ApiOperation({ summary: 'Return all existing users' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'Return all existing users',
    type: FindAllUserDto,
  })
  @Get('findAll')
  async findAll(): Promise<FindAllUserDto[]> {
    const users = await this.userService.findAll();
    return plainToClass(FindAllUserDto, users);
  }
}
