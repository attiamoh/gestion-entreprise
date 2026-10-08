import { BadRequestException, Body, Controller, ForbiddenException, Get, Module, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsEmail, IsString } from 'class-validator';
import { OAuth2Client } from 'google-auth-library';
import { Principal, widestScope } from '../permissions/access';
import { ACTIONS, MODULES } from '../permissions/catalog';
import { CurrentUser, Public } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

class GoogleLoginDto {
  @IsString()
  idToken: string;
}

class DevLoginDto {
  @IsEmail()
  email: string;
}

@Controller('auth')
export class AuthController {
  private readonly google = new OAuth2Client();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Connexion avec un compte Google Workspace.
   * Le compte doit avoir été créé au préalable par un admin.
   */
  @Public()
  @Post('google')
  async google_(@Body() dto: GoogleLoginDto) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new BadRequestException('GOOGLE_CLIENT_ID non configuré');

    const ticket = await this.google.verifyIdToken({ idToken: dto.idToken, audience: clientId }).catch(() => null);
    const payload = ticket?.getPayload();
    if (!payload?.email || !payload.email_verified) throw new UnauthorizedException('Jeton Google invalide');

    const domain = process.env.GOOGLE_ALLOWED_DOMAIN;
    if (domain && payload.hd !== domain) throw new ForbiddenException(`Seuls les comptes @${domain} sont acceptés`);

    const user = await this.prisma.user.findUnique({ where: { email: payload.email.toLowerCase() } });
    if (!user || !user.isActive) throw new ForbiddenException("Ce compte n'a pas accès à l'application");
    if (!user.googleSub) await this.prisma.user.update({ where: { id: user.id }, data: { googleSub: payload.sub } });

    return this.issue(user.id);
  }

  /** Connexion de développement par simple e-mail, désactivée en production. */
  @Public()
  @Post('dev-login')
  async devLogin(@Body() dto: DevLoginDto) {
    if (process.env.ALLOW_DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Connexion de développement désactivée');
    }
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!user || !user.isActive) throw new UnauthorizedException('Compte inconnu');
    return this.issue(user.id);
  }

  /** Profil connecté et matrice de ses droits (portée la plus large par module et action). */
  @Get('me')
  me(@CurrentUser() principal: Principal) {
    const permissions: Record<string, Record<string, string | null>> = {};
    for (const module of MODULES) {
      permissions[module] = {};
      for (const action of ACTIONS) permissions[module][action] = widestScope(principal, module, action);
    }
    return {
      id: principal.id,
      email: principal.email,
      isSuperAdmin: principal.isSuperAdmin,
      companyId: principal.companyId,
      departmentId: principal.departmentId,
      permissions,
    };
  }

  private async issue(userId: string) {
    return { accessToken: await this.jwt.signAsync({ sub: userId }) };
  }
}

@Module({ controllers: [AuthController] })
export class AuthModule {}
