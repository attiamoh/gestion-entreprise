# Gestion entreprise

Application de gestion d'entreprise tout-en-un : le seul outil ouvert par les employés de 8h à 17h
(e-mails, dossiers, tâches, suivi commercial, RH, comptabilité), intégré à Google Workspace.

Ce dépôt contient le **socle du MVP** :

- sociétés multiples, chacune avec ses départements et sous-départements, créés depuis l'interface ;
- utilisateurs rattachés à une société et un département ;
- moteur de permissions **rôle + portée** (ses données, son département, sa société, tout le groupe) ;
- rôles livrés : Directeur Général (visibilité totale), Administrateur, Responsable de département,
  Collaborateur, plus deux exemples de profils personnalisés (Comptable, Ressources humaines) ;
- connexion Google Workspace (et connexion par e-mail en développement) ;
- journal d'audit de toutes les modifications.

## Démarrer

Prérequis : Node.js 22, Docker (ou un PostgreSQL 16 local).

```bash
cp .env.example apps/api/.env      # puis ajuster JWT_SECRET
docker compose up -d                # PostgreSQL
npm install
npm run db:migrate                  # crée les tables
SEED_ADMIN_EMAIL=vous@entreprise.ci npm run db:seed   # rôles + super admin
npm run dev:api                     # API sur http://localhost:3001
npm run dev:web                     # interface sur http://localhost:3000
```

Connectez-vous ensuite avec l'e-mail du super admin.

## Tests

```bash
npm test
```

Les tests de bout en bout utilisent un schéma PostgreSQL séparé (`e2e`), recréé à chaque exécution.

## Organisation

| Dossier | Contenu |
| --- | --- |
| `apps/api` | API NestJS + Prisma (PostgreSQL) |
| `apps/api/prisma/schema.prisma` | Modèle de données |
| `apps/api/src/permissions` | Catalogue des modules, moteur de permissions, garde d'accès, rôles de départ |
| `apps/web` | Interface Next.js |

## Permissions

Chaque route déclare la permission qu'elle exige :

```ts
@Get()
@RequirePermission('departments', 'read')
list(@CurrentAccess() access: Access) { ... }
```

La garde globale vérifie la session, charge les rôles de l'utilisateur et calcule son accès
(`all`, `scoped` ou refus). Les contrôleurs filtrent ensuite les données avec `scopeWhere()`
et vérifient une cible précise avec `covers()`.

Garde-fous contre l'élévation de privilèges : seul un accès « tout le groupe » peut créer une
société, attribuer ou définir une permission de portée groupe, ou modifier un rôle système ;
personne (hors super admin) ne peut modifier ses propres rôles.

## Suite de la feuille de route

1. E-mails centralisés : synchronisation Gmail (notifications push) et rattachement automatique aux dossiers.
2. Dossiers, CRM, tâches et projets, documents Google.
3. Messagerie interne et RH, puis comptabilité SYSCOHADA et tableaux de bord DG.
