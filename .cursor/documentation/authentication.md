# Documentation : Authentification — Manga Tracker API

## Stratégie JWT double token

### AccessToken
- **Durée** : 15 minutes (configurable via `JWT_ACCESS_EXPIRATION`)
- **Usage** : Toutes les requêtes protégées (`Authorization: Bearer <token>`)
- **Guard** : `AuthGuard('jwt')` → `AccessTokenStrategy`
- **Payload** : `{ userId: string, email: string, iat, exp }`

### RefreshToken
- **Durée** : 7 jours (configurable via `JWT_REFRESH_EXPIRATION`)
- **Usage** : Renouvellement de l'accessToken uniquement
- **Guard** : `AuthGuard('jwt-refresh')` → `RefreshTokenStrategy`
- **Stockage côté client** : `flutter_secure_storage` (Flutter)

---

## Flux d'authentification complet

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENT (Flutter)                      │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  1. POST /auth/login                                      │
│     Body: { email, password }                             │
│     ← Response: { accessToken, refreshToken }             │
│                                                           │
│  2. Stocker les tokens dans flutter_secure_storage        │
│                                                           │
│  3. Requêtes protégées :                                  │
│     Header: Authorization: Bearer <accessToken>           │
│                                                           │
│  4. accessToken expiré (401) →                            │
│     POST /auth/refresh                                    │
│     Header: Authorization: Bearer <refreshToken>          │
│     ← Response: { accessToken }                           │
│                                                           │
│  5. refreshToken expiré → déconnecter l'utilisateur       │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

---

## Guards disponibles

```typescript
// Routes privées standards
@UseGuards(AuthGuard('jwt'))

// Route de refresh uniquement
@UseGuards(AuthGuard('jwt-refresh'))

// Route publique (pas de guard)
// Pas de décorateur guard
```

---

## Accéder à l'utilisateur dans un controller

```typescript
// Option 1 — Via @Request()
@Get('profile')
@UseGuards(AuthGuard('jwt'))
getProfile(@Request() req) {
  const userId = req.user.userId;
  const email = req.user.email;
  return this.userService.findById(userId);
}

// Option 2 — Via @GetUser() (shared/Decorator/user.decorator.ts)
@Get('profile')
@UseGuards(AuthGuard('jwt'))
getProfile(@GetUser() user: JwtPayload) {
  return this.userService.findById(user.userId);
}
```

---

## Implémentation des stratégies

### `AccessTokenStrategy` (`user/auth/strategy/accessTokenStrategy.ts`)
```typescript
@Injectable()
export class AccessTokenStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_ACCESS_SECRET,
    });
  }

  validate(payload: JwtPayload) {
    return payload; // Injecté dans req.user
  }
}
```

### `RefreshTokenStrategy` (`user/auth/strategy/refreshTokenStrategy.ts`)
```typescript
@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_REFRESH_SECRET,
    });
  }

  validate(payload: JwtPayload) {
    return payload;
  }
}
```

---

## Sécurité des mots de passe

- Hash via **bcryptjs** (saltRounds = 10)
- Jamais stocker le mot de passe en clair
- Comparaison via `bcrypt.compare(password, hashedPassword)`

---

## Points d'attention

- Le **refreshToken** ne doit être utilisé QUE sur `POST /auth/refresh`
- En cas d'expiration du refreshToken → rediriger vers le login
- Côté Flutter : `HttpService` gère le refresh automatiquement (retry sur 401)
- Ne jamais exposer `JWT_ACCESS_SECRET` ou `JWT_REFRESH_SECRET` dans les logs
