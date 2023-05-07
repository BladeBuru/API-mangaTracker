import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';
import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class FindAllUserDto {
  @ApiProperty()
  @Expose()
  @IsString()
  username: string;

  @ApiProperty()
  @Expose()
  @IsEmail()
  email: string;
}
