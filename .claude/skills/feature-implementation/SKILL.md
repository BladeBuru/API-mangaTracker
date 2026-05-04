---
name: feature-implementation
description: Workflow 6 phases pour implémenter une nouvelle feature dans Manga Tracker API (NestJS) — analyse memory-bank, planification DTO/route/sécurité, structuration DTO-first, implémentation Controller<200 / Service<400, validation, mise à jour memory-bank.
---

# Skill : Implémenter une feature — Manga Tracker API

Workflow structuré pour implémenter une nouvelle feature NestJS sans déraper.

---

## Phase 1 — Analyse (OBLIGATOIRE)

1. Lire le memory-bank :
   - `.claude/memory-bank/architecture.md`
   - `.claude/memory-bank/progress.md`
   - `.claude/memory-bank/decisions.md`
   - `.claude/memory-bank/known-issues.md`

2. Lire la documentation pertinente :
   - `.claude/docs/architecture.md` — structure modules + patterns
   - `.claude/docs/modules-structure.md` — patterns détaillés par module
   - `.claude/docs/api-contracts.md` — format des réponses et erreurs

3. Comprendre le besoin :
   - Quel est l'objectif de la feature ?
   - Quel module ? (`mangas`, `library`, `user`, `auth` ou nouveau)
   - Dépendances avec les modules existants ?

4. Analyser l'existant :
   - Comment les modules similaires sont-ils structurés ?
   - DTOs / entités / services réutilisables ?
   - Entité TypeORM déjà définie ?

---

## Phase 2 — Planification (OBLIGATOIRE)

1. Définir la structure :
   - DTOs (`Create`, `Update`, `Search`)
   - Routes (`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`)
   - Logique métier (service)
   - Queries TypeORM (service)

2. Vérifier la séparation des responsabilités :
   - Controller : routes + validation DTOs uniquement (MAX 200 lignes)
   - Service : logique métier uniquement (MAX 400 lignes)
   - Si service trop lourd → services spécialisés

3. Planifier la sécurité :
   - Routes privées → `@UseGuards(AuthGuard('jwt'))`
   - Throttling renforcé sur endpoints sensibles
   - Isolation des données par utilisateur (`req.user.userId`)

4. Plan d'implémentation numéroté.

---

## Phase 3 — Structuration

1. Créer les DTOs en premier (validation `class-validator` + `@ApiProperty`).
2. Définir l'entité TypeORM si nouveau module.
3. Vérifier la cohérence avec DTOs/entités existants.
4. Typer explicitement (pas d'`any`).

**Si le schéma DB change → générer une migration TypeORM** (jamais `synchronize: true` en prod).

---

## Phase 4 — Implémentation

Ordre :

1. **Entity** — TypeORM avec `uuid`, `@CreateDateColumn`, `@UpdateDateColumn`.
2. **DTOs** — Validation + `@ApiProperty` Swagger.
3. **Service** — `@InjectRepository`, exceptions descriptives.
4. **Controller** — Routes HTTP, `@UseGuards`, `@ApiTags`, `@ApiOperation`.
5. **Module** — `TypeOrmModule.forFeature([Entity])`, imports, exports.
6. **Migration** TypeORM si schéma DB modifié.

Limites strictes :
- Controller : MAX 200 lignes
- Service : MAX 400 lignes
- Si dépassement → invoquer la skill `refactor-large-file`.

---

## Phase 5 — Validation

Checklist :

- [ ] `@UseGuards(AuthGuard('jwt'))` sur toutes les routes privées
- [ ] Séparation Controller/Service respectée
- [ ] Validation DTOs complète (`class-validator` + `@ApiProperty`)
- [ ] Typage strict (pas d'`any`)
- [ ] Pas de logique métier dans le controller
- [ ] Exceptions NestJS descriptives (pas de messages génériques)
- [ ] Aucun fichier controller > 200 lignes, service > 400 lignes
- [ ] `req.user.userId` passé au service (jamais traité dans le controller)
- [ ] Migration TypeORM générée si schéma modifié
- [ ] Throttling configuré sur endpoints sensibles

---

## Phase 6 — Documentation

1. Mettre à jour `.claude/memory-bank/progress.md` (feature ajoutée)
2. Mettre à jour `.claude/memory-bank/architecture.md` si changement structurel
3. Mettre à jour `.claude/docs/modules-structure.md` si nouveau module
4. Commentaires : "pourquoi", pas "comment"

---

## Format de réponse

```markdown
## Feature : [Nom]

### Analyse
- Module : [mangas | library | user | auth | nouveau]
- Dépendances : [liste]
- Entités touchées : [liste]

### Implémentation
- DTOs créés : [liste]
- Routes ajoutées : [VERBE /path]
- Entité créée/modifiée : [nom]
- Service(s) : [créé | modifié]
- Migration : [nom_migration | non nécessaire]

### Validation
- ✅ Checklist complétée
- Auth JWT : [protégé / public]
- Throttling : [config]

### Memory bank mis à jour
- progress.md : ✅
- architecture.md : [✅ / non nécessaire]
```

---

**Rappel** : Lire le memory-bank AVANT de coder. Pas de vibe coding.
