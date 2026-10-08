import { ForbiddenException, NotFoundException } from '@nestjs/common';

export const notFound = (what: string) => new NotFoundException(`${what} introuvable`);
export const forbidden = (why = 'Accès refusé') => new ForbiddenException(why);
