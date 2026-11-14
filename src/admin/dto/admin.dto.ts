import { Role } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateUserRoleDto {
  @IsEnum(Role, { message: 'Role inválida. Use USER ou ADMIN.' })
  role: Role;
}

export class AdminResetPasswordDto {
  @IsOptional()
  @IsBoolean()
  letUserChoose?: boolean;

  @ValidateIf((o: AdminResetPasswordDto) => !o.letUserChoose)
  @IsString()
  @MinLength(8, { message: 'A nova senha deve ter pelo menos 8 caracteres.' })
  @MaxLength(128, { message: 'A senha pode ter no máximo 128 caracteres.' })
  newPassword?: string;
}