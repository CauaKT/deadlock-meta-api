import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

const trimValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8, { message: 'A senha precisa ter pelo menos 8 caracteres.' })
  @MaxLength(128, { message: 'A senha deve ter no máximo 128 caracteres.' })
  password: string;

  @Transform(trimValue)
  @IsString()
  @Length(3, 20, { message: 'O nome de usuário deve ter entre 3 e 20 caracteres.' })
  @Matches(/^[a-zA-Z0-9_\-\s]+$/, {
    message: 'O nick não pode conter caracteres especiais além de traço e sublinhado.',
  })
  username: string;
}

export class LoginDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  email: string;

  @IsString()
  @MinLength(1, { message: 'Informe sua senha.' })
  @MaxLength(128)
  password: string;
}

export class VerifyEmailDto {
  @Transform(trimValue)
  @IsString()
  @MinLength(16, { message: 'Token inválido.' })
  token: string;
}

export class EmailOnlyDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  email: string;
}

export class ResetPasswordDto {
  @Transform(trimValue)
  @IsString()
  @MinLength(16, { message: 'Token inválido.' })
  token: string;

  @IsString()
  @MinLength(8, { message: 'A senha precisa ter pelo menos 8 caracteres.' })
  @MaxLength(128, { message: 'A senha deve ter no máximo 128 caracteres.' })
  newPassword: string;
}

export class SwitchAccountDto {
  @IsUUID(undefined, { message: 'ID de conta inválido.' })
  userId: string;
}

export class ChangePasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;

  @IsString()
  @MinLength(8, { message: 'A senha precisa ter pelo menos 8 caracteres.' })
  @MaxLength(128, { message: 'A senha deve ter no máximo 128 caracteres.' })
  newPassword: string;
}

export class RequestEmailChangeDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(254)
  newEmail: string;

  @IsString()
  @MinLength(1, { message: 'Informe sua senha.' })
  @MaxLength(128)
  password: string;
}

export class ConfirmEmailChangeDto {
  @Transform(trimValue)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'O código tem 6 dígitos.' })
  code: string;
}