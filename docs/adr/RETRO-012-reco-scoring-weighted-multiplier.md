# RETRO-012 — Scoring de recommandations par multiplicateurs pondérés (statut × récence × note)

| Champ      | Valeur                   |
|------------|--------------------------|
| Statut     | Documenté (rétro)        |
| Date       | 2026-06-04               |
| Source     | Rétro-ingénierie         |
| Features   | recommendations          |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | DB-STRATEGY |
| Q1 — Coût de revert > 1j ? | OUI — remplacer ce modèle (ex : passer à du filtrage collaboratif implicite ou à un top-popularité brut) impose de réécrire `computeMultiplier`, `scoreRecos`, `relaxIfPoolTooSmall`, `computeScoreMap`, et la suite de tests associée (~350 lignes de logique + ~250 lignes de tests). |
| Q2 — Non-déductible du code ? | OUI — `package.json` ne contient aucune lib de recommandation ; le choix de scorer explicitement par statut de lecture, ancienneté d'ajout et note utilisateur (plutôt que par co-occurrence implicite ou popularité MU brute) ne se voit que dans l'architecture du service. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — la spec `library` est contrainte (les champs `readingStatus`, `user_rating`, `adding_date` de `UserManga` doivent rester présents pour que le scoring soit possible) ; la spec `mangas` est contrainte (le champ `weight` de `MangaRecommendation` est la matière première du scoring). |
| Q4 — Casse un invariant si ignoré ? | OUI — un dev qui neutralise ou uniformise le multiplicateur de statut (ex : retirer `STATUS_MULTIPLIER` pour simplifier) casse silencieusement la personnalisation : toutes les recos deviendraient équipondérées, sans signal de préférence, sans erreur visible. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

## Contexte

Le moteur de recommandations s'appuie sur la table `manga_recommendation` peuplée depuis l'API MangaUpdates. Le pool de candidats est objectivement le même pour deux utilisateurs ayant les mêmes mangas en bibliothèque. Ce qui différencie les recos d'un utilisateur à l'autre — et donne du sens à la personnalisation — c'est la pondération de ces candidats par les signaux d'affinité explicites propres à chaque utilisateur.

Trois signaux ont été identifiés dans le code comme pertinents :
1. **Le statut de lecture** (`readingStatus`) — proxy de l'intensité de l'appréciation.
2. **L'ancienneté de l'ajout** (`adding_date`) — proxy de la pertinence actuelle des goûts.
3. **La note personnelle** (`user_rating`) — signal direct, mais absent sur la majorité des entrées.

## Décision identifiée

Le service calcule un multiplicateur composite par manga source :

```
multiplier = ratingFactor × statusFactor × recencyFactor

ratingFactor  = user_rating / 5.0  si user_rating > 0,  sinon 1.0
statusFactor  = STATUS_MULTIPLIER[readingStatus]  (1.0 si inconnu)
recencyFactor = exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
```

Avec `STATUS_MULTIPLIER = { completed: 1.5, caughtUp: 1.3, reading: 1.2, readLater: 0.8 }` et `RECENCY_HALF_LIFE_DAYS = 365`.

Ce multiplicateur est appliqué à chaque `weight` MU des recommandations issues du manga source. Les scores sont accumulés dans un `Map<muId, ScoredEntry>` (contributions additives de toutes les sources).

Le modèle est dit "à signaux explicites" : il n'observe pas le comportement implicite des utilisateurs (clics, scrolls), uniquement ce qu'ils ont déclaré (statut, note, date d'ajout).

## Conséquences observées

### Positives

- **Sans dépendance externe** : pas de lib de machine learning, pas de base vectorielle. Le scoring s'exécute entièrement en mémoire, en TypeScript.
- **Explicabilité native** : le champ `recommendedBecauseOf` est un sous-produit direct de la structure `sources: Map<muId, contribution>` — les 3 sources les plus contributives sont immédiatement disponibles.
- **Résistance au cold start partiel** : un utilisateur avec 1-2 mangas en bibliothèque obtient quand même des recos grâce au cap adaptatif. Un utilisateur sans bibliothèque bascule sur le top communauté + sleepers.
- **Pas de données comportementales requises** : pas de tracking de navigation nécessaire.

### Négatives / Dette

- **Calibrage empirique non documenté** : les valeurs `1.5 / 1.3 / 1.2 / 0.8` et `365 jours` de demi-vie sont codées en dur sans trace de calibrage ou de données justificatives. Un changement de ces valeurs n'est pas guidé par des métriques.
- **Duplication logique** : `buildUserRecommendations` et `computeScoreMap` contiennent la même logique de fetch/scoring. Le commentaire dans le code reconnaît explicitement cette dette ("duplique partiellement la logique pour éviter l'over-engineering").
- **Pas de feedback loop** : le modèle ne s'améliore pas avec les interactions. La pertinence des recos dépend entièrement de la qualité des données MU et de la cohérence entre statut de lecture et vrai goût de l'utilisateur.
- **Valeurs STATUS_MULTIPLIER non étendues** : les statuts non mappés (ex : un futur statut `dropped`) reçoivent un multiplicateur 1.0 par défaut, ce qui peut biaiser positivement les recos issues d'un manga abandonné.

## Recommandation

**Garder** le modèle tel quel pour la phase actuelle (projet personnel, faible volume utilisateurs). Documenter les valeurs de calibrage dans un commentaire ou un fichier dédié si elles sont ajustées. Si le projet évolue vers un usage multi-utilisateurs à grande échelle, envisager un feedback loop (ex : marquer les recos ignorées ou ajoutées à la bibliothèque) pour améliorer le calibrage.
