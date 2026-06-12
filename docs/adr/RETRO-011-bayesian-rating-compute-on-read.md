# RETRO-011 — Note agrégée Bayesienne compute-on-read (sans table dédiée)

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | mangas              |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | DB-STRATEGY |
| Q1 — Coût de revert > 1j ? | OUI — Matérialiser `aggregated_rating` en BDD nécessiterait : une migration d'ajout de colonne sur la table `manga`, un job de backfill initial, une logique de mise à jour déclenchée à chaque modification de `user_rating` (trigger DB ou hook service) ou un recalcul batch, la modification de `MangasService.getCommunityRatings` et de tous les DTOs qui exposent `aggregated_rating`. Refactoring transverse sur au moins 3 modules. |
| Q2 — Non-déductible du code ? | OUI — La décision délibérée de ne pas stocker `aggregated_rating` en BDD ne se voit ni dans `package.json` ni dans les configs TypeORM. La colonne est absente de `manga.entity.ts`, ce qui pourrait être interprété comme un oubli ou un TODO par un nouveau dev. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — La contrainte impacte : spec `mangas` (endpoint détail `GET /mangas/:id` qui calcule et retourne les trois champs de notation), spec future `recommendations` (l'enrichissement des listes de recommandations avec les notes communautaires utilise `getCommunityRatings` de `MangasService`). |
| Q4 — Casse un invariant si ignoré ? | OUI — Un dev qui ignore cette décision pourrait ajouter une colonne `aggregated_rating` sur la table `manga` et la mettre à jour depuis `MangasService.getMangaDetails` uniquement. La note serait alors figée au moment du dernier détail consulté, sans refléter les nouvelles notes `user_rating` ajoutées depuis — créant une désynchronisation silencieuse entre la valeur affichée et la réalité des votes locaux. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

---

## Contexte

L'API MangaUpdates fournit un `bayesian_rating` (note globale sur 10, basée sur de nombreux votants). L'application Manga Tracker dispose également de notes locales (`user_rating` dans `user_manga`, échelle 1-10). L'objectif est de présenter une note qui combine les deux sources pour les mangas peu connus (où la note MU est absente ou peu fiable) tout en restant stable pour les grands titres (où la note MU est déjà solide).

---

## Décision identifiée

La note agrégée n'est pas stockée en BDD. Elle est calculée à chaque appel de `GET /mangas/:id` via :

1. Une requête SQL `GROUP BY manga_id` sur `user_manga` pour obtenir `AVG(user_rating)` et `COUNT(*)` des votes locaux > 0.
2. La formule Bayesienne de `rating-aggregator.ts` : `(C × MU_rating + n × local_avg) / (C + n)` avec `C = 50`.

Trois valeurs sont retournées dans `MangaDetailsDto` : `community_rating` (moyenne locale brute), `community_rating_count` (nb votants), `aggregated_rating` (résultat de la formule). Aucune n'est persistée.

---

## Conséquences observées

### Positives

- La note reflète toujours l'état actuel des votes locaux sans nécessiter de mise à jour explicite.
- Pas de désynchronisation possible entre la valeur affichée et les votes en BDD.
- Pas de migration lors d'un changement de formule (changer `C = 50` ou la formule ne touche qu'un seul fichier).

### Négatives / Dette

- Coût SQL à chaque appel de détail (requête `GROUP BY` sur `user_manga`). Si la table `user_manga` grossit significativement, un index sur `(manga_id, user_rating)` pourrait devenir nécessaire.
- La note agrégée n'est pas disponible dans les listes (tendances, bibliothèque) sans un appel par manga — les listes utilisent la note MU brute (`rating` stockée en BDD) à la place.
- La constante `C = 50` est hardcodée — une évolution du paramètre métier nécessite un redéploiement.

---

## Recommandation

Garder pour l'état actuel du produit (base d'utilisateurs limitée, table `user_manga` de petite taille). Si la volumétrie croît et que l'endpoint détail devient un goulot d'étranglement, envisager une matérialisation partielle : calcul en background (job toutes les heures) stocké dans une colonne `aggregated_rating` sur `manga`, avec invalidation sur chaque modification de `user_rating`. Documenter ce seuil de décision (ex. > 10 000 utilisateurs actifs ou > 500 ms p95 sur l'endpoint détail).
