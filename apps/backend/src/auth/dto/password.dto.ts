import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './register.dto';

/** Body for POST /auth/password — a signed-in user replacing their own password. */
export class ChangePasswordDto {
  /**
   * Proof that the caller is the account's owner and not merely the holder of its token. No length
   * rule: it is compared against a hash, and whatever the account has is what must match.
   */
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

/** Body for POST /auth/password/forgot. */
export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

/** Body for POST /auth/password/reset — the step that actually changes the password. */
export class ResetPasswordDto {
  /** Which account the code was mailed for. There is no session to infer it from. */
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
