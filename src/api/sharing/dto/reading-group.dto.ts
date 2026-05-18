import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { ReadingGroup } from '../reading-group.entity';

/**
 * Body pour `POST /reading-groups` (Phase 8.3).
 *
 * Le créateur est ajouté implicitement comme membre. La liste d'amis
 * `inviteFriendIds` est **obligatoire** et doit contenir au moins un id —
 * un groupe à un seul membre (le créateur) n'a pas de sens fonctionnel
 * (correction 2026-05-18, après remontée user "création d'un groupe vide").
 */
export class CreateReadingGroupDto {
  @ApiProperty({ description: 'muId du manga partagé', example: 12345 })
  @IsInt()
  muId: number;

  @ApiPropertyOptional({
    description: 'Nom du groupe (libre, ex: "Berserk avec Léa")',
    example: 'Lecture commune Berserk',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiProperty({
    description: 'IDs des amis à inviter dès la création (1 à 10)',
    example: [42, 17],
  })
  @IsArray()
  @IsNotEmpty()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsInt({ each: true })
  inviteFriendIds: number[];
}

export class InviteToGroupDto {
  @ApiProperty({ description: "ID de l'ami à inviter" })
  @IsInt()
  friendId: number;
}

/**
 * Représentation d'un membre du groupe avec sa progression sur le manga.
 * Utilisée par le front pour afficher "Fabien : chap 247/1118" à côté de
 * sa propre progression.
 */
export class ReadingGroupMemberDto {
  @ApiProperty()
  userId: number;

  @ApiProperty()
  username: string;

  @ApiPropertyOptional({ nullable: true })
  displayName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl?: string | null;

  /**
   * Chapitres lus par ce membre. Null si le membre n'a pas le manga dans
   * sa bibliothèque (rejoint le groupe sans encore commencer).
   */
  @ApiPropertyOptional({ nullable: true })
  readChapters?: number | null;

  /**
   * URL de lecture custom (site externe scanlation) que ce membre a
   * configuré pour ce manga. Null si non défini.
   *
   * **2026-05-19** : exposé pour permettre la feature "copier le lien
   * du chapitre d'un ami" — l'app substitue le numéro de chapitre dans
   * cette URL par celui de l'utilisateur courant via
   * `ChapterLinkResolver.buildUrlForChapter`.
   */
  @ApiPropertyOptional({ nullable: true })
  customLink?: string | null;

  @ApiProperty({ description: 'Date à laquelle il a rejoint le groupe (ISO)' })
  joinedAt: string;
}

export class ReadingGroupDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  ownerId: number;

  @ApiProperty()
  mangaMuId: string;

  @ApiProperty()
  mangaTitle: string;

  @ApiPropertyOptional({ nullable: true })
  name?: string | null;

  @ApiProperty({ description: 'ISO timestamp' })
  createdAt: string;

  @ApiProperty({ type: [ReadingGroupMemberDto] })
  members: ReadingGroupMemberDto[];

  static fromEntityWithProgress(
    group: ReadingGroup,
    progressByUser: Record<number, number | null>,
    customLinksByUser: Record<number, string | null> = {},
  ): ReadingGroupDto {
    const dto = new ReadingGroupDto();
    dto.id = group.id;
    dto.ownerId = group.owner.id;
    dto.mangaMuId = group.manga.mu_id;
    dto.mangaTitle = group.manga.title;
    dto.name = group.name ?? null;
    dto.createdAt = group.createdAt.toISOString();
    dto.members = (group.members ?? []).map((m) => {
      const md = new ReadingGroupMemberDto();
      md.userId = m.user.id;
      md.username = m.user.username;
      md.displayName = m.user.displayName ?? null;
      md.avatarUrl = m.user.avatarUrl ?? null;
      md.readChapters = progressByUser[m.user.id] ?? null;
      md.customLink = customLinksByUser[m.user.id] ?? null;
      md.joinedAt = m.joinedAt.toISOString();
      return md;
    });
    return dto;
  }
}
