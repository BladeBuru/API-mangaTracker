# RETRO-014 — Garde-fou partage réservé aux amis acceptés

| Champ      | Valeur                      |
|------------|-----------------------------|
| Statut     | Documenté (rétro)           |
| Date       | 2026-06-04                  |
| Source     | Rétro-ingénierie            |
| Features   | sharing                     |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | SECURITY |
| Q1 — Coût de revert > 1j ? | OUI — supprimer ou assouplir la contrainte touche 4 méthodes réparties sur 2 services (`SharingService.shareWithFriends`, `ReadingGroupsService.createGroup`, `ReadingGroupsService.inviteToGroup`, `ReadingGroupsService.filterAcceptedFriendIds`) et nécessite une revue produit pour définir la politique de remplacement anti-spam |
| Q2 — Non-déductible du code ? | OUI — aucun fichier de config (`package.json`, `tsconfig.json`, `.env`) ne révèle cette contrainte ; elle réside dans la logique métier des services et ne peut être comprise qu'en lisant l'intention derrière `filterAcceptedFriendIds` |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — contrainte active dans `SharingService` (spec sharing/partage-manga) ET dans `ReadingGroupsService` (spec sharing/groupes-lecture), avec dépendance structurelle sur la feature `friends` (RETRO-013) |
| Q4 — Casse un invariant si ignoré ? | OUI — tout nouvel endpoint de partage ou d'invitation ajouté sans appel à `filterAcceptedFriendIds` permettrait d'envoyer des recommandations ou invitations non-sollicitées à n'importe quel utilisateur de la base, constituant un vecteur de spam et de harcèlement |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

## Contexte

La fonctionnalité de partage de manga et les groupes de lecture sont des surfaces sociales qui permettent à un utilisateur d'initier un contact sortant vers d'autres utilisateurs. Sans filtre, ces fonctionnalités peuvent être détournées pour envoyer des messages non-sollicités à grande échelle (spam) ou cibler des utilisateurs qui ne souhaitent pas interagir avec l'expéditeur.

Le modèle d'amitié existant (RETRO-013 — friendship single-row bidirectionnel) fournit un graphe social validé bilatéralement : une relation `UserFriendship` avec statut `Accepted` garantit que les deux parties se sont mutuellement acceptées. Ce graphe est réutilisé ici comme liste blanche de confiance.

## Décision identifiée

Toute action de partage ou d'invitation vers un autre utilisateur est conditionnée à l'existence d'une relation `UserFriendship` avec `status = FriendshipStatus.Accepted` entre l'initiateur et le destinataire.

Ce garde-fou est implémenté à deux niveaux :

1. **`SharingService.shareWithFriends`** : vérifie l'amitié pour chaque `friendId` de la liste avant de créer les `MangaShare`. Les destinataires non-amis sont ignorés silencieusement ; si aucun destinataire n'est ami, la requête échoue en 403.

2. **`ReadingGroupsService.filterAcceptedFriendIds`** (méthode privée) + appels dans `createGroup` et `inviteToGroup` : filtre les identifiants en entrée contre le graphe d'amitié. Un invité non-ami provoque une erreur 403 immédiate (pas d'ignorance silencieuse — contrairement au partage, l'invitation à un groupe est nominative et son rejet doit être explicite).

La requête de vérification supporte les deux sens de la relation (requester→addressee et addressee→requester) conformément au modèle bidirectionnel de RETRO-013.

## Conséquences observées

### Positives

- Prévention du spam : un utilisateur ne peut pas être ciblé par des partages ou invitations de personnes qu'il n'a pas acceptées comme amis.
- Cohérence avec le modèle social de l'application : les interactions restent dans le graphe de confiance établi.
- Pas de coût infrastructure supplémentaire : la vérification s'appuie sur la table `user_friendship` déjà chargée dans d'autres contextes.

### Négatives / Dette

- La logique de vérification d'amitié est dupliquée entre `SharingService` et `ReadingGroupsService` au lieu d'être centralisée dans `FriendsService`. Si la définition de "ami accepté" évolue (ex : blocage d'utilisateur, statut suspendu), les deux services devront être mis à jour indépendamment.
- L'ignorance silencieuse des destinataires non-amis dans `shareWithFriends` (vs rejet 403 dans `inviteToGroup`) crée une légère incohérence de comportement entre les deux sous-domaines.
- Un test automatisé vérifiant explicitement ce garde-fou est absent — l'invariant n'est garanti que par relecture de code.

## Recommandation

**Garder** — la contrainte est correcte et nécessaire.

Centraliser la logique dans `FriendsService` (méthode `filterAcceptedFriendIds(userId, candidateIds): Promise<number[]>`) pour éviter la duplication et garantir la cohérence lors d'évolutions futures du modèle d'amitié (ex : blocage d'utilisateur).

Ajouter des tests unitaires couvrant explicitement les cas : destinataire non-ami (403), destinataire ami accepté (201/200), liste mixte amis/non-amis (comportement silencieux vs 403 selon le sous-domaine).
