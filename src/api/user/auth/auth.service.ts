import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RegisterDto, LoginDto, TokenDto } from './auth.dto';
import { AuthHelper } from './auth.helper';
import User from '../user.entity';
import { UserInformationDto } from '@/api/user/dto/user-information.dto';

@Injectable()
export class AuthService {
  @InjectRepository(User)
  private readonly repository: Repository<User>;

  @Inject(AuthHelper)
  private readonly helper: AuthHelper;

  public async register(body: RegisterDto): Promise<UserInformationDto> {
    const { name, email, password }: RegisterDto = body;
    let user: User = await this.repository.findOne({ where: { email } });

    if (user) {
      throw new HttpException('Conflict', HttpStatus.CONFLICT);
    }

    user = new User();

    user.username = name;
    user.email = email;
    user.password = this.helper.encodePassword(password);

    await this.repository.save(user);
    return UserInformationDto.fromEntity(user);
  }

  public async login(body: LoginDto): Promise<TokenDto> {
    const { email, password }: LoginDto = body;
    const user: User = await this.repository.findOne({ where: { email } });

    if (!user) {
      throw new HttpException('No user found', HttpStatus.NOT_FOUND);
    }

    const isPasswordValid: boolean = this.helper.isPasswordValid(
      password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new HttpException('No user found', HttpStatus.NOT_FOUND);
    }

    await this.repository.update(user.id, { last_login_at: new Date() });

    return this.helper.generateToken(user);
  }

  public async refresh(user: User): Promise<TokenDto> {
    await this.repository.update(user.id, { last_login_at: new Date() });

    return this.helper.generateToken(user);
  }
}
