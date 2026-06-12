# RETRO-009 — Modèle de tracking de lecture dual : pointeur de progression + log additif

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | library             |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | DB-STRATEGY |
| Q1 — Coût de revert > 1j ? | OUI — fusionner les deux mécanismes ou supprimer l'un d'eux nécessiterait une migration de schéma sur `user_manga` et `user_manga_chapter_log`, une réécriture de `LibraryService.updateChapter` + `ChapterLogService`, et une adaptation du client mobile Flutter qui appelle séparément `PUT /library/chapter` et `POST /library/:muId/chapter-log` |
| Q2 — Non-déductible du code ? | OUI — ni `package.json` ni aucune config ne révèlent la décision de maintenir deux mécanismes intentionnellement non synchronisés ; la raison (replays, skips et bonus ne doivent pas influer sur le pointeur global) est documentée dans les commentaires de l'entité mais n'est pas auto-évidente à un dev qui découvre le code |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — le module `library` consomme le pointeur `user_read_chapters` pour la progression, et le module `stats` consomme `user_manga_chapter_log` pour les statistiques de lecture (temps de lecture, replays, taux de completion) |
| Q4 — Casse un invariant si ignoré ? | OUI — un dev qui synchroniserait `user_read_chapters` depuis le log (en comptant les lignes non-skipped) casserait la sémantique : le log inclut les replays (N lignes pour le même chapitre) et les bonus, alors que le pointeur est un numéro de chapitre absolu ; la confusion entraînerait des valeurs de progression aberrantes |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

## Contexte

L'application doit répondre à deux besoins distincts :

1. **Progression simple** : "j'en suis au chapitre 42" — un entier monotone utilisé dans l'UI principale, le tri de la bibliothèque, et le calcul du statut (reading / caughtUp / completed).
2. **Historique enrichi** : replays, chapitres bonus, skips volontaires, position de scroll pour la reprise — fonctionnalités de "Phase 5" ajoutées ultérieurement sans casser la compatibilité du client existant.

Fusionner les deux dans une seule table aurait imposé soit une complexification du modèle (agrégats à la lecture), soit une perte d'information (ne garder qu'un pointeur).

## Décision identifiée

Deux mécanismes de tracking coexistent dans le module library :

- **`user_manga.user_read_chapters`** : entier représentant le numéro du dernier chapitre lu, mis à jour par `PUT /library/chapter`. Source de vérité pour la progression globale et le statut de lecture. Géré exclusivement par `LibraryService`.

- **`user_manga_chapter_log`** : table additive, une ligne par session de lecture. Enregistrée par `POST /library/:muId/chapter-log`. Plusieurs lignes peuvent exister pour le même `(user, manga, chapterNumber)` (replays). Supporte les flags `isBonus`, `isSkipped`, et la colonne `scrollPosition`. Géré exclusivement par `ChapterLogService`.

Les deux mécanismes ne se synchronisent jamais automatiquement : appeler `PUT /library/chapter` n'insère pas de log ; enregistrer une session de log n'incrémente pas le pointeur. C'est au client de décider quand appeler chacun.

## Conséquences observées

### Positives
- Rétrocompatibilité totale : les clients qui n'utilisent que `PUT /library/chapter` continuent de fonctionner sans modification
- Flexibilité : le log peut évoluer (nouvelles colonnes, nouvelles sémantiques) sans impacter le flux de progression principal
- Clarté des responsabilités : `LibraryService` ne connaît pas `UserMangaChapterLog` ; `ChapterLogService` ne connaît pas `UserManga`

### Négatives / Dette
- Double appel réseau obligatoire côté client pour une session de lecture complète (PUT chapter + POST chapter-log)
- Risque de désynchronisation si le client n'appelle que l'un des deux endpoints (ex : progression avancée sans log, ou log enregistré sans avancer le pointeur)
- Le plafond de 500 lignes dans `listForManga` est codé en dur — une pagination sera nécessaire pour les utilisateurs intensifs
- Aucun mécanisme de réconciliation n'existe si les données des deux tables divergent

## Recommandation

Garder — la séparation est intentionnelle et documentée. La dette principale est l'absence de pagination sur `GET /library/:muId/chapter-log` : à adresser si des utilisateurs accumulent plus de 500 sessions de lecture pour un même manga.
