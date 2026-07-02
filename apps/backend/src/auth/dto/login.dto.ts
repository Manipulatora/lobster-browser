import { IsEmail, IsString } from 'class-validator';

/** Body for POST /auth/login. Validated by the global ValidationPipe. */
export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
