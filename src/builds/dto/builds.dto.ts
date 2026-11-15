import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class BuildPhasesDto {
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_]+$/, { each: true })
  early: string[];

  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_]+$/, { each: true })
  mid: string[];

  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_]+$/, { each: true })
  late: string[];

  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_]+$/, { each: true })
  situational: string[];
}

export class CreateBuildDto {
  @IsInt()
  @Min(1)
  heroId: number;

  @Transform(trimString)
  @IsString()
  @Length(2, 80, { message: 'O título deve ter entre 2 e 80 caracteres.' })
  title: string;

  @ValidateNested()
  @Type(() => BuildPhasesDto)
  phases: BuildPhasesDto;
}

export class UpdateBuildDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  heroId?: number;

  @Transform(trimString)
  @IsString()
  @Length(2, 80, { message: 'O título deve ter entre 2 e 80 caracteres.' })
  title: string;

  @ValidateNested()
  @Type(() => BuildPhasesDto)
  phases: BuildPhasesDto;
}