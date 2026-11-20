import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTournamentMatchDto {
  @IsInt()
  @Min(1)
  round!: number;

  @IsInt()
  @Min(1)
  slot!: number;

  @IsString()
  @Length(1, 50)
  @Transform(trimString)
  teamA!: string;

  @IsString()
  @Length(1, 50)
  @Transform(trimString)
  teamB!: string;
}

export class CreateTournamentDto {
  @IsString()
  @Length(3, 80)
  @Transform(trimString)
  title!: string;

  @IsString()
  @Length(2, 30)
  @Transform(trimString)
  region!: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Transform(trimString)
  prizePool?: string;

  @IsIn(['ONGOING', 'UPCOMING', 'FINISHED'])
  status!: 'ONGOING' | 'UPCOMING' | 'FINISHED';

  @IsOptional()
  @IsInt()
  relevance?: number;

  @IsDateString()
  startsAt!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(32)
  @IsString({ each: true })
  teams!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => CreateTournamentMatchDto)
  matches!: CreateTournamentMatchDto[];
}

export class UpdateMatchResultDto {
  @IsInt()
  @Min(0)
  scoreA!: number;

  @IsInt()
  @Min(0)
  scoreB!: number;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  @Transform(trimString)
  winner?: string;
}

export class PlacePickDto {
  @IsString()
  @Length(1, 50)
  @Transform(trimString)
  pickedTeam!: string;
}