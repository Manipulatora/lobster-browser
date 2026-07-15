import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  BrowserExtensionRef,
  CookieImportDraft,
  CookieImportMode,
  CookieImportSource,
} from '@lobster/shared-types';

export const MAX_PROFILE_EXTENSIONS = 100;
export const MAX_COOKIE_IMPORT_ERRORS = 100;

/** A browser extension reference contains only install metadata, never extension data. */
export class BrowserExtensionRefDto implements BrowserExtensionRef {
  @IsIn(['chrome_web_store', 'unpacked'])
  source!: BrowserExtensionRef['source'];

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;
}

export class CookieImportErrorDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  line?: number;

  @IsString()
  @MaxLength(500)
  message!: string;
}

/**
 * Secret-free cookie import metadata.
 *
 * `rawText` is deliberately absent. With the application's whitelist +
 * forbidNonWhitelisted validation pipe, any request containing raw cookie text is rejected.
 */
export class CookieImportMetadataDto implements Omit<CookieImportDraft, 'rawText'> {
  @IsIn(['merge', 'replace', 'empty'])
  mode!: CookieImportMode;

  @IsOptional()
  @IsIn(['file', 'plain_text'])
  source?: CookieImportSource;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  parsedCount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_COOKIE_IMPORT_ERRORS)
  @ValidateNested({ each: true })
  @Type(() => CookieImportErrorDto)
  errors?: CookieImportErrorDto[];
}
