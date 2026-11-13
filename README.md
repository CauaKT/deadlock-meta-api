# LockPro API (`deadlock-meta-api`)

API REST do projeto **LockPro**, responsável por autenticação, gerenciamento de sessões, perfis de usuários, envio de e-mails transacionais e administração.

- Repositório do front-end: `github.com/CauaKT/deadlock-meta`
- Produção: Front-end na Vercel (`https://lockpro.vercel.app`) com proxy `/api/backend/*` → API em Docker no Render (`https://deadlock-meta-api.onrender.com`) → PostgreSQL no Neon (`sa-east-1`).

---

## Stack

- **Runtime / Framework:** Node.js 22 (Docker) + NestJS 12 + Express 5 + TypeScript 6
- **Banco de Dados & ORM:** PostgreSQL 16 + Prisma 6 (`url` pooled + `directUrl` para migrations)
- **Autenticação:** JWT em cookie `httpOnly` (`lockpro_session`) + bcryptjs (hash de senha) + Google OAuth 2.0
- **E-mail:** Brevo HTTP API (`BREVO_API_KEY`, porta 443) com fallback para SMTP via Nodemailer e simulação `[DEV MAIL]` em desenvolvimento
- **Segurança & Qualidade:** `@nestjs/throttler` (rate limit), `class-validator` / `class-transformer`, `oxlint`

---

## Arquitetura de Produção (Proxy First-Party)

Em produção, o front-end Next.js (`next.config.ts`) expõe o rewrite `/api/backend/:path*` apontando para `API_URL`.
- Todas as chamadas do navegador (login, cadastro, logout, onboarding, perfis e callback do Google OAuth) trafegam pela mesma origem do front-end (`https://lockpro.vercel.app/api/backend/...`).
- Isso garante que o cookie `lockpro_session` (`httpOnly`, `sameSite: "lax"`, `secure: true` em produção/HTTPS) seja tratado como **first-party** pelos navegadores, evitando bloqueios cross-site entre `*.vercel.app` e `*.onrender.com`.
- No SSR do Next.js (`lib/backend/server.ts`), o servidor do front-end repassa o cookie `lockpro_session` manualmente no header `Cookie` para `API_URL`.

---

## Como Rodar Localmente com Docker

### 1. Pré-requisitos
- Node.js 22+
- Docker e Docker Compose

### 2. Subir o PostgreSQL com Docker
Na raiz do repositório `deadlock-meta-api`:

```bash
cp .env.example .env
docker compose up -d
```

O `docker-compose.yml` sobe o container `deadlock-meta-postgres` (`postgres:16-alpine`) na porta `5432` com banco `deadlock_meta`, usuário `postgres` e senha `postgres`.

### 3. Instalar dependências, aplicar migrations e iniciar a API

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

A API sobe em `http://localhost:3001` (verifique `http://localhost:3001/health`).

### 4. Build e execução em container Docker (produção)

```bash
docker build -t deadlock-meta-api .
docker run --rm -p 3001:3001 --env-file .env deadlock-meta-api
```

### Scripts úteis

| Script | Descrição |
| --- | --- |
| `npm run start:dev` | Inicia a API em modo watch |
| `npm run build` | Compila para `dist/` (`nest build`) |
| `npm run start:prod` | Executa `node dist/main` |
| `npm run lint` | Executa `oxlint --type-aware` em `src/` e `test/` |
| `npm run admin:promote` | Executa `scripts/promote-admin.mjs` carregando `.env` para promover um usuário a `ADMIN` |

---

## Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `DATABASE_URL` | Sim | Connection string do PostgreSQL (em produção no Neon, usar a URL **pooled**) |
| `DIRECT_URL` | Sim | Connection string direta (sem pooler) usada pelo Prisma em migrations |
| `PORT` | Não | Porta HTTP da API (padrão `3001`; no Render é injetada automaticamente) |
| `APP_URL` | Não | URL pública da própria API (padrão `http://localhost:3001`) |
| `FRONTEND_URL` | Sim | Origem(ns) do front-end separadas por vírgula para CORS e redirects (ex.: `https://lockpro.vercel.app`) |
| `PUBLIC_API_URL` | Não | Sobrescreve a base pública usada em links de verificação (padrão `${FRONTEND_URL}/api/backend`) |
| `GOOGLE_CALLBACK_URL` | Não | Sobrescreve a `redirect_uri` do Google OAuth (padrão `${PUBLIC_API_URL}/auth/google/callback`) |
| `JWT_SECRET` | Sim | Segredo usado para assinar e verificar os tokens JWT de sessão |
| `JWT_EXPIRES_IN` | Não | Expiração do JWT (padrão `7d`) |
| `REQUIRE_EMAIL_VERIFICATION` | Não | `"true"` exige confirmação de e-mail antes do login por senha |
| `GOOGLE_CLIENT_ID` | Não | Client ID do Google OAuth 2.0 |
| `GOOGLE_CLIENT_SECRET` | Não | Client Secret do Google OAuth 2.0 |
| `BREVO_API_KEY` | Não | Chave da API HTTP da Brevo (porta 443 — recomendada em hosts que bloqueiam porta 587) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Não | Fallback SMTP tradicional caso `BREVO_API_KEY` não esteja definida |
| `SMTP_FROM` | Não | Remetente dos e-mails (padrão `LockPro <cauakt@gmail.com>`) |

---

## Modelo de Dados (`prisma/schema.prisma`)

### Enums
- `Role`: `USER` | `ADMIN`
- `TokenType`: `EMAIL_VERIFY` | `PASSWORD_RESET`

### Tabelas

| Tabela (`@@map`) | Model | Campos principais & relações |
| --- | --- | --- |
| `users` | `User` | `id` (UUID PK), `email` (unique), `password_hash` (nullable), `google_id` (unique, nullable), `role` (`Role`, default `USER`), `email_verified` (default `false`), `created_at`, `updated_at`. Relações `1:1` com `Profile`, `1:N` com `AuthToken` e `TierList`. |
| `auth_tokens` | `AuthToken` | `id` (UUID PK), `user_id` (FK → `users.id`, `ON DELETE CASCADE`), `type` (`TokenType`), `token_hash` (unique, SHA-256), `expires_at`, `created_at`. Índice em `[user_id, type]`. |
| `profiles` | `Profile` | `id` (UUID PK), `user_id` (unique FK → `users.id`, `ON DELETE CASCADE`), `username` (unique, nullable), `handle` (unique, nullable), `bio`, `avatar_url`, `steam_id`, `favorite_hero_id`, `banner_hero_id`, `banner_image`, `profile_color`, `created_at`, `updated_at`. |
| `tier_lists` | `TierList` | `id` (UUID PK), `user_id` (nullable FK → `users.id`, `ON DELETE SET NULL`), `title`, `author_name`, `tiers` (`Json`), `created_at`, `updated_at`. *(Estrutura preparada para o módulo P3 de TierMaker.)* |

---

## Endpoints

### Saúde
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/` | Público | Mensagem básica de status da API |
| `GET` | `/health` | Público | Verifica conectividade com o PostgreSQL (`{"status":"ok","db":"up"}`) |

### Autenticação (`/auth`)
| Método | Rota | Acesso | Rate limit | Descrição |
| --- | --- | --- | --- | --- |
| `POST` | `/auth/register` | Público | 5 / 60s | Cria usuário + perfil, verifica unicidade de e-mail/nick e envia link de confirmação (ou abre sessão direta se `REQUIRE_EMAIL_VERIFICATION !== "true"`) |
| `POST` | `/auth/login` | Público | 10 / 60s | Valida credenciais e grava cookie `lockpro_session` |
| `POST` | `/auth/logout` | Público | Global | Limpa o cookie `lockpro_session` |
| `GET` | `/auth/me` | `JwtAuthGuard` | Global | Retorna dados de sessão e resumo do perfil do usuário autenticado |
| `POST` | `/auth/verify-email` | Público | 10 / 60s | Valida token de confirmação de e-mail via corpo JSON |
| `GET` | `/auth/verify-email` | Público | 10 / 60s | Valida `?token=` do link de e-mail e redireciona para `${FRONTEND_URL}/login?verified=1` (ou erro) |
| `POST` | `/auth/resend-verification` | Público | 3 / 60s | Reenvia e-mail de confirmação com resposta genérica anti-enumeração |
| `POST` | `/auth/forgot-password` | Público | 3 / 60s | Gera token `PASSWORD_RESET` (1h) e envia link para `${FRONTEND_URL}/reset-password` |
| `POST` | `/auth/reset-password` | Público | 5 / 60s | Atualiza senha via token e invalida tokens de reset do usuário |
| `GET` | `/auth/google` | Público | 15 / 60s | Grava cookie `lockpro_oauth_state` e redireciona para o consentimento do Google |
| `GET` | `/auth/google/callback` | Público | 15 / 60s | Valida `state`, vincula/cria conta Google, grava `lockpro_session` e redireciona para `/welcome` ou `next` |

### Perfis (`/profiles`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/profiles/me` | `JwtAuthGuard` | Retorna o perfil completo do usuário autenticado |
| `PUT` | `/profiles/onboarding` | `JwtAuthGuard` | Define `username`, `@handle` e `avatarUrl` no primeiro acesso |
| `PATCH` | `/profiles/me/look` | `JwtAuthGuard` | Atualiza aparência pública do perfil (`username`, `bio`, `handle`, `avatarUrl`, `bannerHeroId`, `bannerImage`) |
| `PATCH` | `/profiles/me/settings` | `JwtAuthGuard` | Atualiza configurações do perfil (`username`, `steamId`, `profileColor`, `favoriteHeroId`, `bannerHeroId`, `bannerImage`) |
| `GET` | `/profiles/community` | `OptionalJwtAuthGuard` | Lista sugestões públicas da comunidade (exclui o próprio usuário quando autenticado) |
| `GET` | `/profiles/by-handle/:handle` | `OptionalJwtAuthGuard` | Retorna visualização pública de um perfil pelo `@handle` (sem expor e-mail ou `steamId`) |

### Administração (`/admin`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/admin/overview` | `JwtAuthGuard` + `RolesGuard` (`ADMIN`) | Visão geral de contagens do sistema |
| `GET` | `/admin/users` | `JwtAuthGuard` + `RolesGuard` (`ADMIN`) | Lista paginada de usuários com filtro opcional `?search=` |
| `PATCH` | `/admin/users/:id/role` | `JwtAuthGuard` + `RolesGuard` (`ADMIN`) | Altera a role (`USER` / `ADMIN`) de um usuário específico |

---

## Regras de Acesso e Segurança

- **Autenticação (`JwtAuthGuard`):** lê o JWT do cookie `lockpro_session` (ou `Authorization: Bearer`), valida assinatura com `JWT_SECRET` e confirma o usuário no PostgreSQL, anexando `{ userId, email, role }` em `req.user`.
- **Autorização por Role (`RolesGuard` + `@Roles`):** rotas administrativas exigem `role === "ADMIN"`, retornando `403 Forbidden` para usuários comuns.
- **Escopo de Dono do Recurso:** rotas de leitura privada e edição de perfil (`GET /profiles/me`, `PUT /profiles/onboarding`, `PATCH /profiles/me/*`) usam exclusivamente `user.userId` extraído do JWT — nunca aceitam `userId` do corpo ou da URL.
- **Proteção de Dados Públicos:** `GET /profiles/community` e `GET /profiles/by-handle/:handle` expõem apenas campos públicos do perfil (sem `email`, `passwordHash`, `googleId` ou `steamId`).
- **Rate Limiting (`ThrottlerModule`):** limite global de `60` requisições por `60s` por IP (`app.set('trust proxy', 1)` ativo para leitura correta de IP atrás de proxy reverso), com limites mais restritos nas rotas de `/auth/*`.
- **Validação & Payloads:** `ValidationPipe` global configurado com `whitelist: true`, `forbidNonWhitelisted: true` e `transform: true`; limite de body JSON/urlencoded em `2mb`.