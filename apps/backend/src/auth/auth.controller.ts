import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { AuthService, type AuthResult } from './auth.service';
import { DesktopAuthService } from './desktop-auth.service';
import { DesktopExchangeDto, DesktopGrantDto } from './dto/desktop-auth.dto';
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
  constructor(
    private readonly authService: AuthService,
    private readonly desktopAuth: DesktopAuthService,
  ) {}

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

  /**
   * Mint a one-time code for the desktop launcher's loopback handoff.
   *
   * Called by the WEBSITE, with the user's own web session, after they have signed up or logged
   * in through a `?desktop=1` link. Requires a JWT: this endpoint converts an existing session
   * into a launcher session, so it must never be reachable unauthenticated.
   */
  @Post('desktop/grant')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async desktopGrant(
    @Req() req: AuthenticatedRequest,
    @Body() dto: DesktopGrantDto,
  ): Promise<ApiResponse<{ redirectUrl: string }>> {
    if (!req.user) throw new UnauthorizedException();
    const { redirectUrl } = await this.desktopAuth.issueGrant({
      userId: req.user.id,
      state: dto.state,
      codeChallenge: dto.codeChallenge,
      port: dto.port,
    });
    // Only the redirect URL goes back to the browser. The raw code is embedded in it and nothing
    // else needs it, so there is no reason to hand the page a second copy to mislay.
    return ok({ redirectUrl });
  }

  /**
   * Redeem a desktop authorisation code for a real token. Called by the LAUNCHER over HTTPS.
   *
   * PUBLIC BY NECESSITY — the launcher has no session yet; that is what it is asking for. What
   * stands in for authentication is the code itself, plus the PKCE verifier proving the caller is
   * the same client that started the flow. See DesktopAuthService for the full threat model.
   */
  @Post('desktop/exchange')
  @HttpCode(200)
  async desktopExchange(@Body() dto: DesktopExchangeDto): Promise<ApiResponse<AuthResult>> {
    return ok(await this.desktopAuth.exchange(dto));
  }

  /**
   * Prove ownership of an address.
   *
   * POST, not GET: mail clients and security scanners prefetch links, and a GET here would let a
   * scanner silently consume the single-use token before the human ever clicked it. The web app
   * reads the token from the URL and posts it.
   */
  /**
   * Submit the 6-digit code. AUTHENTICATED: registration already returns a session, and scoping
   * the attempt to that session is what keeps a six-digit code from being sprayed across accounts.
   */
  @Post('verify-email')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async verifyEmail(
    @Req() req: AuthenticatedRequest,
    @Body('code') code: string,
  ): Promise<ApiResponse<User>> {
    if (!req.user) throw new UnauthorizedException();
    // WRAPPED, like every other endpoint. These two returned bare objects, and the web client —
    // which treats a missing `code` as a business failure — reported "request failed" on a call
    // that had in fact succeeded and already stamped the account verified.
    return ok(await this.authService.verifyEmail(req.user.id, String(code ?? '')));
  }

  /** Re-send a code. Always 200 — see `resendVerification` for why it cannot report the truth. */
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@Body('email') email: string): Promise<ApiResponse<{ sent: true }>> {
    await this.authService.resendVerification(String(email ?? ''));
    return ok({ sent: true });
  }
}
