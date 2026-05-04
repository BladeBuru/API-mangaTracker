# DTO Validation Standards — Manga Tracker API

> Snippet injecté automatiquement quand vous éditez un fichier dans `dto/` ou un `*.dto.ts`.

## Règles obligatoires

- `class-validator` sur **TOUS** les champs.
- `class-transformer` pour les conversions de types.
- `@ApiProperty()` (ou `@ApiPropertyOptional()`) avec `description` et `example` sur chaque champ.
- `UpdateDto` étend toujours `PartialType(CreateDto)`.
- Pas de `any` — typage explicite obligatoire.

## Template

```typescript
import {
  IsString, IsNotEmpty, IsOptional, IsEnum,
  IsNumber, IsUUID, Min, Max, Length
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';

export class CreateMangaDto {
  @ApiProperty({ description: 'ID MangaUpdates', example: 'one-piece' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 255)
  muId: string;

  @ApiPropertyOptional({ description: 'Nombre de chapitres lus', example: 42 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  readChaptersCount?: number;

  @ApiPropertyOptional({ enum: ReadingStatus })
  @IsOptional()
  @IsEnum(ReadingStatus)
  readingStatus?: ReadingStatus;
}

export class UpdateMangaDto extends PartialType(CreateMangaDto) {}

export class SearchMangaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Transform(({ value }) => value?.trim())
  query?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;
}
```

## Décorateurs par type

| Type | Décorateurs |
|------|-------------|
| String | `@IsString()`, `@IsNotEmpty()`, `@Length(min, max)` |
| Number | `@IsNumber()`, `@Min()`, `@Max()`, `@Type(() => Number)` |
| UUID | `@IsUUID()` |
| Enum | `@IsEnum(MyEnum)` |
| Boolean | `@IsBoolean()`, `@Transform(({ value }) => value === 'true')` |
| Date | `@IsDateString()` |
| Array | `@IsArray()`, `@ArrayMinSize()` |
| Objet imbriqué | `@ValidateNested()`, `@Type(() => NestedDto)` |
| Optionnel | `@IsOptional()` (toujours en premier) |

## Sécurité

Le `ValidationPipe` global doit avoir `whitelist: true` + `forbidNonWhitelisted: true`. Tout champ non déclaré dans le DTO sera rejeté en 400 — c'est voulu.
