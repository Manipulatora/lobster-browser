import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { AuthService, type AuthResult } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard, type AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Auth endpoints. Bodies are validated by the global ValidationPipe (whitelist).
 * `register`/`login` are public; `me` is protected by the JWT guard. All responses use
 * the shared `{ code, data, msg }` envelope.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto): Promise<ApiResponse<AuthResult>> {
    return ok(await this.authService.register(dto));
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto): Promise<ApiResponse<AuthResult>> {
    return ok(await this.authService.login(dto));
  }

  /** Current user (password hash already stripped by AuthService). Requires a valid token. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: AuthenticatedRequest): ApiResponse<User> {
    if (!req.user) {
      // Unreachable in practice: the guard rejects unauthenticated requests before this runs.
      throw new UnauthorizedException();
    }
    return ok(req.user);
  }
}
