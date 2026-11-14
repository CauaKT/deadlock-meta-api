import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.types';
import { PrismaService } from '../src/prisma/prisma.service';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-minimum-32-characters';

describe('LockPro API (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;

  const mockUsers = new Map<
    string,
    { id: string; email: string; role: Role; sessionVersion: number; passwordHash: string | null }
  >([
    [
      '11111111-1111-4111-8111-111111111111',
      {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'user@lockpro.test',
        role: Role.USER,
        sessionVersion: 1,
        passwordHash: null,
      },
    ],
    [
      '22222222-2222-4222-8222-222222222222',
      {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'admin@lockpro.test',
        role: Role.ADMIN,
        sessionVersion: 1,
        passwordHash: null,
      },
    ],
  ]);

  const prismaMock = {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return mockUsers.get(where.id) ?? null;
        if (where.email) {
          for (const u of mockUsers.values()) {
            if (u.email === where.email) return u;
          }
        }
        return null;
      }),
      count: jest.fn().mockResolvedValue(2),
    },
    profile: {
      count: jest.fn().mockResolvedValue(2),
    },
    tierList: {
      count: jest.fn().mockResolvedValue(1),
    },
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health retorna status ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('POST /auth/register rejeita senha menor que 8 caracteres (400)', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'novo@lockpro.test', password: '123', username: 'Kaito' })
      .expect(400);
  });

  it('POST /auth/login rejeita credenciais inválidas (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'naoexiste@lockpro.test', password: 'Password123' })
      .expect(401);
  });

  it('Rotas privadas de /profiles exigem autenticação (401)', async () => {
    await request(app.getHttpServer()).get('/profiles/me').expect(401);
    await request(app.getHttpServer())
      .put('/profiles/onboarding')
      .send({ username: 'Kaito', handle: 'kaito' })
      .expect(401);
    await request(app.getHttpServer())
      .patch('/profiles/me/look')
      .send({ username: 'Kaito' })
      .expect(401);
  });

  it('GET /admin/overview bloqueia visitante (401) e USER comum (403), liberando ADMIN (200)', async () => {
    await request(app.getHttpServer()).get('/admin/overview').expect(401);

    const userToken = await jwtService.signAsync({
      sub: '11111111-1111-4111-8111-111111111111',
      role: Role.USER,
      sv: 1,
    });
    await request(app.getHttpServer())
      .get('/admin/overview')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${userToken}`)
      .expect(403);

    const adminToken = await jwtService.signAsync({
      sub: '22222222-2222-4222-8222-222222222222',
      role: Role.ADMIN,
      sv: 1,
    });
    const res = await request(app.getHttpServer())
      .get('/admin/overview')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${adminToken}`)
      .expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('Rejeita token com sessionVersion (sv) revogado (401)', async () => {
    const staleToken = await jwtService.signAsync({
      sub: '11111111-1111-4111-8111-111111111111',
      role: Role.USER,
      sv: 0,
    });
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${staleToken}`)
      .expect(401);
  });
});