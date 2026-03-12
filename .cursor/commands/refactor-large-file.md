# Commande : Découper un fichier trop long — Manga Tracker API

Quand cette commande est déclenchée, suivre ce guide pour découper un fichier trop long.

---

## Seuils de découpage

| Type | Seuil d'alerte | Action |
|------|---------------|--------|
| Controller | > 200 lignes | Découper en sous-controllers ou extraire logique |
| Service | > 400 lignes | Extraire services spécialisés dans `services/` |
| Tout fichier | > 600 lignes | **CRITIQUE** — découpage obligatoire immédiat |

---

## Étape 1 : Analyser le fichier

1. **Identifier les responsabilités multiples** :
   - Quelles méthodes / logiques peuvent être regroupées par thème ?
   - Y a-t-il de la logique qui appartient à un autre service ?

2. **Identifier le pattern de découpage adapté** (voir ci-dessous)

---

## Patterns de découpage

### Controller trop long (> 200 lignes)

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

---

### Service trop long (> 400 lignes)

**Pattern** : Extraire des services spécialisés

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

## Étape 2 : Plan de découpage

1. **Lister les méthodes à déplacer** et leur destination
2. **Vérifier les dépendances** (injections à copier)
3. **Créer le nouveau fichier** avec la logique extraite
4. **Mettre à jour les imports** dans le fichier d'origine
5. **Déclarer le nouveau service dans le module** NestJS

---

## Étape 3 : Validation post-découpage

**Checklist** :

1. ✅ Aucun fichier controller > 200 lignes ?
2. ✅ Aucun fichier service > 400 lignes ?
3. ✅ Séparation des responsabilités toujours respectée ?
4. ✅ Imports corrects dans tous les fichiers ?
5. ✅ Nouveaux services déclarés dans le module NestJS ?
6. ✅ Pas de code dupliqué introduit ?
7. ✅ Fonctionnalité inchangée ?

---

## Format de Réponse

```markdown
## Refactoring : [nom-fichier.ts]

### Analyse
- Taille initiale : [X] lignes
- Responsabilités identifiées : [liste]
- Pattern appliqué : [controller split | service split]

### Découpage
- Fichiers créés : [liste avec taille finale]
- Méthodes déplacées : [liste]
- Fichier original : [X] lignes → [Y] lignes

### Validation
- ✅ Aucun fichier > seuil
- ✅ Séparation respectée
- ✅ Fonctionnalité inchangée
```

---

**Rappel** : Découper progressivement. Tester que le module compile après chaque extraction.
