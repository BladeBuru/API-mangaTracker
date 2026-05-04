---
name: refactor-large-file
description: Découpage d'un fichier NestJS dépassant les seuils (Controller > 200, Service > 400, fichier > 600 lignes) — extraction de la logique vers le service, sous-controllers par domaine, services spécialisés.
---

# Skill : Refactor large file — Manga Tracker API

Découpage d'un fichier NestJS dépassant les seuils.

---

## Seuils

| Type | Seuil d'alerte | Action |
|------|---------------|--------|
| Controller | > 200 lignes | Découper en sous-controllers ou extraire la logique vers le service |
| Service | > 400 lignes | Extraire des services spécialisés dans `services/` |
| Tout fichier | > 600 lignes | **CRITIQUE** — découpage immédiat |

---

## Étape 1 — Analyser

1. Identifier les responsabilités multiples :
   - Quelles méthodes / logiques peuvent être regroupées par thème ?
   - Y a-t-il de la logique qui appartient à un autre service ?
2. Choisir le pattern de découpage adapté.

---

## Patterns

### Controller > 200 lignes

**Option A** — Extraire la logique dans le service (préféré)

```
Avant : LibraryController (250 lignes avec logique)
Après : LibraryController (80 lignes, routes uniquement)
        LibraryService (logique déplacée)
```

**Option B** — Sous-controllers par domaine

```
api/library/
├── library.controller.ts        # Routes CRUD principales
└── controllers/
    └── library-stats.controller.ts  # Routes statistiques
```

### Service > 400 lignes

```
api/mangas/
├── mangas.service.ts            # Orchestration (< 100 lignes)
├── sync-manga.service.ts        # Synchronisation MangaUpdates
└── update-manga.service.ts      # Mise à jour des données
```

```typescript
// mangas.service.ts — orchestration légère
@Injectable()
export class MangasService {
  constructor(
    private readonly syncService: SyncMangaService,
    private readonly updateService: UpdateMangaService,
  ) {}

  async syncAll() {
    return this.syncService.syncAll();
  }
}
```

---

## Étape 2 — Plan de découpage

1. Lister les méthodes à déplacer + destination.
2. Vérifier les dépendances (injections à copier).
3. Créer le nouveau fichier avec la logique extraite.
4. Mettre à jour les imports.
5. Déclarer le nouveau service dans le module NestJS.

---

## Étape 3 — Validation

- [ ] Aucun controller > 200 lignes
- [ ] Aucun service > 400 lignes
- [ ] Séparation des responsabilités respectée
- [ ] Imports corrects partout
- [ ] Nouveaux services déclarés dans le module
- [ ] Pas de code dupliqué introduit
- [ ] Fonctionnalité inchangée (tests verts)

---

## Format de réponse

```markdown
## Refactoring : [nom-fichier.ts]

### Analyse
- Taille initiale : [X] lignes
- Responsabilités identifiées : [liste]
- Pattern appliqué : [controller split | service split]

### Découpage
- Fichiers créés : [liste avec taille finale]
- Méthodes déplacées : [liste]
- Fichier original : [X] → [Y] lignes

### Validation
- ✅ Aucun fichier > seuil
- ✅ Séparation respectée
- ✅ Fonctionnalité inchangée
```

---

**Rappel** : Découper progressivement. Tester que le module compile après chaque extraction.
