# LockPro API (`deadlock-meta-api`)

API REST do projeto **LockPro**, responsável por autenticação, gerenciamento de sessões, perfis, amizades, feed da comunidade, tier lists, moderação de conteúdo, envio de e-mails transacionais e administração.

- **Repositório do front-end:** [`deadlock-meta`](https://github.com/CauaKT/deadlock-meta)
- **Produção:** Front-end na Vercel (`https://lockpro.vercel.app`) com proxy `/api/backend/*` → API em Docker no Render (`https://deadlock-meta-api.onrender.com`) → PostgreSQL no Neon (`sa-east-1`).

---

## Stack

- **Runtime / Framework:** Node.js 22 (Docker) + NestJS 12 + Express 5 + TypeScript 6
- **Banco de Dados & ORM:** PostgreSQL 16 + Prisma 6 (`url` pooled + `directUrl` para migrations)
- **Autenticação & Sessão:** JWT em cookie `httpOnly` (`lockpro_session`) + revogação via `sessionVersion` + troca de até 5 contas (`lockpro_accounts`) + `bcryptjs` (custo 12) + Google OAuth 2.0
- **E-mail:** Brevo HTTP API (`BREVO_API_KEY`, porta 443) com fallback SMTP via Nodemailer e log `[DEV MAIL]` em desenvolvimento
- **Moderação:** OpenAI Moderation API (`omni-moderation-latest`) para textos e imagens (incluindo detecção NSFW em banners de perfil)
- **Segurança & Qualidade:** `@nestjs/throttler` (rate limit), `class-validator` / `class-transformer`, `oxlint`, Jest + Supertest

---

## Arquitetura de Produção (Proxy First-Party)

Em produção, o front-end Next.js (`next.config.ts`) expõe o rewrite `/api/backend/:path*` apontando para `API_URL`.
- Todas as chamadas do navegador (login, cadastro, logout, onboarding, perfis, feed, amizades e callback do Google OAuth) trafegam pela mesma origem do front-end (`https://lockpro.vercel.app/api/backend/...`).
- Isso garante que o cookie `lockpro_session` (`httpOnly`, `sameSite: "lax"`, `secure: true` em produção/HTTPS) seja tratado como **first-party** pelos navegadores.
- No SSR do Next.js, o servidor do front-end repassa o cookie `lockpro_session` manualmente no header `Cookie` para `API_URL`.

---

## Como Rodar Localmente com Docker

### 1. Pré-requisitos
- Node.js 22+
- Docker e Docker Compose

### 2. Configurar variáveis e subir o PostgreSQL

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
| `npm run test` | Executa testes unitários com Jest |
| `npm run test:e2e` | Executa testes end-to-end (Jest + Supertest) |
| `npm run test:cov` | Executa testes com relatório de cobertura |
| `npm run admin:promote` | Promove/rebaixa um usuário a `ADMIN` via CLI (`npm run admin:promote -- email@exemplo.com [--demote]`) |

---

## Testes

Os testes utilizam **Jest** e **Supertest**:

```bash
# Testes unitários
npm run test

# Testes end-to-end (requer banco configurado no .env)
npm run test:e2e
```

---

## Variáveis de Ambiente

Veja `.env.example`:

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
| `OPENAI_API_KEY` | Não | Chave da OpenAI para moderação de texto/imagem (`omni-moderation-latest`) e detecção NSFW de banners |

---

## Deploy (Render + Neon)

1. Crie o banco PostgreSQL no **Neon** e obtenha as URLs `DATABASE_URL` (pooled) e `DIRECT_URL` (direct).
2. No **Render**, crie um Web Service apontando para o repositório `CauaKT/deadlock-meta-api` usando o `Dockerfile` da raiz.
3. Configure as variáveis de ambiente (incluindo `FRONTEND_URL=https://lockpro.vercel.app`, `JWT_SECRET`, `BREVO_API_KEY`, Google OAuth e `OPENAI_API_KEY`).
4. Aplique as migrations contra o banco de produção com `npx prisma migrate deploy`.

---

## Modelo de Dados (`prisma/schema.prisma`)

### Enums
- `Role`: `USER` | `ADMIN`
- `TokenType`: `EMAIL_VERIFY` | `PASSWORD_RESET` | `EMAIL_CHANGE`
- `FriendshipStatus`: `PENDING` | `ACCEPTED`

### Tabelas

| Tabela (`@@map`) | Model | Campos principais & relações |
| --- | --- | --- |
| `users` | `User` | `id`, `email` (unique), `password_hash`, `google_id` (unique), `role`, `email_verified`, `must_change_password`, `session_version`, `created_at`, `updated_at`. |
| `auth_tokens` | `AuthToken` | `id`, `user_id` (FK → `users.id` cascade), `type` (`TokenType`), `token_hash` (unique SHA-256), `expires_at`, `payload`, `attempts`, `created_at`. |
| `profiles` | `Profile` | `id`, `user_id` (unique FK → `users.id` cascade), `username` (unique), `handle` (unique), `bio`, `avatar_url`, `steam_id`, `favorite_hero_id`, `banner_hero_id`, `banner_image`, `banner_nsfw`, `profile_color`, `social_links` (`Json`), `friends_public`, `created_at`, `updated_at`. |
| `tier_lists` | `TierList` | `id`, `user_id` (nullable FK → `users.id` set null), `title`, `author_name`, `tiers` (`Json`), `created_at`, `updated_at`. |
| `posts` | `Post` | `id`, `user_id` (FK → `users.id` cascade), `content`, `media_url`, `created_at`, `updated_at`. |
| `post_comments` | `PostComment` | `id`, `post_id` (FK → `posts.id` cascade), `user_id` (FK → `users.id` cascade), `content`, `created_at`, `updated_at`. |
| `post_likes` | `PostLike` | `id`, `post_id`, `user_id` (unique `[post_id, user_id]`), `created_at`. |
| `friendships` | `Friendship` | `id`, `requester_id`, `addressee_id` (unique `[requester_id, addressee_id]`), `status` (`FriendshipStatus`), `created_at`, `updated_at`. |

---

## Endpoints

### Saúde
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/` | Público | Mensagem básica de status da API |
| `GET` | `/health` | Público | Verifica conectividade com o PostgreSQL (`{"status":"ok","db":"up"}`) |

### Autenticação (`/auth`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | Público (5/60s) | Cria usuário + perfil, envia link de confirmação e abre sessão (exceto se `REQUIRE_EMAIL_VERIFICATION="true"`) |
| `POST` | `/auth/login` | Público (10/60s) | Valida credenciais, grava `lockpro_session` e registra conta em `lockpro_accounts` |
| `POST` | `/auth/logout` | Público | Limpa `lockpro_session` |
| `GET` | `/auth/me` | `JwtAuthGuard` | Retorna dados de sessão e resumo do perfil |
| `GET` | `/auth/accounts` | `OptionalJwtAuthGuard` | Lista contas salvas em `lockpro_accounts` |
| `POST` | `/auth/switch-account` | Público | Alterna a sessão ativa para outra conta salva no cookie |
| `POST` | `/auth/accounts/remove` | Público | Remove uma conta da lista de contas salvas |
| `DELETE` | `/auth/me` | `JwtAuthGuard` | Exclui a própria conta |
| `POST` | `/auth/verify-email` | Público (10/60s) | Valida token de confirmação de e-mail via JSON |
| `GET` | `/auth/verify-email` | Público (10/60s) | Valida `?token=` do link de e-mail e redireciona para o front-end |
| `POST` | `/auth/resend-verification` | Público (3/60s) | Reenvia e-mail de confirmação |
| `POST` | `/auth/forgot-password` | Público (3/60s) | Envia link de redefinição de senha |
| `POST` | `/auth/reset-password` | Público (5/60s) | Atualiza senha via token e incrementa `sessionVersion` |
| `POST` | `/auth/change-password` | `JwtAuthGuard` | Altera a senha do usuário autenticado e revoga sessões antigas |
| `POST` | `/auth/email-change/request` | `JwtAuthGuard` | Valida senha e envia código para troca de e-mail |
| `POST` | `/auth/email-change/confirm` | `JwtAuthGuard` | Confirma código e atualiza o e-mail da conta |
| `GET` | `/auth/google` | Público (15/60s) | Redireciona para o consentimento do Google OAuth |
| `GET` | `/auth/google/callback` | Público (15/60s) | Valida `state`, vincula/cria conta Google e grava cookies de sessão |

### Perfis (`/profiles`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/profiles/me` | `JwtAuthGuard` | Retorna o perfil completo do usuário autenticado |
| `PUT` | `/profiles/onboarding` | `JwtAuthGuard` | Define `username`, `@handle` e `avatarUrl` no primeiro acesso |
| `PATCH` | `/profiles/me/look` | `JwtAuthGuard` | Atualiza aparência pública (`username`, `bio`, `handle`, `avatarUrl`, `bannerHeroId`, `bannerImage`, `socialLinks`) |
| `PATCH` | `/profiles/me/settings` | `JwtAuthGuard` | Atualiza configurações (`username`, `steamId`, `profileColor`, `favoriteHeroId`, `bannerHeroId`, `bannerImage`, `socialLinks`) |
| `GET` | `/profiles/community` | `OptionalJwtAuthGuard` | Lista/pesquisa perfis públicos da comunidade |
| `GET` | `/profiles/by-handle/:handle` | `OptionalJwtAuthGuard` | Retorna perfil público pelo `@handle` |

### Tier Lists (`/tier-lists`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/tier-lists` | `OptionalJwtAuthGuard` | Lista tier lists públicas (filtros `?userId=` e `?handle=`) |
| `GET` | `/tier-lists/:id` | `OptionalJwtAuthGuard` | Retorna uma tier list por UUID |
| `POST` | `/tier-lists` | `JwtAuthGuard` | Cria uma nova tier list vinculada ao usuário |
| `PATCH` | `/tier-lists/:id` | `JwtAuthGuard` | Atualiza uma tier list (apenas criador) |
| `DELETE` | `/tier-lists/:id` | `JwtAuthGuard` | Remove uma tier list (criador ou `ADMIN`) |

### Feed da Comunidade (`/feed`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/feed` | `OptionalJwtAuthGuard` | Lista publicações paginadas com comentários e curtidas |
| `POST` | `/feed` | `JwtAuthGuard` (5/60s) | Cria publicação (com moderação de texto/imagem) |
| `DELETE` | `/feed/:id` | `JwtAuthGuard` | Remove publicação (autor ou `ADMIN`) |
| `POST` | `/feed/:id/like` | `JwtAuthGuard` | Alterna curtida na publicação |
| `POST` | `/feed/:id/comments` | `JwtAuthGuard` (10/60s) | Adiciona comentário (com moderação) |
| `DELETE` | `/feed/comments/:commentId` | `JwtAuthGuard` | Remove comentário (autor, dono do post ou `ADMIN`) |

### Amizades (`/friends`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/friends/me` | `JwtAuthGuard` | Lista amigos, solicitações recebidas e enviadas |
| `GET` | `/friends/by-handle/:handle` | `OptionalJwtAuthGuard` | Lista amigos públicos de um perfil (respeitando `friendsPublic`) |
| `POST` | `/friends/requests` | `JwtAuthGuard` | Envia solicitação de amizade |
| `POST` | `/friends/requests/:id/accept` | `JwtAuthGuard` | Aceita solicitação de amizade |
| `DELETE` | `/friends/:id` | `JwtAuthGuard` | Remove amizade ou cancela/recusa solicitação |
| `PATCH` | `/friends/privacy` | `JwtAuthGuard` | Alterna visibilidade pública da lista de amigos |

### Administração (`/admin`)
| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| `GET` | `/admin/overview` | `JwtAuthGuard` + `RolesGuard` (`ADMIN`) | Visão geral de contagens do sistema |
| `GET` | `/admin/users` | `JwtAuthGuard` + `RolesGuard` (`ADMIN`) | Lista paginada de usuários com filtro `?search=` e e-mails mascarados |
| `DELETE` | `/admin/users/:id` | `JwtAuthGuard` + `RolesGuard` (`ADMIN`) | Remove um usuário (exceto o próprio ator) |

---

## Regras de Acesso e Segurança

- **Autenticação (`JwtAuthGuard`):** lê o JWT do cookie `lockpro_session` (ou `Authorization: Bearer`), valida assinatura com `JWT_SECRET` e compara `sv` (`sessionVersion`) com o valor no PostgreSQL, anexando `{ userId, email, role }` em `req.user`.
- **Autorização por Role (`RolesGuard` + `@Roles`):** rotas `/admin/*` exigem `role === "ADMIN"`. Promoção e rebaixamento ocorrem exclusivamente via CLI local (`npm run admin:promote`).
- **Escopo de Dono:** rotas privadas isolam o recurso pelo `user.userId` extraído do JWT.
- **Proteção de Dados Públicos:** rotas públicas não expõem `email`, `passwordHash`, `googleId` ou `steamId`, e a listagem admin mascara e-mails.
- **Rate Limiting (`ThrottlerModule`):** limite global de `60` requisições por `60s` por IP (`trust proxy = 1`), com limites mais restritos em `/auth/*` e `/feed/*`.
- **Validação & Payloads:** `ValidationPipe` global com `whitelist: true`, `forbidNonWhitelisted: true` e `transform: true`; limite de body JSON/urlencoded em `2mb`.