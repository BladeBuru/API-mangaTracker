# RETRO-013 — Modèle d'amitié une ligne par couple avec bidirectionnalité applicative

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | friends             |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | DATA-MODEL |
| Q1 — Coût de revert > 1j ? | OUI — migrer vers un modèle deux lignes par paire imposerait une migration de données, la réécriture de toutes les requêtes de lecture dans `FriendsService` (qui interrogent systématiquement les deux colonnes `requester_id` et `addressee_id`), et la mise à jour des deux consommateurs dans `SharingService` et `ReadingGroupsService` qui répliquent ce pattern de lookup bidirectionnel. |
| Q2 — Non-déductible du code ? | OUI — la contrainte d'unicité `UQ_friendship_requester_addressee` est visible en base, mais l'intention architecturale (ne jamais créer deux lignes pour le même couple, traiter la symétrie au niveau applicatif, et déclencher une acceptation automatique en cas de demande croisée plutôt que de créer une deuxième ligne) ne se déduit d'aucun `package.json`, `tsconfig.json` ou fichier de config. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — specs concernées : `docs/specs/friends/` (module principal) et `docs/specs/sharing/` (SharingService et ReadingGroupsService dépendent de ce modèle pour vérifier l'amitié `accepted` avant tout partage ou invitation de groupe). |
| Q4 — Casse un invariant si ignoré ? | OUI — un développeur ajoutant une requête de vérification d'amitié en ne cherchant que dans `requester_id` manquera silencieusement toutes les amitiés où l'utilisateur courant est `addressee`, ouvrant une faille d'autorisation dans le module sharing. Un développeur créant une deuxième ligne pour une demande croisée viole la contrainte d'unicité et corrompt l'état de la relation. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

## Contexte

Le système d'amitié doit modéliser une relation symétrique (une amitié active entre A et B est identique du point de vue des deux parties) à partir d'une demande initialement directionnelle (A envoie une demande à B). Deux approches classiques s'opposent :

1. **Deux lignes par paire** : une ligne `(A→B, accepted)` et une ligne `(B→A, accepted)`. La requête "mes amis" devient simple (`WHERE requester_id = me AND status = accepted`), mais chaque opération d'écriture doit maintenir deux lignes en cohérence.
2. **Une ligne par couple** : une seule ligne `(requester=A, addressee=B, accepted)`. Les requêtes de lecture doivent chercher dans les deux colonnes. L'opération d'écriture est atomique.

L'implémentation a retenu l'approche une ligne par couple, cohérente avec la contrainte d'unicité `UQ_friendship_requester_addressee` en base.

## Décision identifiée

La table `user_friendship` stocke **exactement une ligne par couple d'utilisateurs**, quel que soit l'état de la relation (`pending`, `accepted`, `blocked`). La colonne `requester_id` identifie l'initiateur, `addressee_id` le destinataire.

La bidirectionnalité est gérée intégralement au niveau applicatif :
- Toutes les requêtes TypeORM de lecture passent un `where` avec deux conditions : `[{ requester: { id: userId } }, { addressee: { id: userId } }]`.
- La suppression de doublon (détection d'une relation inverse avant création) est faite dans `sendRequest` avant l'insertion.
- En cas de **demande croisée** (A demande B alors que B a déjà une demande `pending` vers A), le service met à jour la ligne existante vers `accepted` au lieu d'en créer une nouvelle — garantissant que le couple n'a jamais plus d'une ligne en base.

## Conséquences observées

### Positives
- Les insertions et mises à jour sont atomiques (une seule ligne à écrire).
- La contrainte BDD `UQ_friendship_requester_addressee` est une dernière ligne de défense contre les doublons directs, en complément des vérifications du service.
- Les suppressions en cascade (suppression de compte) ne laissent pas de demi-relations orphelines.

### Negatives / Dette
- **Toute nouvelle requête de vérification d'amitié doit interroger les deux colonnes**. Ce pattern n'est pas encapsulé dans une méthode partagée du service : `SharingService` et `ReadingGroupsService` répliquent le pattern `[{requester:{id}}, {addressee:{id}}]` en copié-collé, ce qui crée un risque d'oubli lors de l'ajout d'un nouveau consommateur.
- La sémantique de "direction" est perdue en base (on ne sait plus qui a initié après acceptation, sauf via `requester_id`). Le DTO restitue l'information via le champ `direction`, mais cela suppose que l'appelant passe toujours son `currentUserId` à `fromEntity`.
- La detéction de la demande croisée ajoute une branche conditionnelle dans `sendRequest` qui doit être maintenue en cohérence si le comportement change.

## Recommandation

**Garder.** Le modèle une ligne par couple est le plus courant pour les systèmes d'amitié à faible cardinalité (réseau social personnel, pas un réseau public de masse). La contrainte d'unicité BDD est une protection solide.

**Action recommandée** : extraire le pattern de lookup bidirectionnel (`[{requester:{id}}, {addressee:{id}}]`) dans une méthode privée ou un helper du service, afin que `SharingService` et `ReadingGroupsService` puissent appeler `FriendsService.areFriends(userId, otherId)` plutôt que de répliquer la requête directement sur le repository.
