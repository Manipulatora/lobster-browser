import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /auth/register. Validated by the global ValidationPipe. */
export class RegisterDto {
  @IsEmail()
  email!: string;

  // AuthService hashes this with bcrypt (cost 10) before persisting; plaintext is never stored.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;
}
