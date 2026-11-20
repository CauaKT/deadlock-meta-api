import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Length,
  Min,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateLfgDto {
  @IsIn(['SAmerica', 'NAmerica', 'Europe', 'Asia', 'Oceania'])
  region!: string;

  @IsString()
  @Length(2, 40)
  @Transform(trimString)
  rankTier!: string;

  @IsIn(['duo', 'team', 'tournament'])
  mode!: string;

  @IsArray()
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(1, { each: true })
  heroIds!: number[];

  @IsString()
  @Length(3, 300)
  @Transform(trimString)
  note!: string;
}