import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Principal } from './access';

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Charge l'utilisateur, ses rôles et l'arbre de son département. */
  async loadPrincipal(userId: string): Promise<Principal | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: { include: { permissions: true } } } } },
    });
    if (!user || !user.isActive) return null;

    const grants = user.roles.flatMap((ur) =>
      ur.role.permissions.map((p) => ({
        module: p.module,
        action: p.action,
        scope: p.scope,
        companyId: ur.companyId,
      })),
    );

    return {
      id: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
      companyId: user.companyId,
      departmentId: user.departmentId,
      departmentIds: user.departmentId ? await this.descendants(user.departmentId) : [],
      grants,
    };
  }

  /** Le département et tous ses sous-départements. */
  async descendants(departmentId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM "Department" WHERE id = ${departmentId}
        UNION ALL
        SELECT d.id FROM "Department" d JOIN tree t ON d."parentId" = t.id
      )
      SELECT id FROM tree`;
    return rows.map((r) => r.id);
  }
}
