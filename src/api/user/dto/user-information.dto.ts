import { ApiProperty } from '@nestjs/swagger';
import User from '../user.entity';

export class UserInformationDto {
  @ApiProperty()
  email: string;

  @ApiProperty()
  username: string;

  static fromEntity(user: User): UserInformationDto {
    const userInformationDto = new UserInformationDto();
    userInformationDto.username = user.username;
    userInformationDto.email = user.email;
    return userInformationDto;
  }
}
