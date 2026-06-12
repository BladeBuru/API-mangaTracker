import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Request } from 'express';
import { UpdatePasswordDto } from './dto/update-password.dto';
import User, { AuthProvider } from './user.entity';
import { UpdateNameDto } from './dto/update-name.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UserInformationDto } from '@/api/user/dto/user-information.dto';
import { PublicProfileDto } from '@/api/user/dto/public-profile.dto';

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

  /**
   * Change le mot de passe d'un utilisateur connecté APRÈS vérification du
   * mot de passe actuel (parade contre le vol d'access token : un attaquant
   * avec un JWT volé ne peut pas verrouiller le compte).
   *
   * Codes d'erreur (corps `message`, consommés par le client Flutter) :
   *  - 400 `SOCIAL_ACCOUNT_NO_PASSWORD` — compte Google sans mot de passe
   *    local : rien à changer, la connexion passe par Google.
   *  - 400 `CURRENT_PASSWORD_INVALID` — mot de passe actuel incorrect.
   *
   * ⚠️ 400 et PAS 401 pour le mauvais mot de passe : le `HttpService`
   * Flutter intercepte les 401 pour déclencher un refresh token puis un
   * logout forcé — une simple faute de frappe ne doit jamais déconnecter
   * l'utilisateur.
   */
  public async updatePassword(
    body: UpdatePasswordDto,
    req: Request,
  ): Promise<UserInformationDto> {
    const user: User = <User>req.user;

    if (user.authProvider !== AuthProvider.LOCAL || !user.password) {
      throw new BadRequestException('SOCIAL_ACCOUNT_NO_PASSWORD');
    }

    const isCurrentPasswordValid: boolean = bcrypt.compareSync(
      body.currentPassword,
      user.password,
    );
    if (!isCurrentPasswordValid) {
      throw new BadRequestException('CURRENT_PASSWORD_INVALID');
    }

    user.password = bcrypt.hashSync(body.newPassword, bcrypt.genSaltSync(10));
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

  /**
   * Met à jour les champs de profil étendu (Phase 3) : displayName, bio,
   * avatarUrl, dateOfBirth, gender, isProfilePublic.
   *
   * Seuls les champs présents dans le DTO sont écrasés. Pas de remise à
   * null possible via cet endpoint (envoyer une chaîne vide pour vider
   * un champ texte — sinon utiliser un endpoint dédié).
   */
  public async updateProfile(
    body: UpdateProfileDto,
    req: Request,
  ): Promise<UserInformationDto> {
    const user: User = <User>req.user;

    if (body.displayName !== undefined) user.displayName = body.displayName;
    if (body.bio !== undefined) user.bio = body.bio;
    if (body.avatarUrl !== undefined) user.avatarUrl = body.avatarUrl;
    if (body.dateOfBirth !== undefined) {
      // ISO date string → Date pour TypeORM
      user.dateOfBirth = new Date(body.dateOfBirth);
    }
    if (body.gender !== undefined) user.gender = body.gender;
    if (body.isProfilePublic !== undefined) {
      user.isProfilePublic = body.isProfilePublic;
    }

    await this.repository.save(user);
    return UserInformationDto.fromEntity(user);
  }

  /**
   * Profil public d'un autre utilisateur — `GET /user/profile/:id`.
   *
   * Sécurité :
   *  - 404 si l'utilisateur n'existe pas.
   *  - 403 si `isProfilePublic = false` (ne pas révéler l'existence du
   *    compte aux non-autorisés via un 404 vs 403 différentiel, mais pour
   *    MVP, on accepte la distinction — les amis (Phase 6) auront un
   *    accès dédié bypassant ce check).
   */
  public async getPublicProfile(userId: number): Promise<PublicProfileDto> {
    const user = await this.repository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!user.isProfilePublic) {
      throw new ForbiddenException('Ce profil est privé.');
    }
    return PublicProfileDto.fromEntity(user);
  }
}
