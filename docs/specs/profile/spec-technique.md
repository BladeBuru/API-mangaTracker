# Spec Technique — Profile

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | profile             |
| Version       | 0.2.0               |
| Date          | 2026-06-19          |
| Source        | Rétro-ingénierie + sprint change-password |

## Architecture du module

Le module Profile est intégré au module `UserModule` NestJS existant — il ne possède pas de module NestJS séparé. La logique est répartie entre `UserController` (routes HTTP) et `UserService` (accès données). Les champs de profil étendu (`displayName`, `bio`, `avatarUrl`, `dateOfBirth`, `gender`, `isProfilePublic`) sont des colonnes additionnelles sur l'entité `User` partagée avec les modules Auth et RGPD.

```
UserModule
  ├── UserController        (users.controller.ts)
  │     ├── PUT  /user/name
  │     ├── PUT  /user/password
  │     ├── DELETE /user/delete
  │     ├── GET  /user/information
  │     ├── PATCH /user/profile       ← Phase 3
  │     └── GET  /user/profile/:id   ← Phase 3
  ├── UserService           (user.service.ts)
  │     ├── updateName()
  │     ├── updatePassword()
  │     ├── deleteUser()
  │     ├── returnUserIfExist()
  │     ├── updateProfile()           ← Phase 3
  │     └── getPublicProfile()        ← Phase 3
  └── User (entity)         (user.entity.ts)
        └── colonnes profile : displayName, bio, avatarUrl,
                               dateOfBirth, gender, isProfilePublic
```

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/user/user.entity.ts` | Entité TypeORM `User` — inclut toutes les colonnes profil étendu (Phase 3) | ~172 |
| `src/api/user/user.service.ts` | Logique métier profil : updateName, updatePassword, deleteUser, updateProfile, getPublicProfile | ~100 |
| `src/api/user/users.controller.ts` | Routes HTTP — 6 endpoints profil/compte | ~139 |
| `src/api/user/dto/update-profile.dto.ts` | DTO de mise à jour du profil étendu, validation DTO + regex avatar | ~97 |
| `src/api/user/dto/public-profile.dto.ts` | Projection publique de l'entité User (sans données sensibles) | ~42 |
| `src/api/user/dto/user-information.dto.ts` | Projection complète pour l'utilisateur connecté | ~67 |
| `src/api/user/dto/update-name.dto.ts` | DTO changement de username | ~9 |
| `src/api/user/dto/update-password.dto.ts` | DTO changement de mot de passe — `currentPassword` + `newPassword` (8-128 chars, complexité) | ~30 |

## Schéma BDD

Table `user` — colonnes liées au profil (extrait) :

| Colonne | Type PostgreSQL | Nullable | Défaut | Notes |
|---------|----------------|----------|--------|-------|
| `username` | varchar | NON | — | Index unique fonctionnel LOWER(username) — migration 1746231500000 |
| `display_name` | varchar(80) | OUI | null | Nom d'affichage public, fallback sur username |
| `bio` | varchar(500) | OUI | null | Description courte |
| `avatar_url` | text | OUI | null | URL ou data URL base64 — colonne `text` depuis migration 1746231600000 (était varchar(512)) |
| `date_of_birth` | date | OUI | null | RGPD opt-in, jamais exposée publiquement |
| `gender` | varchar(32) | OUI | null | Enum UserGender |
| `is_profile_public` | boolean | NON | false | Privacy-by-default |

### Décisions de schéma notables (non-ADR)

- **avatar_url en `text`** : décision temporaire documentée comme TODO dans le code (migration `1746231600000-ChangeAvatarUrlToText`). L'ancienne colonne `varchar(512)` était trop courte pour les data URLs base64 (~40-80K caractères). Quand l'upload multipart sera câblé (multer + sharp + volume NAS), la colonne restera `text` mais ne stockera plus que des URLs courtes. Documenté en workaround local, pas en ADR (AP-4).

- **Index LOWER(username)** : garantit l'unicité case-insensitive. Voir RETRO-006 pour la justification architecturale.

## API / Endpoints

| Méthode | Route | Description | Auth | Throttle | DTO réponse |
|---------|-------|-------------|------|----------|-------------|
| `GET` | `/user/information` | Infos du compte connecté | JWT | global | `UserInformationDto` |
| `PUT` | `/user/name` | Modifier le username | JWT | global | `UserInformationDto` |
| `PUT` | `/user/password` | Modifier le mot de passe (currentPassword requis) | JWT | 5 req/min | `TokenDto` |
| `DELETE` | `/user/delete` | Supprimer le compte | JWT | global | `UserInformationDto` |
| `PATCH` | `/user/profile` | MAJ profil étendu (partielle) | JWT | global | `UserInformationDto` |
| `GET` | `/user/profile/:id` | Profil public d'un autre user | JWT | global | `PublicProfileDto` |

### Codes HTTP par endpoint

| Endpoint | 200 | 400 | 401 | 403 | 404 |
|----------|-----|-----|-----|-----|-----|
| GET /user/information | OK | — | JWT invalide | — | — |
| PUT /user/name | OK | Validation | JWT invalide | — | — |
| PUT /user/password | `TokenDto` | `CURRENT_PASSWORD_INVALID` / `SOCIAL_ACCOUNT_NO_PASSWORD` / validation DTO | JWT invalide | — | — |
| DELETE /user/delete | OK | — | JWT invalide | — | — |
| PATCH /user/profile | OK | Validation DTO | JWT invalide | — | — |
| GET /user/profile/:id | OK | id non entier | JWT invalide | Profil privé | User inexistant |

### PUT /user/password — comportement durci (sprint change-password)

**DTO `UpdatePasswordDto`** :
- `currentPassword: string` — requis, vérifié via `bcrypt.compare` contre le hash stocké en base
- `newPassword: string` — 8-128 caractères, doit contenir au moins 1 chiffre OU 1 caractère spécial (`@Matches` regex)

**Cas d'erreur 400** :
- `SOCIAL_ACCOUNT_NO_PASSWORD` — le compte a été créé via Google OAuth et n'a pas de mot de passe local (champ `password` null en base). Lever avant même de tenter `bcrypt.compare`.
- `CURRENT_PASSWORD_INVALID` — `bcrypt.compare(currentPassword, user.password)` retourne `false`.

**Comportement post-validation** :
1. Le service `UserService.updatePassword` hash le nouveau mot de passe et met à jour `user.password`.
2. Le controller appelle `AuthService.revokeAllSessionsForUser(userId)` — révocation de **toutes** les sessions actives (table `user_session`), y compris la session courante.
3. Le controller réémet une paire `{ accessToken, refreshToken }` via `AuthService.generateToken` et retourne un `TokenDto` — l'appareil courant est automatiquement re-connecté avec la nouvelle session.

**Throttle** : `@Throttle({ default: { ttl: 60_000, limit: 5 } })` — 5 requêtes par minute par utilisateur (anti-bruteforce du mot de passe actuel).

### Validation DTO — UpdateProfileDto

| Champ | Contraintes | Notes |
|-------|------------|-------|
| `displayName` | `@IsString`, `@Length(1, 80)`, optionnel | — |
| `bio` | `@IsString`, `@MaxLength(500)`, optionnel | — |
| `avatarUrl` | `@IsString`, `@MaxLength(200_000)`, `@Matches(regex)`, optionnel | Regex : URL http(s) OU data URL image/(jpeg|png|webp) base64 |
| `dateOfBirth` | `@IsDateString`, optionnel | Converti en `Date` par le service |
| `gender` | `@IsEnum(UserGender)`, optionnel | Valeurs : male, female, non_binary, prefer_not_to_say |
| `isProfilePublic` | `@IsBoolean`, optionnel | — |

## Patterns identifiés

- **DTO projection statique** : `UserInformationDto.fromEntity(user)` et `PublicProfileDto.fromEntity(user)` sont des méthodes statiques de mapping entité → DTO. Pas de mapper externe — la logique de projection est dans le DTO lui-même.
- **Partial update par guard `undefined`** : `updateProfile()` ne teste pas les champs avec `Object.assign` ou spread, mais avec `if (body.field !== undefined)`. Pattern cohérent avec `PartialType` mais implémenté manuellement.
- **User depuis req.user** : le service reçoit `Request` et cast `req.user` en `User`. Le guard JWT (Passport) a préalablement chargé et attaché l'entité User complète à la requête — pas de findById dans les services de mise à jour.
- **ClassSerializerInterceptor** : appliqué sur tous les endpoints pour assurer la sérialisation via `class-transformer`.

## Dépendances inter-modules

| Module | Nature de la dépendance |
|--------|------------------------|
| `AuthModule` / `JwtAuthGuard` | Guard JWT requis sur tous les endpoints |
| `FriendsModule` | Dépend de la convention `ILike` pour les lookups username (RETRO-006) |
| `GdprModule` | Utilise les champs `dateOfBirth`, `gender`, `displayName` dans l'export RGPD |
| `StatsModule` | Potentiellement utilise les champs profil pour les stats démographiques agrégées |

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| `src/api/user/user.service.spec.ts` | Instanciation du service uniquement (`should be defined`) | Existant mais squelette vide |

Pas de test unitaire sur `updateProfile`, `getPublicProfile`, `updateName`, `updatePassword`, `deleteUser`. Pas de test e2e sur les endpoints `/user/profile`.
