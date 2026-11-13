import { Role } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateUserRoleDto {
  @IsEnum(Role, { message: 'Role inválida. Use USER ou ADMIN.' })
  role: Role;
}