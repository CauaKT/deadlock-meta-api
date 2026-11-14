import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class TierRowDto {
  @Transform(trimString)
  @IsString({ message: 'Nome da categoria inválido.' })
  @Length(1, 35, { message: 'Nome da categoria deve ter entre 1 e 35 caracteres.' })
  label!: string;

  @Transform(trimString)
  @IsString({ message: 'Cor inválida.' })
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'Cor do tier deve estar no formato hexadecimal (#RRGGBB).',
  })
  color!: string;

  @IsArray({ message: 'Lista de heróis inválida.' })
  @ArrayMaxSize(200, { message: 'Limite de heróis por categoria excedido.' })
  @IsInt({ each: true, message: 'ID de herói inválido.' })
  @Min(1, { each: true, message: 'ID de herói deve ser positivo.' })
  heroes!: number[];
}

export class CreateTierListDto {
  @Transform(trimString)
  @IsString({ message: 'Título inválido.' })
  @Length(1, 80, { message: 'Título deve ter entre 1 e 80 caracteres.' })
  title!: string;

  @IsArray({ message: 'Tiers inválidos.' })
  @ArrayMinSize(1, { message: 'A tier list precisa ter pelo menos 1 categoria.' })
  @ArrayMaxSize(20, { message: 'A tier list pode ter no máximo 20 categorias.' })
  @ValidateNested({ each: true })
  @Type(() => TierRowDto)
  tiers!: TierRowDto[];
}

export class UpdateTierListDto extends CreateTierListDto {}