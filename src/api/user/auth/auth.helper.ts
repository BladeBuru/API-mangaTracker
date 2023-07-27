import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import User from '../user.entity';
import { TokenDto } from '@/api/user/auth/auth.dto';

@Injectable()
export class AuthHelper {
  @InjectRepository(User)
  private readonly repository: Repository<User>;

  private readonly jwt: JwtService;

  constructor(jwt: JwtService) {
    this.jwt = jwt;
  }
  public async decode(token: string): Promise<unknown> {
    return this.jwt.decode(token, null);
  }
  // Get User by User ID we get from decode()
  public async validateUser(decoded: any): Promise<User> {
    return this.repository.findOneBy({ id: decoded.id });
  }

  // Generate JWT Token
  public async generateToken(user: User): Promise<TokenDto> {
    let dto = new TokenDto();
    dto.accessToken = await this.jwt.signAsync(
      {
        id: user.id,
      },
      {
        secret: process.env.JWT_KEY,
        expiresIn: process.env.JWT_KEY_EXPIRES_IN,
      },
    );
    dto.refreshToken = await this.jwt.signAsync(
      {
        id: user.id,
      },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: process.env.JWT_REFRESH_SECRET_EXPIRES_IN,
      },
    );
    return dto;
  }

  // Validate User's password
  public isPasswordValid(password: string, userPassword: string): boolean {
    return bcrypt.compareSync(password, userPassword);
  }

  // Encode User's password
  public encodePassword(password: string): string {
    const salt: string = bcrypt.genSaltSync(10);

    return bcrypt.hashSync(password, salt);
  }
}
