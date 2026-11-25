import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
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

export class TierQuadrantItemDto {
  @IsInt({ message: 'ID de herói inválido.' })
  @Min(1, { message: 'ID de herói deve ser positivo.' })
  heroId!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'Posição X inválida.' })
  @Min(0, { message: 'Posição X deve estar entre 0 e 100.' })
  @Max(100, { message: 'Posição X deve estar entre 0 e 100.' })
  x!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'Posição Y inválida.' })
  @Min(0, { message: 'Posição Y deve estar entre 0 e 100.' })
  @Max(100, { message: 'Posição Y deve estar entre 0 e 100.' })
  y!: number;
}

export class TierQuadrantDto {
  @ValidateIf((o: TierQuadrantDto) => !Array.isArray(o.axes) || o.axes.length === 0)
  @Transform(trimString)
  @IsString({ message: 'Rótulo superior inválido.' })
  @Length(1, 35, { message: 'Rótulo superior deve ter entre 1 e 35 caracteres.' })
  topLabel?: string;

  @ValidateIf((o: TierQuadrantDto) => !Array.isArray(o.axes) || o.axes.length === 0)
  @Transform(trimString)
  @IsString({ message: 'Rótulo inferior inválido.' })
  @Length(1, 35, { message: 'Rótulo inferior deve ter entre 1 e 35 caracteres.' })
  bottomLabel?: string;

  @ValidateIf((o: TierQuadrantDto) => !Array.isArray(o.axes) || o.axes.length === 0)
  @Transform(trimString)
  @IsString({ message: 'Rótulo esquerdo inválido.' })
  @Length(1, 35, { message: 'Rótulo esquerdo deve ter entre 1 e 35 caracteres.' })
  leftLabel?: string;

  @ValidateIf((o: TierQuadrantDto) => !Array.isArray(o.axes) || o.axes.length === 0)
  @Transform(trimString)
  @IsString({ message: 'Rótulo direito inválido.' })
  @Length(1, 35, { message: 'Rótulo direito deve ter entre 1 e 35 caracteres.' })
  rightLabel?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((v) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  @IsArray({ message: 'Eixos do gráfico inválidos.' })
  @ArrayMinSize(3, { message: 'O gráfico precisa ter pelo menos 3 pontas.' })
  @ArrayMaxSize(10, { message: 'O gráfico pode ter no máximo 10 pontas.' })
  @IsString({ each: true, message: 'Rótulo de eixo inválido.' })
  @Length(1, 35, { each: true, message: 'Cada rótulo deve ter entre 1 e 35 caracteres.' })
  axes?: string[];

  @IsArray({ message: 'Itens do gráfico 2D inválidos.' })
  @ArrayMaxSize(200, { message: 'Limite de heróis no gráfico excedido.' })
  @ValidateNested({ each: true })
  @Type(() => TierQuadrantItemDto)
  items!: TierQuadrantItemDto[];
}

export class CreateTierListDto {
  @Transform(trimString)
  @IsString({ message: 'Título inválido.' })
  @Length(1, 80, { message: 'Título deve ter entre 1 e 80 caracteres.' })
  title!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString({ message: 'Descrição inválida.' })
  @MaxLength(280, { message: 'Descrição deve ter no máximo 280 caracteres.' })
  description?: string | null;

  @IsOptional()
  @IsIn(['classic', 'quadrant'], { message: 'Estilo de tier list inválido.' })
  style?: 'classic' | 'quadrant';

  @IsArray({ message: 'Tiers inválidos.' })
  @ValidateIf((o: CreateTierListDto) => o.style !== 'quadrant')
  @ArrayMinSize(1, { message: 'A tier list precisa ter pelo menos 1 categoria.' })
  @ArrayMaxSize(20, { message: 'A tier list pode ter no máximo 20 categorias.' })
  @ValidateNested({ each: true })
  @Type(() => TierRowDto)
  tiers!: TierRowDto[];

  @ValidateIf((o: CreateTierListDto) => o.style === 'quadrant')
  @IsDefined({ message: 'Dados do gráfico 2D são obrigatórios.' })
  @IsObject({ message: 'Dados do gráfico 2D inválidos.' })
  @ValidateNested()
  @Type(() => TierQuadrantDto)
  quadrant?: TierQuadrantDto;
}

export class UpdateTierListDto extends CreateTierListDto {}

export class CreateTierListCommentDto {
  @Transform(trimString)
  @IsString({ message: 'O comentário é obrigatório.' })
  @Length(1, 300, { message: 'O comentário deve ter entre 1 e 300 caracteres.' })
  content!: string;
}