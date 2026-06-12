# Spec Technique — gdpr

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | gdpr                |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

## Architecture du module

Le module GDPR est un module NestJS autonome (`GdprModule`) découplé du `UserModule`. Il injecte directement les repositories TypeORM des trois entités dont il a besoin (`User`, `UserManga`, `UserSession`) via `TypeOrmModule.forFeature([...])`. Le module exporte `GdprService` pour permettre son utilisation éventuelle par d'autres modules (ex : vérification du consentement au login dans `AuthModule`).

Le `GdprController` délègue intégralement au `GdprService` ; la seule logique dans le controller est la construction des headers HTTP pour le téléchargement de l'export (`Content-Type` + `Content-Disposition`), ce qui justifie l'utilisation de `@Res()` Express natif sur cet endpoint.

Le `GdprService` est sans état. Deux constantes exportées (`CURRENT_TOS_VERSION`, `CURRENT_PRIVACY_VERSION`) définissent les versions courantes des documents légaux — leur mise à jour dans ce fichier est le seul mécanisme de déclenchement du re-consentement.

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/user/gdpr/gdpr.service.ts` | Logique métier RGPD : résumé, export, consentement, vérification refresh | ~223 |
| `src/api/user/gdpr/gdpr.controller.ts` | 5 endpoints HTTP RGPD, DTO `RecordConsentDto` inline | ~131 |
| `src/api/user/gdpr/gdpr.module.ts` | Déclaration du module, injection des repositories | ~23 |
| `src/api/user/user.entity.ts` | Colonnes RGPD : `acceptedTosAt`, `acceptedTosVersion`, `acceptedPrivacyAt`, `acceptedPrivacyVersion` | ~173 |
| `src/api/mangas/user-manga.entity.ts` | `onDelete: 'CASCADE'` sur la relation `ManyToOne → User` | ~44 |
| `src/api/user/auth/user-session.entity.ts` | `onDelete: 'CASCADE'` sur la relation `ManyToOne → User` | ~30 |
| `src/api/user/users.controller.ts` | `DELETE /user/delete` (article 17, hors module GDPR) | — |
| `src/api/user/user.service.ts` | `deleteUser()` — suppression via `repository.remove()` | — |

## Schéma BDD

### Table `user` — colonnes RGPD

| Colonne | Type | Nullable | Valeur par défaut | Rôle |
|---------|------|----------|-------------------|------|
| `accepted_tos_at` | `timestamp` | oui | `null` | Preuve légale de l'acceptation des CGU |
| `accepted_tos_version` | `varchar(16)` | oui | `null` | Version des CGU acceptées |
| `accepted_privacy_at` | `timestamp` | oui | `null` | Preuve légale de l'acceptation de la Privacy Policy |
| `accepted_privacy_version` | `varchar(16)` | oui | `null` | Version de la Privacy Policy acceptée |

### Contraintes de cascade

| Table dépendante | Relation | onDelete |
|------------------|----------|----------|
| `user_manga` | `ManyToOne → User` | `CASCADE` |
| `user_session` | `ManyToOne → User` | `CASCADE` |

La suppression d'un `User` déclenche automatiquement la suppression de toutes ses entrées `user_manga` et `user_session` au niveau base de données.

## API / Endpoints

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| `GET` | `/user/gdpr/summary` | Article 15 — résumé des données (compte + compteurs) | JWT requis |
| `GET` | `/user/gdpr/export` | Article 20 — export JSON portable téléchargeable | JWT requis |
| `GET` | `/user/gdpr/consent-status` | Vérification re-consentement nécessaire | JWT requis |
| `POST` | `/user/gdpr/consent` | Enregistrement du consentement CGU + Privacy | JWT requis |
| `GET` | `/user/gdpr/legal-versions` | Versions courantes des documents légaux | Public |
| `DELETE` | `/user/delete` | Article 17 — suppression de compte (cascade DB) | JWT requis (hors module) |

### DTO inline

`RecordConsentDto` est déclaré directement dans `gdpr.controller.ts` (pas de fichier `dto/` dédié) :
- `tosVersion: string` — `@IsString()` + `@IsNotEmpty()`
- `privacyVersion: string` — `@IsString()` + `@IsNotEmpty()`

### Format GdprExport (interface TypeScript)

```typescript
interface GdprExport {
  exportedAt: string;          // ISO 8601
  schemaVersion: '1';          // version du format d'export
  account: { ... };            // données compte sans password/googleId
  library: Array<{ ... }>;     // entrées bibliothèque avec titre manga
  sessions: Array<{ ... }>;    // sessions (id, createdAt, deviceInfo, isActive)
}
```

## Patterns identifiés

- **Module isolé** : `GdprModule` injecte ses propres repositories plutôt que d'importer `UserModule` — délibéré pour l'auditabilité RGPD.
- **Exclusion explicite au runtime** : `delete (account as any).password` et `delete (account as any).googleId` dans `getDataSummary()` — les champs sensibles sont supprimés de l'objet JS avant retour. Utilise un cast `any` pour contourner TypeScript strict (zone de fragilité si l'entité change).
- **Constantes exportées** : `CURRENT_TOS_VERSION` et `CURRENT_PRIVACY_VERSION` dans `gdpr.service.ts` sont les seuls points de contrôle du versioning. Les modifier sans migration des utilisateurs existants provoque un re-consentement global.
- **Réponse HTTP native pour l'export** : `@Res() res: Response` contourne le serializer NestJS pour poser les headers `Content-Disposition`. Le retour est `void` et la réponse est envoyée manuellement via `res.send()`.
- **needsConsentRefresh synchrone** : la méthode est synchrone (pas async) car elle opère uniquement sur l'objet `User` déjà chargé — pas de requête DB supplémentaire.

## Configuration notable

- La constante `CURRENT_TOS_VERSION = '1.0'` est le pivot du système de re-consentement. Un dev qui l'incrémente sans le savoir déclenche une vague de re-consentement pour tous les utilisateurs.
- Le champ `GdprExport.sessions[].isActive` lit `s.isActive` avec un fallback `false`, mais l'entité `UserSession` ne déclare pas de colonne `isActive`. La valeur sera toujours `false` — incohérence entre l'interface et l'entité.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|----------------|--------|
| — | Aucun fichier de test trouvé pour le module GDPR | Absent |
