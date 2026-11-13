import type { Role } from '@prisma/client';

export const SESSION_COOKIE_NAME = 'lockpro_session';
export const OAUTH_STATE_COOKIE_NAME = 'lockpro_oauth_state';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  role: Role;
}