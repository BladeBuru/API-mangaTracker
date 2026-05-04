# TypeORM Configuration

> Snippet injecté automatiquement quand vous éditez `typeorm.service.ts` ou un `data-source*.ts`.

## Règles non-négociables

- ❌ **JAMAIS** `synchronize: true` en production. Cela auto-synchronise le schéma au démarrage et peut perdre des données.
- ✅ La valeur de `synchronize` doit être pilotée par l'environnement :
  ```typescript
  synchronize: process.env.NODE_ENV !== 'production' && process.env.TYPEORM_SYNC === 'true'
  ```
  ou simplement `false` par défaut, avec un script explicite pour le dev.
- ✅ **Migrations obligatoires** dès qu'on touche à un schéma. Le dossier `migrations/` doit exister, être versionné, et contenir un fichier par changement.
- ✅ La configuration doit pointer `migrations: ['dist/migrations/*.js']` et `migrationsRun: true` (ou run manuel via script CI).
- ✅ `logging` désactivé ou réduit à `['error', 'warn']` en production.
- ✅ `ssl: { rejectUnauthorized: true }` en prod si la DB est distante.

## Template recommandé

```typescript
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const typeOrmConfig = (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
  migrationsRun: process.env.NODE_ENV === 'production',
  synchronize: false, // JAMAIS true en prod
  logging: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : 'all',
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: true }
      : false,
});
```

## Scripts package.json

```json
{
  "scripts": {
    "migration:generate": "typeorm-ts-node-commonjs migration:generate -d src/data-source.ts",
    "migration:run": "typeorm-ts-node-commonjs migration:run -d src/data-source.ts",
    "migration:revert": "typeorm-ts-node-commonjs migration:revert -d src/data-source.ts"
  }
}
```

## Vérification

Avant de modifier une entité :
1. Décider si c'est un changement de schéma (oui dans 90% des cas).
2. Générer la migration : `npm run migration:generate -- src/migrations/Description`.
3. Vérifier la migration générée (vraiment ce qu'on veut ?).
4. Commit migration + entité ensemble.
