import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const emptyToNull = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  return value;
};

export class CreatePostDto {
  @Transform(trimString)
  @IsString({ message: 'O texto da postagem é obrigatório.' })
  @Length(1, 500, { message: 'A postagem deve ter entre 1 e 500 caracteres.' })
  content: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(400, { message: 'O link da mídia deve ter no máximo 400 caracteres.' })
  @Matches(/^https?:\/\/\S+$/i, {
    message: 'Use apenas links http:// ou https:// (imagens em base64 não são permitidas).',
  })
  mediaUrl?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID('4', { message: 'Tier list inválida.' })
  tierListId?: string | null;
}

export class CreateCommentDto {
  @Transform(trimString)
  @IsString({ message: 'O comentário é obrigatório.' })
  @Length(1, 300, { message: 'O comentário deve ter entre 1 e 300 caracteres.' })
  content: string;
}