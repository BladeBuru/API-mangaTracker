# Spec Technique — friends

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | friends             |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

## Architecture du module

Le module suit l'architecture NestJS standard : un `FriendsController` délègue intégralement à `FriendsService`. Aucune logique métier dans le controller.

Le service gère deux repositories TypeORM : `UserFriendship` (la table principale) et `User` (pour la résolution username→entité et la constitution des DTOs de résultat de recherche).

La relation d'amitié est modélisée comme **directionnelle en base** (`requester → addressee`) mais **traitée comme bidirectionnelle en application** : toutes les requêtes de lecture (`listAccepted`, `searchUsers`, la détection de doublons) interrogent les deux colonnes `requester_id` et `addressee_id`. La sémantique de direction est portée par le champ `direction` du `FriendshipDto` côté lecture.

Le module exporte `FriendsService`, ce qui permet à d'autres modules NestJS d'importer `FriendsModule` pour consommer le service. En pratique, `SharingModule` préfère injecter directement le repository `UserFriendship` plutôt que d'importer le service (couplage de données, non de service).

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/friends/friends.controller.ts` | Routes HTTP, throttle, guards JWT, mappage user decorator | ~99 |
| `src/api/friends/friends.service.ts` | Logique métier complète : envoi, acceptation, blocage, suppression, liste, recherche | ~242 |
| `src/api/friends/user-friendship.entity.ts` | Entité TypeORM `user_friendship`, enum `FriendshipStatus`, contraintes | ~65 |
| `src/api/friends/dto/friend.dto.ts` | DTOs d'entrée/sortie + méthodes `fromEntity` statiques | ~116 |
| `src/api/friends/friends.module.ts` | Déclaration NestJS du module, exports | ~18 |
| `src/migrations/1746231200000-CreateUserFriendship.ts` | Migration Phase 6 : création table `user_friendship` | ~88 |

## Schéma BDD

### Table `user_friendship`

| Colonne | Type | Contrainte | Notes |
|---------|------|------------|-------|
| `id` | `int` PK | auto-increment | — |
| `requester_id` | `int` | FK → `user.id` ON DELETE CASCADE, NOT NULL | Initiateur de la demande |
| `addressee_id` | `int` | FK → `user.id` ON DELETE CASCADE, NOT NULL | Destinataire de la demande |
| `status` | `varchar(16)` | DEFAULT `'pending'`, NOT NULL | Enum : `pending`, `accepted`, `blocked` |
| `createdAt` | `timestamp` | DEFAULT CURRENT_TIMESTAMP | Horodatage création |
| `acceptedAt` | `timestamp` | NULLABLE | Null tant que non accepté |

**Contraintes :**
- `UQ_friendship_requester_addressee` sur `(requester_id, addressee_id)` — empêche les doublons directs (mais pas la relation inverse `(b, a)`, gérée par le service).

**Index :**
- `IDX_friendship_addressee_status` sur `(addressee_id, status)` — optimise `listPendingReceived` et `listAccepted` côté addressee.
- `IDX_friendship_requester_status` sur `(requester_id, status)` — optimise `listAccepted` côté requester.

**Suppression en cascade** : si un `User` est supprimé, toutes ses `user_friendship` (requester ou addressee) sont supprimées automatiquement par la FK avec `ON DELETE CASCADE`.

## API / Endpoints

| Méthode | Route | Description | Auth | Throttle |
|---------|-------|-------------|------|----------|
| `POST` | `/friends/request` | Envoyer une demande d'amitié | JWT | 5 req/min (renforcé) |
| `GET` | `/friends` | Lister les amis acceptés | JWT | global |
| `GET` | `/friends/pending` | Lister les demandes reçues en attente | JWT | global |
| `GET` | `/friends/search?q=` | Recherche d'utilisateurs pour autocomplete | JWT | global |
| `PATCH` | `/friends/:id` | Accepter / rejeter / bloquer (addressee uniquement) | JWT | global |
| `DELETE` | `/friends/:id` | Supprimer une relation (les deux parties) | JWT | global |

### DTOs

**`SendFriendRequestDto`** (body `POST /friends/request`)
- `addresseeId?: number` — ID de l'utilisateur cible (optionnel si username fourni)
- `addresseeUsername?: string` — Username cible (longueur 1-80, optionnel si id fourni)
- Validation cross-champs : vérifiée dans le service (au moins un des deux requis).

**`UpdateFriendshipStatusDto`** (body `PATCH /friends/:id`)
- `status: FriendshipStatus` — enum `pending | accepted | blocked` (IsEnum)

**`FriendshipDto`** (réponse)
- `id`, `status`, `direction` (`'sent' | 'received'`), `otherUserId`, `otherUsername`, `otherDisplayName?`, `otherAvatarUrl?`, `createdAt` (ISO string), `acceptedAt?` (ISO string)
- `direction` est calculé côté serveur via `fromEntity(entity, currentUserId)` — le front reçoit directement le point de vue de l'appelant.

**`UserSearchResultDto`** (réponse `GET /friends/search`)
- `id`, `username`, `displayName?`, `avatarUrl?`

## Patterns identifiés

- **Repository pattern** : injections TypeORM via `@InjectRepository`. Aucune requête SQL brute.
- **DTO-first** : la couche controller ne retourne jamais d'entités brutes. Les DTOs contiennent leurs propres méthodes `fromEntity` statiques.
- **Lookup bidirectionnel** : le service passe systématiquement un tableau `where` TypeORM avec deux conditions `[{ requester: {id} }, { addressee: {id} }]` pour couvrir les deux orientations possibles d'une relation.
- **Throttle renforcé sur route sensible** : `@Throttle({ default: { ttl: 60_000, limit: 5 } })` sur `POST /friends/request` — en plus du guard global.
- **UserDecorator** : utilisation du décorateur partagé `@UserDecorator()` depuis `shared/Decorator/user.decorator.ts` plutôt que `@Request() req`.
- **Logger NestJS** : `private readonly logger = new Logger(FriendsService.name)` — logger prêt, pas encore appelé dans le code courant.

## Logique d'acceptation automatique croisée

Dans `sendRequest`, avant de créer une nouvelle ligne, le service vérifie si une relation existe dans l'un ou l'autre sens. Si une relation `pending` existe **en sens inverse** (c.-à-d. la cible est le `requester` de cette relation et l'appelant est l'`addressee`), le service met à jour la ligne existante vers `accepted` au lieu d'en créer une nouvelle. Cela garantit qu'il n'existe jamais deux lignes représentant la même paire d'utilisateurs.

## Consommation externe (module sharing)

`SharingService` et `ReadingGroupsService` injectent directement `Repository<UserFriendship>` (déclaré dans `TypeOrmModule.forFeature` du `SharingModule`) pour vérifier si une amitié `accepted` existe entre deux utilisateurs avant d'autoriser un partage ou une invitation dans un groupe de lecture. Cette duplication du repository (plutôt qu'une dépendance sur `FriendsService`) est un choix de découplage de service — documenté ici car cela crée une dépendance implicite sur le modèle de données `user_friendship`.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| — | Aucun fichier de test identifié pour le module friends | Absent |

## Points de dette technique

- **Validation cross-DTO non déclarative** : la contrainte "au moins un entre `addresseeId` et `addresseeUsername`" est vérifiée dans le service, pas dans le DTO. Un décorateur `@ValidateIf` ou une classe-validator custom permettrait de déclarer cette règle dans `SendFriendRequestDto`.
- **Pagination absente** : `listAccepted` et `listPendingReceived` retournent toutes les lignes. Un utilisateur très actif pourrait avoir une liste longue.
- **Dépendance croisée de repository** : `SharingModule` importe directement `UserFriendship` de `friends/`. Un changement du schéma `user_friendship` impacte silencieusement `SharingService` et `ReadingGroupsService`.
- **Logger non utilisé** : le logger est instancié mais aucun `this.logger.log/warn/error` n'est appelé dans le code courant.
