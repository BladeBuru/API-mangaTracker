import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import User from '@/api/user/user.entity';

@Injectable()
export class RefreshTokenGuard extends AuthGuard('jwt-refresh') {
  public handleRequest(err: unknown, user: User): any {
    return user;
  }
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.NODE_ENV === 'development') return true;

    await super.canActivate(context);

    const { user }: Request = context.switchToHttp().getRequest();

    return !!user;
  }
}
