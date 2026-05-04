# NestJS Controller Standards — Manga Tracker API

> Snippet injecté automatiquement quand vous éditez un fichier `*.controller.ts`.

## Endpoints standards

| Verbe    | Route       | Usage                                      |
|----------|-------------|--------------------------------------------|
| `GET`    | `/`         | Liste paginée (avec QueryDTO)              |
| `GET`    | `/:id`      | Récupération par ID (avec contrôle accès)  |
| `POST`   | `/`         | Création avec validation DTO               |
| `PATCH`  | `/:id`      | Mise à jour partielle                      |
| `DELETE` | `/:id`      | Suppression                                |

## Template controller

```typescript
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('example')
@ApiBearerAuth()
@Controller('example')
@UseGuards(AuthGuard('jwt'))
export class ExampleController {
  constructor(private readonly exampleService: ExampleService) {}

  @ApiOperation({ summary: 'Get all items' })
  @ApiResponse({ status: 200, description: 'Items retrieved' })
  @Get()
  findAll(@Query() dto: SearchExampleDto, @Request() req) {
    return this.exampleService.findAll(dto, req.user.userId);
  }

  @ApiOperation({ summary: 'Get item by ID' })
  @ApiResponse({ status: 200, description: 'Item found' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  @Get(':id')
  findOne(@Param('id') id: string, @Request() req) {
    return this.exampleService.findOne(id, req.user.userId);
  }

  @ApiOperation({ summary: 'Create item' })
  @ApiResponse({ status: 201, description: 'Item created' })
  @Post()
  create(@Body() dto: CreateExampleDto, @Request() req) {
    return this.exampleService.create(dto, req.user.userId);
  }

  @ApiOperation({ summary: 'Update item' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateExampleDto) {
    return this.exampleService.update(id, dto);
  }

  @ApiOperation({ summary: 'Delete item' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.exampleService.remove(id);
  }
}
```

## Règles strictes

- MAX **200 lignes** par controller (sinon découpage obligatoire — voir skill `refactor-large-file`).
- **JAMAIS** de logique métier — uniquement appels services.
- **TOUJOURS** `@UseGuards(AuthGuard('jwt'))` sur les routes privées.
- **TOUJOURS** `@ApiTags()`, `@ApiOperation()`, `@ApiResponse()` pour Swagger.
- Passer `req.user.userId` au service (jamais le traiter dans le controller).
- Utiliser `@GetUser()` de `shared/Decorator/user.decorator.ts` si disponible.
- Auth-sensitive endpoints (`/auth/login`, `/auth/register`, `/auth/refresh`) doivent avoir un `@Throttle()` explicite renforcé en plus du throttler global.
