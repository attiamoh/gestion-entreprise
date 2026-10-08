import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Access, Principal } from './access';
import { Action, Module } from './catalog';

export const PERMISSION_KEY = 'permission';
export const IS_PUBLIC_KEY = 'isPublic';

/** Exige une permission sur un module ; l'accès résolu est injecté avec @CurrentAccess(). */
export const RequirePermission = (module: Module, action: Action) => SetMetadata(PERMISSION_KEY, { module, action });

/** Route accessible sans connexion. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});

export const CurrentAccess = createParamDecorator((_: unknown, ctx: ExecutionContext): Access => {
  return ctx.switchToHttp().getRequest().access;
});
