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
- journal d'audit de toutes les modifications ;
- **e-mails centralisés** : toutes les boîtes Gmail nominatives sont synchronisées dans la base,
  rattachées automatiquement aux contacts et aux dossiers, et consultables dans une boîte de
  réception unifiée qui respecte les permissions ;
- dossiers (référence `D-AAAA-NNNN`), entreprises clientes et contacts.

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

## E-mails centralisés

### Fonctionnement

1. Chaque utilisateur actif rattaché à une société reçoit une boîte (`POST /emails/mailboxes/provision`).
2. Gmail prévient l'application à chaque nouveau message (notification push via Pub/Sub) ;
   une relève périodique sert de filet de sécurité.
3. Chaque message est enregistré une seule fois (corps, destinataires, pièces jointes référencées).
4. Le fil est rattaché automatiquement :
   - à un **dossier**, si sa référence (ex. `D-2026-0012`) figure dans l'objet ;
   - à un **contact**, reconnu par son adresse ou par le domaine de son entreprise cliente ;
     si ce client n'a qu'un seul dossier ouvert, le fil y est rattaché.
   Les autres fils restent « à classer ». Un classement fait à la main n'est jamais modifié.
5. Un fil hérite de la société, du département et du propriétaire de la boîte : un collaborateur
   voit ses e-mails, un responsable ceux de son département, le DG tout.

### Mise en place côté Google Workspace

1. Dans Google Cloud, créer un compte de service et une clé JSON ; activer l'API Gmail et Pub/Sub.
2. Dans la console d'administration Google Workspace : Sécurité > Contrôle des API >
   Délégation au niveau du domaine, autoriser l'ID client du compte de service pour le champ
   d'application `https://www.googleapis.com/auth/gmail.readonly`.
3. Créer un sujet Pub/Sub, donner à `gmail-api-push@system.gserviceaccount.com` le rôle
   « Éditeur Pub/Sub » sur ce sujet, puis un abonnement push vers
   `https://<api>/emails/push?token=<GMAIL_PUSH_TOKEN>`.
4. Renseigner `GOOGLE_SERVICE_ACCOUNT`, `GMAIL_PUBSUB_TOPIC` et `GMAIL_PUSH_TOKEN`, puis appeler
   `POST /emails/mailboxes/provision`, `POST /emails/mailboxes/watch` et `POST /emails/sync`.
   L'abonnement push expire après 7 jours : `POST /emails/mailboxes/watch` doit être relancé
   chaque jour (tâche planifiée).

Ces étapes sont à vérifier avec la documentation Google en vigueur au moment de la mise en place.

## Organisation

| Dossier | Contenu |
| --- | --- |
| `apps/api` | API NestJS + Prisma (PostgreSQL) |
| `apps/api/prisma/schema.prisma` | Modèle de données |
| `apps/api/src/permissions` | Catalogue des modules, moteur de permissions, garde d'accès, rôles de départ |
| `apps/api/src/emails` | Client Gmail, synchronisation, rattachement automatique |
| `apps/api/src/cases`, `apps/api/src/crm` | Dossiers, entreprises clientes, contacts |
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

1. Réponse et envoi d'e-mails depuis l'application, archivage des pièces jointes.
2. Dossiers, CRM, tâches et projets, documents Google.
3. Messagerie interne et RH, puis comptabilité SYSCOHADA et tableaux de bord DG.
