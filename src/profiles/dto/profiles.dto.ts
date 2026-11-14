import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const SAFE_IMAGE_REGEX =
  /^(https:\/\/.+|data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+)$/i;

const SAFE_DATA_IMAGE_REGEX =
  /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i;

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const emptyToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const normalizeHandle = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
};

export class SocialLinksDto {
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(120, { message: 'Link da Steam muito longo.' })
  steam?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(120, { message: 'Usuário/link do X (Twitter) muito longo.' })
  twitter?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(120, { message: 'Usuário/link do Instagram muito longo.' })
  instagram?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(64, { message: 'Usuário/convite do Discord muito longo.' })
  discord?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(120, { message: 'Canal/link do YouTube muito longo.' })
  youtube?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(120, { message: 'Canal/link da Twitch muito longo.' })
  twitch?: string | null;
}

export class OnboardingDto {
  @Transform(trimString)
  @IsString()
  @Length(3, 20, { message: 'O apelido deve ter entre 3 e 20 caracteres.' })
  @Matches(/^[a-zA-Z0-9_\-\s]+$/, {
    message: 'O apelido só pode conter letras, números, espaços, traço e sublinhado.',
  })
  username: string;

  @Transform(normalizeHandle)
  @IsString({ message: 'Informe um @ válido.' })
  @Matches(/^[a-z0-9_]{3,20}$/, {
    message: 'O @ deve ter de 3 a 20 caracteres (minúsculas, números e _).',
  })
  handle: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(600_000, { message: 'Imagem de avatar excede o tamanho permitido.' })
  @Matches(SAFE_IMAGE_REGEX, { message: 'Formato de avatar inválido.' })
  avatarUrl?: string | null;
}

export class UpdateProfileLookDto {
  @Transform(trimString)
  @IsString()
  @Length(3, 20, { message: 'O apelido deve ter entre 3 e 20 caracteres.' })
  @Matches(/^[a-zA-Z0-9_\-\s]+$/, {
    message: 'O apelido só pode conter letras, números, espaços, traço e sublinhado.',
  })
  username: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(160, { message: 'A bio deve ter no máximo 160 caracteres.' })
  bio?: string | null;

  @IsOptional()
  @Transform(normalizeHandle)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @Matches(/^[a-z0-9_]{3,20}$/, {
    message: 'O @ deve ter de 3 a 20 caracteres (minúsculas, números e _).',
  })
  handle?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(600_000, { message: 'Imagem de avatar excede o tamanho permitido.' })
  @Matches(SAFE_IMAGE_REGEX, { message: 'Formato de avatar inválido.' })
  avatarUrl?: string | null;

  @IsOptional()
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsInt({ message: 'Herói do banner inválido.' })
  @Min(1)
  bannerHeroId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(600_000, { message: 'Imagem de banner excede o tamanho permitido.' })
  @Matches(SAFE_DATA_IMAGE_REGEX, { message: 'Formato de banner inválido.' })
  bannerImage?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Cor de perfil inválida.' })
  profileColor?: string | null;

  @IsOptional()
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @ValidateNested()
  @Type(() => SocialLinksDto)
  socialLinks?: SocialLinksDto | null;
}

export class UpdateProfileSettingsDto {
  @Transform(trimString)
  @IsString()
  @Length(3, 20, { message: 'O apelido deve ter entre 3 e 20 caracteres.' })
  @Matches(/^[a-zA-Z0-9_\-\s]+$/, {
    message: 'O apelido só pode conter letras, números, espaços, traço e sublinhado.',
  })
  username: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(64, { message: 'Steam ID ou código muito longo.' })
  steamId?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Cor de perfil inválida.' })
  profileColor?: string | null;

  @IsOptional()
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsInt({ message: 'Herói favorito inválido.' })
  @Min(1)
  favoriteHeroId?: number | null;

  @IsOptional()
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsInt({ message: 'Herói do banner inválido.' })
  @Min(1)
  bannerHeroId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(600_000, { message: 'Imagem de banner excede o tamanho permitido.' })
  @Matches(SAFE_DATA_IMAGE_REGEX, { message: 'Formato de banner inválido.' })
  bannerImage?: string | null;

  @IsOptional()
  @ValidateIf((_obj, v) => v !== null && v !== undefined)
  @ValidateNested()
  @Type(() => SocialLinksDto)
  socialLinks?: SocialLinksDto | null;
}