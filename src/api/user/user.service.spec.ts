import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Request } from 'express';
import { UserService } from './user.service';
import User, { AuthProvider } from './user.entity';
import { UpdatePasswordDto } from './dto/update-password.dto';

describe('UserService', () => {
  let service: UserService;
  let saveMock: jest.Mock;

  const buildUser = (overrides: Partial<User> = {}): User => {
    const user = new User();
    user.id = 1;
    user.username = 'john';
    user.email = 'john@example.com';
    user.authProvider = AuthProvider.LOCAL;
    user.password = bcrypt.hashSync('OldPassword1!', bcrypt.genSaltSync(10));
    user.emailVerifiedAt = null;
    user.displayName = null;
    user.bio = null;
    user.avatarUrl = null;
    user.dateOfBirth = null;
    user.gender = null;
    user.isProfilePublic = false;
    return Object.assign(user, overrides);
  };

  const buildRequest = (user: User): Request =>
    ({ user } as unknown as Request);

  beforeEach(async () => {
    saveMock = jest.fn().mockImplementation((entity: User) => entity);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
            save: saveMock,
          },
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('updatePassword', () => {
    const dto = (
      currentPassword: string,
      newPassword = 'NewPassword1!',
    ): UpdatePasswordDto => ({ currentPassword, newPassword });

    it('should throw a 400 when the current password is wrong', async () => {
      const user = buildUser();

      await expect(
        service.updatePassword(dto('WrongPassword1!'), buildRequest(user)),
      ).rejects.toThrow(new BadRequestException('CURRENT_PASSWORD_INVALID'));
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('should throw a 400 for a Google account without local password', async () => {
      const user = buildUser({
        authProvider: AuthProvider.GOOGLE,
        password: null,
      });

      await expect(
        service.updatePassword(dto('whatever'), buildRequest(user)),
      ).rejects.toThrow(new BadRequestException('SOCIAL_ACCOUNT_NO_PASSWORD'));
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('should hash and save the new password when the current one is valid', async () => {
      const user = buildUser();

      const result = await service.updatePassword(
        dto('OldPassword1!'),
        buildRequest(user),
      );

      expect(saveMock).toHaveBeenCalledTimes(1);
      // Jamais stocké en clair, et le hash correspond bien au nouveau mdp.
      expect(user.password).not.toBe('NewPassword1!');
      expect(bcrypt.compareSync('NewPassword1!', user.password)).toBe(true);
      expect(result.id).toBe(1);
    });
  });
});
