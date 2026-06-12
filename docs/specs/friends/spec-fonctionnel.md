# Spec Fonctionnelle — friends [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | friends             |
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

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-013](../../adr/RETRO-013-friendship-single-row-bidirectional.md) | Modèle d'amitié une ligne par couple avec bidirectionnalité applicative | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

> ADR transverse référencé : [RETRO-006](../../adr/RETRO-006-username-unique-case-insensitive.md) — Username unique insensible à la casse (feature `profile`). La résolution par username dans `sendRequest` et la recherche `searchUsers` s'appuient sur cet invariant.

---

## Contexte et objectif

Le module `friends` implémente un système social de mise en relation entre utilisateurs de l'application. Son but est de permettre à un utilisateur d'envoyer des demandes d'amitié, d'accepter ou refuser les demandes reçues, et de maintenir un réseau de contacts. Ce réseau est exploité par d'autres modules (sharing, reading-groups) pour restreindre le partage de contenu aux amis confirmés.

## Règles métier (déduites du code)

1. **Demande orientée** : une demande d'amitié est créée par un `requester` vers un `addressee`. La ligne en base est directionnelle jusqu'à acceptation.
2. **Unicité stricte du couple** : il ne peut exister qu'une seule ligne `user_friendship` pour une paire donnée `(requester, addressee)`. La contrainte d'unicité `UQ_friendship_requester_addressee` l'impose en base.
3. **Interdiction d'auto-ajout** : un utilisateur ne peut pas s'envoyer une demande à lui-même.
4. **Acceptation automatique croisée** : si l'utilisateur A envoie une demande à B alors qu'une demande `pending` de B vers A existe déjà, la demande de B est automatiquement promue au statut `accepted` sans créer de deuxième ligne.
5. **Seul l'addressee peut changer le statut** : l'acceptation, le rejet et le blocage d'une demande sont réservés à l'utilisateur destinataire (addressee). Le requester ne peut qu'envoyer ou supprimer.
6. **Les deux parties peuvent supprimer** : `DELETE /friends/:id` est accessible au requester comme à l'addressee.
7. **Le statut `blocked` persiste** : quand une relation est bloquée, la ligne reste en base. Cela empêche le requester d'envoyer une nouvelle demande tant que le blocage n'est pas levé par suppression.
8. **Seules les demandes `pending` sont acceptables** : tenter d'accepter une relation déjà `accepted` ou `blocked` déclenche une erreur 400.
9. **Résolution par username ou par ID** : `POST /friends/request` accepte `addresseeId` ou `addresseeUsername` (mutuellement optionnels, au moins un requis). La résolution par username est insensible à la casse (ILIKE).
10. **Recherche avec exclusion des relations existantes** : `GET /friends/search?q=` retourne uniquement les utilisateurs sans relation existante (quel que soit le statut) avec l'utilisateur courant. Requête minimum 2 caractères. Limite 20 résultats.
11. **Anti-spam sur les demandes** : `POST /friends/request` est soumis à un throttle renforcé de 5 requêtes par minute par utilisateur.

## Cas d'usage (déduits)

### CU-001 — Envoyer une demande d'amitié (chemin nominal)

1. L'utilisateur A fournit `addresseeUsername` ou `addresseeId`.
2. Le service résout l'utilisateur cible (lookup insensible à la casse si username).
3. Le service vérifie l'absence de relation existante dans les deux sens.
4. Une ligne `user_friendship` est créée avec `status = pending`.
5. La réponse inclut un `FriendshipDto` avec `direction = 'sent'`.

### CU-002 — Demande croisée (acceptation automatique)

1. L'utilisateur B envoie une demande à A alors qu'une demande `pending` de A vers B existe.
2. Le service détecte la relation inverse `pending` (A est requester, B est addressee).
3. La ligne existante est mise à jour : `status = accepted`, `acceptedAt = NOW()`.
4. Aucune nouvelle ligne n'est créée — la relation unique (A→B) est conservée.
5. La réponse retourne le `FriendshipDto` avec `status = accepted`, `direction = 'received'` du point de vue de B.

### CU-003 — Accepter une demande reçue (chemin standard)

1. L'utilisateur B consulte `GET /friends/pending`.
2. B envoie `PATCH /friends/:id` avec `status = accepted`.
3. Le service vérifie que B est bien l'`addressee` de la relation.
4. Le service vérifie que le statut actuel est `pending`.
5. La relation passe à `accepted`, `acceptedAt` est horodatée.

### CU-004 — Bloquer un utilisateur

1. B envoie `PATCH /friends/:id` avec `status = blocked`.
2. Seul l'addressee peut bloquer.
3. La ligne reste en base — le requester ne peut pas renvoyer de demande tant que la ligne existe.

### CU-005 — Recherche d'utilisateurs pour autocomplete

1. L'utilisateur saisit au moins 2 caractères.
2. `GET /friends/search?q=<query>` retourne jusqu'à 20 utilisateurs dont le `username` contient la chaîne (ILIKE, insensible à la casse).
3. L'utilisateur courant est exclu des résultats.
4. Les utilisateurs avec lesquels une relation existe (quel que soit le statut) sont exclus.

### CU-006 — Lister ses amis

1. `GET /friends` retourne toutes les relations `accepted` où l'utilisateur est requester ou addressee.
2. Les résultats sont triés par `acceptedAt DESC`.
3. Chaque `FriendshipDto` expose l'autre utilisateur (pas soi-même), avec une indication de `direction`.

## Dépendances

- `user` (module) : entité `User` pour la résolution username→id et la jointure sur les profils.
- `sharing` (module consommateur) : `SharingService` et `ReadingGroupsService` interrogent directement le repository `UserFriendship` pour vérifier l'existence d'une amitié `accepted` avant tout partage de contenu.
- `@nestjs/throttler` : throttle renforcé sur `POST /friends/request`.
- RETRO-006 (username case-insensitive ILike) : la recherche et la résolution par username s'appuient sur l'invariant d'unicité case-insensitive du username.

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Notification push** : le code ne contient aucune logique d'envoi de notification lors d'une nouvelle demande ou d'une acceptation. Est-ce prévu, délégué au front, ou hors scope ?
- **Levée d'un blocage** : `blocked` n'est pas dans `UpdateFriendshipStatusDto` (qui expose les trois statuts via l'enum), mais il n'y a pas de route dédiée "débloquer". Est-ce que `DELETE /friends/:id` est le seul moyen de lever un blocage ?
- **Visibilité côté requester** : si A bloque B (A est addressee), B voit-il la relation dans `GET /friends` ? Le `FriendshipDto` est retourné avec `status = blocked` — le front doit filtrer ou afficher un état différent ?
- **Pagination** : `listAccepted` et `listPendingReceived` ne sont pas paginées. Anticipé comme limitation pour une grande liste d'amis ?
- **Portée RGPD** : l'export RGPD (`GET /user/gdpr/export`) inclut-il les données de la table `user_friendship` ? Non visible dans le module friends.
