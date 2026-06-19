# Spec Technique — Sharing

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | sharing             |
| Version       | 0.2.0               |
| Date          | 2026-06-19          |
| Source        | Rétro-ingénierie + sprint RGPD username |

---

## Architecture du module

Le module `sharing` est structuré en deux sous-domaines distincts, chacun avec son propre service et controller :

```
SharingModule
├── SharingController        (/sharing)
│   └── SharingService
│       ├── Repository<MangaShare>
│       ├── Repository<Manga>
│       └── Repository<UserFriendship>
├── ReadingGroupsController  (/reading-groups)
│   └── ReadingGroupsService
│       ├── Repository<ReadingGroup>
│       ├── Repository<ReadingGroupMember>
│       ├── Repository<Manga>
│       ├── Repository<UserManga>
│       └── Repository<UserFriendship>
```

Les deux services sont exportés depuis `SharingModule`, ce qui permet à d'autres modules d'éventuellement les consommer.

La dépendance sur `UserFriendship` est directe (import de l'entité depuis `src/api/friends/`) — aucun service `FriendsService` n'est injecté. La logique de vérification d'amitié est réimplémentée localement dans `filterAcceptedFriendIds` (méthode privée de `ReadingGroupsService`) et dans `shareWithFriends` (`SharingService`).

---

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/sharing/sharing.module.ts` | Déclaration du module NestJS, imports TypeORM | ~35 |
| `src/api/sharing/sharing.controller.ts` | Endpoints POST/GET du partage de manga | ~69 |
| `src/api/sharing/sharing.service.ts` | Logique métier partage : validation amitié, idempotence, inbox | ~147 |
| `src/api/sharing/reading-groups.controller.ts` | Endpoints POST/GET/DELETE des groupes de lecture | ~109 |
| `src/api/sharing/reading-groups.service.ts` | Logique métier groupes : création, invitation, progression, ownership | ~397 |
| `src/api/sharing/manga-share.entity.ts` | Entité TypeORM `manga_share` | ~48 |
| `src/api/sharing/reading-group.entity.ts` | Entités TypeORM `reading_group` + `reading_group_member` | ~69 |
| `src/api/sharing/dto/share.dto.ts` | DTO entrée/sortie partage manga — `stripEmailFormat` sur `senderUsername` dans `fromEntity` | ~78 |
| `src/api/sharing/dto/reading-group.dto.ts` | DTO entrée/sortie groupes de lecture — `stripEmailFormat` sur `username` et `displayName` des membres dans `fromEntity` | ~148 |

---

## Schéma BDD

### Table `manga_share`

| Colonne | Type | Contraintes |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `sender_id` | INTEGER | FK → `user.id` ON DELETE CASCADE, NOT NULL |
| `addressee_id` | INTEGER | FK → `user.id` ON DELETE CASCADE, NOT NULL |
| `manga_id` | VARCHAR | FK → `manga.mu_id` ON DELETE CASCADE, NOT NULL |
| `message` | VARCHAR(280) | nullable, default null |
| `createdAt` | TIMESTAMP | auto-généré |
| `seenAt` | TIMESTAMP | nullable, default null |

Index : `(addressee_id, seenAt)` — composite pour accélérer les requêtes "shares non-vus pour un utilisateur".

### Table `reading_group`

| Colonne | Type | Contraintes |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `owner_id` | INTEGER | FK → `user.id` ON DELETE CASCADE, NOT NULL |
| `manga_id` | VARCHAR | FK → `manga.mu_id` ON DELETE CASCADE, NOT NULL |
| `name` | VARCHAR(80) | nullable |
| `createdAt` | TIMESTAMP | auto-généré |

### Table `reading_group_member`

| Colonne | Type | Contraintes |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `group_id` | INTEGER | FK → `reading_group.id` ON DELETE CASCADE, NOT NULL |
| `user_id` | INTEGER | FK → `user.id` ON DELETE CASCADE, NOT NULL |
| `joinedAt` | TIMESTAMP | auto-généré |

Contrainte unique : `UQ_reading_group_member_group_user` sur `(group_id, user_id)` — empêche les doublons d'invitation.

### Relations avec d'autres tables

- `manga_share.manga_id` référence `manga.mu_id` (clé non-PK).
- `reading_group.manga_id` référence `manga.mu_id` (clé non-PK).
- La progression est lue en lecture depuis `user_manga.user_read_chapters` et `user_manga.custom_link` — aucune colonne de progression n'est stockée dans `reading_group_member`.

---

## API / Endpoints

### SharingController — `/sharing`

| Méthode | Route | Description | Auth | Throttle |
|---------|-------|-------------|------|----------|
| `POST` | `/sharing/manga/:muId` | Partager un manga avec des amis | JWT | 30/min |
| `GET` | `/sharing/inbox` | Inbox des shares reçus (max 100, tri desc) | JWT | global |
| `POST` | `/sharing/inbox/mark-seen` | Marquer tous les shares comme vus | JWT | global |
| `GET` | `/sharing/inbox/unseen-count` | Compteur shares non-vus (badge) | JWT | global |

### ReadingGroupsController — `/reading-groups`

| Méthode | Route | Description | Auth | Throttle |
|---------|-------|-------------|------|----------|
| `POST` | `/reading-groups` | Créer un groupe de lecture | JWT | 10/min |
| `GET` | `/reading-groups` | Lister mes groupes | JWT | global |
| `GET` | `/reading-groups/:id` | Détail d'un groupe avec progression | JWT | global |
| `POST` | `/reading-groups/:id/invite` | Inviter un ami (owner uniquement) | JWT | 10/min |
| `DELETE` | `/reading-groups/:id/leave` | Quitter le groupe | JWT | global |
| `DELETE` | `/reading-groups/:id` | Supprimer le groupe (owner uniquement) | JWT | global |

---

## Patterns identifiés

- **Defense-in-depth RGPD — `stripEmailFormat` sur les DTOs de sortie** : `MangaShareDto.fromEntity` et `ReadingGroupMemberDto.fromEntity` passent systématiquement les champs `username` et `displayName` par `stripEmailFormat(username.helper.ts)` avant de les exposer. Cette couche de protection complémentaire garantit qu'aucun username au format email (`user@domain.com`) n'est exposé dans les réponses API du module sharing, même si la migration `SanitizeEmailUsernames` n'a pas encore traité un compte donné. Cohérent avec le pattern appliqué dans `comments` et `friends` (même sprint RGPD).
- **Service layer strict** : aucune logique métier dans les controllers. Les controllers délèguent intégralement aux services correspondants.
- **Repository pattern via TypeORM** : tous les accès BDD passent par des `Repository<T>` injectés.
- **Idempotence côté service** : `SharingService.shareWithFriends` et `ReadingGroupsService.createGroup` implémentent chacun leur propre logique d'idempotence sans compter sur des contraintes BDD uniques (à l'exception de `UQ_reading_group_member_group_user`).
- **Compute-on-read pour la progression** : `ReadingGroupsService.fetchProgressForGroup` lit `user_manga` à la volée à chaque appel — la progression n'est jamais matérialisée dans `reading_group_member`. Cohérent avec le pattern `RETRO-009` (bibliothèque dual read-tracking).
- **Méthode privée de filtrage partagée** : `filterAcceptedFriendIds` est une méthode privée de `ReadingGroupsService` qui duplique partiellement la logique de vérification d'amitié de `SharingService`. Les deux services importent directement `UserFriendship` au lieu d'injecter `FriendsService`.
- **QueryBuilder raw pour Postgres** : `fetchProgressForGroup` utilise `createQueryBuilder` avec des alias lowercase explicites pour contourner le comportement Postgres qui lowercaseifie les alias non-quotés (`AS userId` → `userid`). Commenté dans le code.
- **Ownership transfer** : lors du départ de l'owner d'un groupe, le service transfère l'ownership au membre avec la date `joinedAt` la plus ancienne parmi les membres restants (algo `Array.reduce`).

---

## Décisions techniques documentées ici (non-ADR)

### Synchronisation par polling client (30 secondes) — pas de websockets

La synchronisation de la progression dans un groupe de lecture repose sur un poll client côté Flutter toutes les 30 secondes vers `GET /reading-groups/:id`. Il n'y a aucun mécanisme serveur (websocket, SSE, long-polling) pour notifier les membres en temps réel.

**Raison documentée dans le code** : choix délibéré pour le MVP. Le commentaire dans `reading-group.entity.ts` et `reading-groups.service.ts` mentionne explicitement "websockets envisagés si la latence devient un problème (pas pour l'instant)".

**Impact** : la latence visible entre la progression d'un membre et l'affichage chez les autres est d'au maximum 30 secondes. Pour un usage de lecture de manga (progression lente, pas de jeu en temps réel), cette latence est acceptable.

**Candidat ADR rejeté** : Q3=NON (impact confiné au seul module `sharing`). Documenté ici plutôt qu'en ADR.

### Vérification d'amitié réimplémentée localement

Les deux services (`SharingService` et `ReadingGroupsService`) implémentent leur propre requête de vérification d'amitié sur `UserFriendship` au lieu d'injecter `FriendsService`. Ce choix évite une dépendance circulaire entre modules mais crée une duplication logique.

### Absence d'endpoint PATCH pour les groupes

Il n'y a pas d'endpoint pour renommer un groupe après sa création. Le `name` est optionnel à la création et immuable ensuite.

### Limite inbox à 100 entrées

`SharingService.listInbox` applique un `take: 100` sans pagination. Pour le MVP, cette limite est suffisante.

---

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| — | Partage de manga (SharingService) | Absent |
| — | Groupes de lecture (ReadingGroupsService) | Absent |
| — | Endpoints (SharingController, ReadingGroupsController) | Absent |

Aucun fichier `*.spec.ts` n'a été trouvé dans `src/api/sharing/`. Les deux services et leurs controllers ne sont pas couverts par des tests automatisés.
