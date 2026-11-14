import type { Role } from '@prisma/client';

export const SESSION_COOKIE_NAME = 'lockpro_session';
export const ACCOUNTS_COOKIE_NAME = 'lockpro_accounts';
export const OAUTH_STATE_COOKIE_NAME = 'lockpro_oauth_state';

export interface SavedAccountView {
  id: string;
  email: string;
  username: string | null;
  handle: string | null;
  avatarUrl: string | null;
  isCurrent: boolean;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  role: Role;
  sv: number;
}