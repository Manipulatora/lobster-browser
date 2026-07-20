import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import type { PhoneNumberType } from '@lobster/shared-types';

const E164 = /^\+[1-9]\d{6,14}$/;

/** GET /phone/numbers/available — query params. */
export class SearchNumbersDto {
  @IsString()
  @Length(2, 2)
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  country!: string;

  @IsOptional()
  @IsIn(['local', 'mobile', 'tollFree'])
  type?: PhoneNumberType;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,6}$/, { message: 'areaCode must be digits' })
  areaCode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  contains?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  smsEnabled?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  voiceEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** POST /phone/numbers — buy a searched number. */
export class BuyNumberDto {
  @IsString()
  @Matches(E164, { message: 'phoneNumber must be E.164' })
  phoneNumber!: string;
}

/** POST /phone/sms — send a text. */
export class SendSmsDto {
  @IsString()
  @Matches(E164, { message: 'from must be E.164' })
  from!: string;

  @IsString()
  @Matches(E164, { message: 'to must be E.164' })
  to!: string;

  @IsString()
  @Length(1, 1600)
  body!: string;
}

/** GET /phone/sms — history for one owned number. */
export class MessageHistoryDto {
  @IsString()
  @Matches(E164, { message: 'number must be E.164' })
  number!: string;
}
