import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { resolveAccess } from './access';
import { Action, Module } from './catalog';
import { IS_PUBLIC_KEY, PERMISSION_KEY } from './permissions.decorator';
import { PermissionService } from './permission.service';

/**
 * Garde globale : vérifie le jeton, charge l'utilisateur,
 * puis contrôle la permission demandée par la route.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Connexion requise');

    let userId: string;
    try {
      userId = (await this.jwt.verifyAsync<{ sub: string }>(header.slice(7))).sub;
    } catch {
      throw new UnauthorizedException('Session expirée ou invalide');
    }

    const principal = await this.permissions.loadPrincipal(userId);
    if (!principal) throw new UnauthorizedException('Compte inconnu ou désactivé');
    req.principal = principal;

    const required = this.reflector.getAllAndOverride<{ module: Module; action: Action }>(PERMISSION_KEY, targets);
    if (required) {
      const access = resolveAccess(principal, required.module, required.action);
      if (access.kind === 'none') throw new ForbiddenException('Accès refusé');
      req.access = access;
    }
    return true;
  }
}
