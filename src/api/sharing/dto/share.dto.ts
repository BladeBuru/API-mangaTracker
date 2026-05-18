import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { MangaShare } from '../manga-share.entity';

export class ShareMangaDto {
  @ApiProperty({
    description: "IDs des amis à qui partager (max 20)",
    example: [42, 17],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  friendIds: number[];

  @ApiPropertyOptional({
    description: 'Message libre (280 chars max)',
    example: 'Tu vas adorer celui-là',
  })
  @IsOptional()
  @IsString()
  @Length(1, 280)
  message?: string;
}

export class MangaShareDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  senderId: number;

  @ApiProperty()
  senderUsername: string;

  @ApiPropertyOptional({ nullable: true })
  senderAvatarUrl?: string | null;

  @ApiProperty()
  mangaMuId: string;

  @ApiProperty()
  mangaTitle: string;

  @ApiPropertyOptional({ nullable: true })
  message?: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional({ nullable: true })
  seenAt?: string | null;

  static fromEntity(share: MangaShare): MangaShareDto {
    const dto = new MangaShareDto();
    dto.id = share.id;
    dto.senderId = share.sender.id;
    dto.senderUsername = share.sender.username;
    dto.senderAvatarUrl = share.sender.avatarUrl ?? null;
    dto.mangaMuId = share.manga.mu_id;
    dto.mangaTitle = share.manga.title;
    dto.message = share.message ?? null;
    dto.createdAt = share.createdAt.toISOString();
    dto.seenAt = share.seenAt?.toISOString() ?? null;
    return dto;
  }
}
