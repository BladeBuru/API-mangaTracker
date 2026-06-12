# Spec Fonctionnelle — Sharing [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | sharing             |
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
| [RETRO-014](../../adr/RETRO-014-sharing-friend-only-guard.md) | Garde-fou partage réservé aux amis acceptés | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

**ADR de dépendance (feature friends) :**

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-013](../../adr/RETRO-013-friendship-single-row-bidirectional.md) | Friendship single-row bidirectionnel | Documenté (rétro) |

> RETRO-013 est tagué `Features: friends` — il est référencé ici car le garde-fou RETRO-014 repose structurellement sur le modèle d'amitié qu'il définit.

---

## Contexte et objectif

Le module `sharing` (Phase 8 + 8.3) couvre deux fonctionnalités sociales distinctes mais couplées par la même contrainte de sécurité :

1. **Partage de manga entre amis** : un utilisateur peut recommander un manga à un ou plusieurs de ses amis (max 20 destinataires par envoi). Le partage est accompagné d'un message optionnel de 280 caractères maximum.

2. **Groupes de lecture (reading groups)** : un utilisateur peut créer un groupe autour d'un manga pour synchroniser sa progression de lecture avec d'autres membres (max 10 membres). La progression de chaque membre est lue à la volée depuis la table `user_manga` existante — elle n'est pas dupliquée.

Les deux sous-fonctionnalités partagent la contrainte : toute interaction (partage ou invitation) nécessite une relation d'amitié acceptée entre les parties (voir RETRO-013 et RETRO-014).

---

## Règles métier (déduites du code)

### Partage de manga

1. L'expéditeur ne peut partager qu'avec des utilisateurs qui sont ses amis avec statut `Accepted` (voir `FriendshipStatus`).
2. Si un ou plusieurs destinataires ne sont pas des amis acceptés, ils sont silencieusement ignorés. Si **aucun** des destinataires n'est un ami accepté, la requête échoue avec une erreur 403.
3. Maximum 20 destinataires par envoi (validé au niveau service et DTO).
4. Idempotence légère : si une share non-vue (seenAt = null) existe déjà pour la même paire (expéditeur, destinataire, manga), aucun doublon n'est créé.
5. Le message est optionnel et limité à 280 caractères.
6. La lecture de l'inbox (`GET /sharing/inbox`) retourne les 100 shares les plus récents reçus par l'utilisateur, triés par date décroissante.
7. La marque "vu" est appliquée en masse : `POST /sharing/inbox/mark-seen` met à jour tous les shares non-vus en une seule opération.
8. Un compteur de shares non-vus est disponible (`GET /sharing/inbox/unseen-count`) pour alimenter un badge UI (BottomNavBar).

### Groupes de lecture

1. Le créateur d'un groupe devient automatiquement membre et `owner` du groupe.
2. Au moins un ami doit être invité à la création (un groupe à un seul membre n'a pas de sens fonctionnel).
3. Tous les invités doivent être des amis acceptés du créateur. Si l'un des invités ne l'est pas, la requête échoue avec 403.
4. Maximum 10 membres par groupe (créateur inclus).
5. Idempotence à la création : si un groupe `(owner, manga)` existe déjà, la requête réutilise ce groupe et ajoute les nouveaux invités non encore membres (évite le doublon "clic double").
6. Seul l'owner peut inviter de nouveaux membres après la création.
7. Seul l'owner peut supprimer le groupe (`DELETE /reading-groups/:id`).
8. Quand l'owner quitte le groupe (`DELETE /reading-groups/:id/leave`) et qu'il reste d'autres membres, l'ownership est transféré au membre dont la date `joinedAt` est la plus ancienne parmi les membres restants.
9. Quand l'owner quitte et qu'il est le dernier membre, le groupe est supprimé.
10. La progression de lecture de chaque membre (nombre de chapitres lus) est lue en temps réel depuis `user_manga.user_read_chapters`. Si le membre n'a pas le manga dans sa bibliothèque, sa progression est `null`.
11. L'URL de lecture personnalisée (`custom_link`) de chaque membre est exposée dans la réponse pour permettre au client de construire un lien de chapitre vers la plateforme de lecture externe de l'ami.

---

## Cas d'usage (déduits)

### CU-001 — Partager un manga avec des amis
**Acteur** : utilisateur authentifié  
**Flux principal** :
1. L'utilisateur envoie `POST /sharing/manga/:muId` avec une liste de `friendIds` et un `message` optionnel.
2. Le service vérifie que le manga existe.
3. Pour chaque `friendId`, le service vérifie la relation d'amitié acceptée.
4. Les destinataires non-amis sont ignorés.
5. Pour chaque destinataire valide, le service vérifie l'idempotence (pas de share non-vue existante).
6. Les nouvelles shares sont créées et retournées.

**Cas d'erreur** :
- Manga inexistant → 404
- Aucun des destinataires n'est ami → 403
- Plus de 20 destinataires → 400
- DTO invalide → 400

### CU-002 — Consulter et lire son inbox de partages
**Acteur** : utilisateur authentifié  
**Flux principal** :
1. `GET /sharing/inbox` retourne les 100 derniers shares reçus.
2. `GET /sharing/inbox/unseen-count` retourne le nombre de shares non-vues.
3. L'utilisateur marque tout comme vu via `POST /sharing/inbox/mark-seen`.

### CU-003 — Créer un groupe de lecture
**Acteur** : utilisateur authentifié  
**Flux principal** :
1. L'utilisateur envoie `POST /reading-groups` avec un `muId`, des `inviteFriendIds` (min 1, max 10) et un `name` optionnel.
2. Le service vérifie que le manga existe et que les invités sont tous des amis acceptés.
3. Si un groupe `(owner, manga)` existe déjà, le service l'utilise et ajoute les nouveaux membres.
4. Sinon, un nouveau groupe est créé avec l'owner + les invités comme membres.
5. La réponse inclut la progression de chaque membre.

**Cas d'erreur** :
- Un invité n'est pas ami → 403
- Plus de 10 membres au total → 400
- Aucun invité → 400
- Manga inexistant → 404

### CU-004 — Suivre la progression d'un groupe
**Acteur** : membre d'un groupe  
**Flux principal** :
1. Le client appelle `GET /reading-groups/:id` toutes les 30 secondes (polling).
2. Le service vérifie que l'utilisateur est membre du groupe.
3. La réponse inclut la progression en chapitres et le lien custom de chaque membre.

### CU-005 — Gérer les membres d'un groupe
**Acteur** : owner d'un groupe  
**Flux** :
- Inviter : `POST /reading-groups/:id/invite` (amis acceptés uniquement, cap 10 membres).
- Quitter : `DELETE /reading-groups/:id/leave` (avec transfert d'ownership si nécessaire).
- Supprimer : `DELETE /reading-groups/:id` (owner uniquement, cascade sur les membres).

---

## Dépendances

- **Feature friends** : les entités `UserFriendship` et `FriendshipStatus` sont importées depuis `src/api/friends/`. La contrainte "ami accepté" est centrale dans les deux services (voir RETRO-013, RETRO-014).
- **Feature mangas / library** : `Manga` (vérification d'existence) et `UserManga` (lecture de progression `user_read_chapters` + `custom_link`) sont importés depuis `src/api/mangas/`.
- **Feature user** : `User` (entité référencée dans les relations ManyToOne).
- **Auth** : `JwtAuthGuard` sur tous les endpoints.
- **Throttler** : rate-limit de 30 req/min sur `POST /sharing/manga/:muId` et 10 req/min sur les mutations de groupes.

---

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- La politique de rétention des `manga_share` n'est pas visible dans le code (les shares "vues" ne sont jamais supprimées automatiquement — à confirmer).
- La valeur 30 secondes pour le polling client est documentée en commentaire de code mais aucun mécanisme serveur ne l'impose ni ne la valide. La fréquence réelle de polling dépend entièrement de l'implémentation Flutter.
- Le comportement attendu lorsqu'un membre est supprimé de la table `User` (cascade `onDelete: 'CASCADE'` sur les relations) n'est pas couvert par des tests automatisés — à valider.
- Le `name` d'un groupe de lecture est optionnel et peut être `null`. Il n'y a pas d'endpoint `PATCH` pour renommer un groupe après sa création.
- Les rôles "membre simple" vs "owner" dans un groupe : un membre simple ne peut pas exclure d'autres membres — seulement quitter. Ce comportement est implicite dans le code mais pas formalisé en spec.
