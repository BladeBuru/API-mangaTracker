import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import User from '../user.entity';

export class UserInformationDto {
  @ApiProperty()
  email: string;

  @ApiProperty()
  username: string;

  /**
   * `true` si l'utilisateur a cliqué sur le lien de vérification reçu
   * par mail. Utilisé côté client pour afficher un banner « Vérifiez
   * votre email » et bloquer certaines actions sensibles.
   */
  @ApiPropertyOptional({
    description:
      "Indique si l'email de l'utilisateur a été vérifié via le magic link",
  })
  emailVerified?: boolean;

  static fromEntity(user: User): UserInformationDto {
    const userInformationDto = new UserInformationDto();
    userInformationDto.username = user.username;
    userInformationDto.email = user.email;
    userInformationDto.emailVerified = user.emailVerifiedAt !== null;
    return userInformationDto;
  }
}
