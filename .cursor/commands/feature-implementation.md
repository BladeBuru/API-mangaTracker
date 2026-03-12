# Commande : Implémenter une Feature — Manga Tracker API

Quand cette commande est déclenchée, suivre ce workflow structuré pour implémenter une nouvelle feature NestJS.

---

## Phase 1 : Analyse (OBLIGATOIRE)

1. **Lire le memory-bank** :
   - `.cursor/memory-bank/architecture.md`
   - `.cursor/memory-bank/progress.md`
   - `.cursor/memory-bank/decisions.md`
   - `.cursor/memory-bank/known-issues.md`

2. **Lire la documentation** :
   - `.cursor/documentation/architecture.md` — Structure modules + patterns
   - `.cursor/documentation/modules-structure.md` — Patterns détaillés par module
   - `.cursor/documentation/api-contracts.md` — Format des réponses et erreurs

3. **Comprendre le besoin** :
   - Quel est l'objectif de la feature ?
   - Quel module concerne-t-elle ? (`mangas`, `library`, `user`, `auth` ou nouveau ?)
   - Quelles sont les dépendances avec les modules existants ?

4. **Analyser l'existant** :
   - Comment les modules similaires sont-ils structurés ? (ex: `library` ou `mangas`)
   - Quels DTOs, entités, services existent déjà et peuvent être réutilisés ?
   - L'entité TypeORM est-elle déjà définie ?

---

## Phase 2 : Planification (OBLIGATOIRE)

1. **Définir la structure** :
   - Quels DTOs créer ? (`CreateDto`, `UpdateDto`, `SearchDto`)
   - Quelles routes exposer ? (`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`)
   - Quelle logique métier dans le service ?
   - Quelles queries TypeORM dans le service ?

2. **Vérifier la séparation des responsabilités** :
   - Controller : Routes + validation DTOs uniquement (MAX 200 lignes)
   - Service : Logique métier uniquement (MAX 400 lignes)
   - Si service trop lourd → prévoir services spécialisés dans `services/`

3. **Planifier la sécurité** :
   - Routes privées → `@UseGuards(AuthGuard('jwt'))`
   - Comment accéder à `req.user.userId` ?
   - Quelle isolation des données par utilisateur ?

4. **Créer un plan d'implémentation** (étapes numérotées)

---

## Phase 3 : Structuration (OBLIGATOIRE)

1. **Créer les DTOs en premier** avec validation complète (`class-validator`)
2. **Définir l'entité TypeORM** si nouveau module
3. **Vérifier la cohérence** avec les DTOs et entités existants
4. **Typer explicitement** (pas d'`any`)

---

## Phase 4 : Implémentation

**Ordre recommandé** :

1. **Entity** (si nouveau module) — TypeORM avec `uuid`, `@CreateDateColumn`, `@UpdateDateColumn`
2. **DTOs** — Validation complète `class-validator` + `@ApiProperty` pour Swagger
3. **Service** — Logique métier, `@InjectRepository()`, exceptions NestJS descriptives
4. **Controller** — Routes HTTP, `@UseGuards`, `@ApiTags`, `@ApiOperation`
5. **Module** — Déclaration `TypeOrmModule.forFeature([Entity])`, imports, exports

**Limites strictes** :
- Controller : MAX 200 lignes
- Service : MAX 400 lignes
- Si dépassement → consulter `.cursor/commands/refactor-large-file.md`

---

## Phase 5 : Validation

**Checklist** :

1. ✅ `@UseGuards(AuthGuard('jwt'))` sur toutes les routes privées ?
2. ✅ Séparation Controller/Service respectée ?
3. ✅ Validation DTOs complète (`class-validator` sur tous les champs) ?
4. ✅ `@ApiProperty()` sur tous les champs DTO (Swagger) ?
5. ✅ Typage strict (pas d'`any`) ?
6. ✅ Pas de logique métier dans le controller ?
7. ✅ Exceptions NestJS descriptives (pas de messages génériques) ?
8. ✅ Aucun fichier controller > 200 lignes, service > 400 lignes ?
9. ✅ `req.user.userId` passé au service (jamais traité dans le controller) ?

---

## Phase 6 : Documentation

1. **Mettre à jour `.cursor/memory-bank/progress.md`** — Documenter la feature ajoutée
2. **Mettre à jour `.cursor/memory-bank/architecture.md`** — Si changement structurel
3. **Mettre à jour `.cursor/documentation/modules-structure.md`** — Si nouveau module
4. Commentaires : expliquer le "pourquoi", pas le "comment"

---

## Format de Réponse

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

### Validation
- ✅ Checklist complétée
- Auth JWT : [protégé / public]

### Memory bank mis à jour
- progress.md : ✅
- architecture.md : [✅ / non nécessaire]
```

---

**Rappel** : Lire le memory-bank AVANT de coder. Le vibe coding est strictement interdit.
