import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /auth/register. Validated by the global ValidationPipe. */
export class RegisterDto {
  /**
   * The provider restriction (Gmail / Outlook only) is NOT expressed here.
   *
   * `@IsEmail` checks shape; which providers are acceptable is a product rule that belongs with the
   * rest of the sign-up logic, in AuthService, where it can return a sentence a person can act on
   * rather than a validation-pipe array. It is enforced server-side either way — see
   * `assertAllowedEmailProvider`.
   */
  @IsEmail()
  email!: string;

  // AuthService hashes this with bcrypt (cost 10) before persisting; plaintext is never stored.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  /** The person's name, as they wrote it. Required at sign-up. */
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  fullName!: string;

  /**
   * Organisation. Optional on the wire even though the form asks for it: someone signing up as an
   * individual has nothing truthful to put here, and a required field only teaches them to type a
   * dash.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  company?: string;
}

/** Body for POST /auth/verify-email — the step that actually creates the account. */
export class VerifyEmailDto {
  /** Which pending sign-up this code belongs to. There is no session yet to infer it from. */
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;
}

/** Body for POST /auth/resend-verification. */
export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}
