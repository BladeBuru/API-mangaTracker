# Spec Fonctionnelle — Profile [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | profile             |
| Version    | 0.1.0               |
| Date       | 2026-06-04          |
| Auteur     | retro-documenter    |
| Statut     | DRAFT               |
| Source     | Rétro-ingénierie    |

> **[DRAFT — à valider par le dev]** Cette spec a été générée par rétro-ingénierie
> à partir du code existant. Elle doit être relue et validée par un développeur
> qui connaît le contexte métier.

---

## ADRs

## ADRs

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-006](../../adr/RETRO-006-username-unique-case-insensitive.md) | Username unique case-insensitive via index fonctionnel LOWER() | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

---

## Contexte et objectif

Le module Profile gère les données de présentation d'un utilisateur — nom affiché, biographie, avatar, date de naissance et genre — ainsi que le contrôle de visibilité (profil public/privé). Il couvre également les opérations basiques de compte : modification du username, changement de mot de passe, suppression de compte, et lecture des informations propres à l'utilisateur connecté.

Ce module est marqué "Phase 3" dans le code, indiquant qu'il a été introduit après les fonctionnalités d'authentification de base. Les champs de profil étendu (`displayName`, `bio`, `avatarUrl`, `dateOfBirth`, `gender`, `isProfilePublic`) ont été ajoutés à l'entité `User` existante.

## Règles métier (déduites du code)

1. **Unicité du username case-insensitive** : deux utilisateurs ne peuvent pas avoir des usernames identiques à la casse près (`John` et `john` sont en conflit). Cette contrainte est portée par un index unique fonctionnel PostgreSQL sur `LOWER(username)` (voir RETRO-006).

2. **Visibilité du profil opt-in** : le profil public est privé par défaut (`isProfilePublic = false`). Un utilisateur doit explicitement activer la visibilité publique. Si `isProfilePublic = false`, `GET /user/profile/:id` retourne 403.

3. **Mise à jour partielle** : `PATCH /user/profile` n'écrase que les champs explicitement fournis dans la requête. Les champs absents du payload conservent leur valeur en base.

4. **Remise à null non supportée via PATCH** : le service interprète `undefined` comme "ne pas toucher au champ". Il n'est pas possible de remettre un champ à null via cet endpoint (comportement documenté dans le commentaire du service comme limitation connue).

5. **Fallback displayName → username** : quand `displayName` est null, `PublicProfileDto.fromEntity()` retourne `username` en lieu et place de `displayName`. Le client n'a pas à gérer ce cas.

6. **dateOfBirth normalisée en YYYY-MM-DD** : la date de naissance est stockée en type `date` PostgreSQL mais retournée normalisée en ISO date string `YYYY-MM-DD` (sans la partie heure) dans `UserInformationDto`.

7. **Données personnelles exclues du profil public** : `PublicProfileDto` n'expose jamais l'email, le mot de passe, le googleId, ou la date de naissance. Seuls `id`, `username`, `displayName`, `bio`, `avatarUrl`, et `accountCreatedAt` sont visibles publiquement.

8. **Avatar : URL http(s) ou data URL base64** : le champ `avatarUrl` accepte soit une URL externe (`https://...`), soit une data URL base64 de type image/jpeg, image/png, ou image/webp. Un payload base64 est limité à 200 000 caractères (~150 KB d'image) par validation DTO. La colonne est de type `text` en base (sans limite de taille).

9. **Password hashé avec bcrypt (saltRounds 10)** : le changement de mot de passe applique `bcrypt.hashSync` avec `genSaltSync(10)`. Le mot de passe en clair n'est jamais persisté.

10. **Genre : privacy-by-default** : l'enum `UserGender` inclut `prefer_not_to_say` comme option explicite, cohérente avec le principe RGPD de minimisation des données.

## Cas d'usage (déduits)

### CU-001 — Lecture des informations du compte connecté
Un utilisateur authentifié appelle `GET /user/information`. Le service retourne un `UserInformationDto` contenant l'id, l'email, le username, l'état de vérification email, et tous les champs de profil étendu. Aucun appel DB supplémentaire n'est effectué — les données proviennent directement de `req.user` injecté par le guard JWT.

### CU-002 — Mise à jour du profil étendu
Un utilisateur authentifié envoie `PATCH /user/profile` avec un sous-ensemble des champs (`displayName`, `bio`, `avatarUrl`, `dateOfBirth`, `gender`, `isProfilePublic`). Le service applique uniquement les champs présents et persiste en base. La réponse est un `UserInformationDto` reflétant l'état après mise à jour.

### CU-003 — Activation du profil public
Un utilisateur envoie `PATCH /user/profile` avec `{ "isProfilePublic": true }`. Son profil devient accessible à tout utilisateur authentifié via `GET /user/profile/:id`.

### CU-004 — Consultation du profil public d'un autre utilisateur
Un utilisateur authentifié appelle `GET /user/profile/:id`. Si l'utilisateur cible existe et a `isProfilePublic = true`, un `PublicProfileDto` est retourné (id, username, displayName, bio, avatarUrl, accountCreatedAt). Si le profil est privé, 403 est retourné. Si l'utilisateur n'existe pas, 404.

### CU-005 — Changement de username
Un utilisateur authentifié envoie `PUT /user/name` avec `{ "name": "NouveauNom" }`. Si le nouveau username est déjà pris (au sens case-insensitive), PostgreSQL lève une violation de contrainte unique. Le service ne gère pas explicitement ce cas — l'erreur se propage en 500 côté client (zone d'incertitude : pas de gestion explicite du conflit de username dans le service actuel).

### CU-006 — Changement de mot de passe
Un utilisateur authentifié envoie `PUT /user/password` avec `{ "password": "nouveauMdp" }`. Le service hash le mot de passe avec bcrypt (saltRounds 10) et le persiste. L'utilisateur reste connecté (aucune révocation de sessions implémentée à ce stade).

### CU-007 — Suppression de compte
Un utilisateur authentifié appelle `DELETE /user/delete`. Le service supprime l'entité User en base. Grâce aux contraintes `onDelete: 'CASCADE'` sur `user_manga` et `user_session`, les données liées sont supprimées automatiquement. La réponse retourne un `UserInformationDto` de l'état avant suppression.

## Dépendances

- **UserService** : service central du module, injecté dans `UserController`.
- **TypeORM Repository<User>** : accès direct à la table `user`.
- **JwtAuthGuard** : tous les endpoints sont protégés par ce guard.
- **bcryptjs** : hachage du mot de passe à la mise à jour.
- **UserInformationDto / PublicProfileDto** : projection des données User pour les réponses API.
- **Modules dépendants** : `FriendsService` (feature `friends`) utilise le champ `username` avec `ILike` — dépend de l'invariant RETRO-006.

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Gestion du conflit de username** : `UserService.updateName` n'intercepte pas la `QueryFailedError` TypeORM levée lors d'une violation de l'index unique. Il n'est pas clair si c'est intentionnel (le client est censé vérifier la disponibilité en amont) ou un oubli. Nécessite validation.
- **Révocation des sessions après changement de mot de passe** : après `PUT /user/password`, les refresh tokens existants restent valides. Est-ce un choix délibéré ou une fonctionnalité à implémenter ?
- **Visibilité du profil pour les amis (Phase 6)** : le commentaire dans `user.service.ts` mentionne que les amis auront un accès dédié bypassant le check `isProfilePublic`. Le comportement exact (un ami peut-il voir un profil privé ?) n'est pas encore implémenté.
- **Remise à null d'un champ de profil** : l'endpoint `PATCH /user/profile` ne supporte pas la remise à null d'un champ. Un endpoint dédié est évoqué dans le commentaire du service mais n'existe pas. Cas d'usage : un utilisateur veut supprimer sa bio ou son avatar.
- **Rate limiting sur les endpoints de modification de profil** : les endpoints `PUT /user/name`, `PUT /user/password`, et `PATCH /user/profile` n'ont pas de `@Throttle()` explicite dans le controller — ils héritent du throttler global (100 req/min). Est-ce suffisant ?
