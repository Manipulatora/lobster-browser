import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import {
  AuthService,
  type AuthResult,
  type PendingRegistrationResult,
} from './auth.service';
import { DesktopAuthService } from './desktop-auth.service';
import { DesktopExchangeDto, DesktopGrantDto } from './dto/desktop-auth.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto, ResendVerificationDto, VerifyEmailDto } from './dto/register.dto';
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

  /**
   * Begin a sign-up. Returns an acknowledgement, NOT a session.
   *
   * No account exists at this point — the credentials are held as a pending registration until the
   * emailed code is submitted to `verify-email`. A client must not treat this response as a
   * sign-in; the return type makes that a compile error rather than a subtle bug.
   */
  @Post('register')
  async register(@Body() dto: RegisterDto): Promise<ApiResponse<PendingRegistrationResult>> {
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
   * Submit the 6-digit code. THIS is what creates the account, and it returns the session.
   *
   * PUBLIC, and it has to be: registration no longer issues a token, so there is no session to
   * authenticate with at this point — establishing one is the whole purpose of the call. What
   * bounds guessing is the attempt counter on the pending row, not a guard here; see
   * `consumePendingRegistration`.
   */
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<ApiResponse<AuthResult>> {
    // WRAPPED, like every other endpoint. This used to return a bare object, and the web client —
    // which treats a missing `code` field as a business failure — reported "request failed" on a
    // call that had in fact succeeded.
    return ok(await this.authService.completeRegistration(dto.email, dto.code));
  }

  /**
   * Re-send the code for a sign-up in flight.
   *
   * Always 200, whether or not a pending sign-up exists for that address: reporting the truth would
   * turn this into an oracle for which addresses are mid-registration.
   */
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<ApiResponse<{ sent: true }>> {
    await this.authService.resendRegistrationCode(dto.email);
    return ok({ sent: true });
  }

  /**
   * Prove the address on an EXISTING, signed-in account.
   *
   * Distinct from `verify-email`, which completes a sign-up and has no session to work from. This
   * one is for accounts created before verification gated account creation: they exist, they are
   * signed in, and their address was never proven — so the deposit path is shut to them. The
   * session identifies the account, which is what keeps a six-digit code from being sprayed across
   * every account at once.
   */
  @Post('verify-email/session')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async verifyExistingEmail(
    @Req() req: AuthenticatedRequest,
    @Body('code') code: string,
  ): Promise<ApiResponse<User>> {
    if (!req.user) throw new UnauthorizedException();
    return ok(await this.authService.verifyExistingEmail(req.user.id, String(code ?? '')));
  }

  /** Re-send a code to the signed-in user's own address. */
  @Post('resend-verification/session')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async resendExistingVerification(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<{ sent: true }>> {
    if (!req.user) throw new UnauthorizedException();
    await this.authService.resendVerificationForUser(req.user.id);
    return ok({ sent: true });
  }
}
