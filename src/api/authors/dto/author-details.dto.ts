import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Une œuvre de l'auteur, enrichie par le catalogue local quand il la connaît. */
export class AuthorWorkDto {
  @ApiProperty({ example: 55099564912 })
  muId: number;

  @ApiProperty({ example: 'One Piece' })
  title: string;

  @ApiPropertyOptional({ example: 1997, nullable: true })
  year: number | null;

  @ApiPropertyOptional({ nullable: true })
  mediumCoverUrl: string | null;

  @ApiPropertyOptional({ example: 8.9, nullable: true })
  rating: number | null;

  @ApiPropertyOptional({ example: 'Manga', nullable: true })
  type: string | null;

  @ApiProperty({ type: [String] })
  genres: string[];
}

/** `GET /authors/:authorId` — fiche auteur (mini bio) et ses œuvres. */
export class AuthorDetailsDto {
  @ApiProperty({ example: 30768624283 })
  id: number;

  @ApiProperty({ example: 'ODA Eiichiro' })
  name: string;

  @ApiPropertyOptional({ nullable: true })
  actualName: string | null;

  @ApiProperty({ type: [String] })
  associatedNames: string[];

  @ApiPropertyOptional({ nullable: true })
  imageUrl: string | null;

  @ApiPropertyOptional({
    description: 'Mini biographie (texte brut, tronquée)',
    nullable: true,
  })
  bio: string | null;

  @ApiPropertyOptional({ nullable: true })
  birthday: string | null;

  @ApiPropertyOptional({ nullable: true })
  birthplace: string | null;

  @ApiProperty({ type: [String], description: 'Genres principaux' })
  genres: string[];

  @ApiPropertyOptional({ nullable: true })
  officialSite: string | null;

  @ApiProperty({ type: [AuthorWorkDto] })
  works: AuthorWorkDto[];

  @ApiProperty({
    description:
      "false si la liste des œuvres n'a pas pu être chargée (fiche partielle)",
  })
  worksComplete: boolean;
}
