'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'ge.token';

export const getToken = () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY));
export const setToken = (token: string | null) =>
  token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Appel à l'API avec le jeton de session ; renvoie vers la connexion si la session a expiré. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    setToken(null);
    window.location.href = '/login';
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
    throw new ApiError(res.status, message ?? 'Erreur inattendue');
  }
  return data as T;
}

export type Scope = 'OWN' | 'DEPARTMENT' | 'COMPANY' | 'ALL';

export interface Me {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  companyId: string | null;
  departmentId: string | null;
  permissions: Record<string, Record<string, Scope | null>>;
}

export interface Company {
  id: string;
  name: string;
  legalForm: string | null;
  rccm: string | null;
  taxId: string | null;
  country: string;
  currency: string;
  isActive: boolean;
  _count: { departments: number; users: number };
}

export interface Department {
  id: string;
  companyId: string;
  name: string;
  code: string | null;
  parentId: string | null;
  manager: { id: string; fullName: string } | null;
  _count: { members: number; children: number };
}

export const can = (me: Me | null, module: string, action: string) => Boolean(me?.permissions[module]?.[action]);

export interface ThreadSummary {
  id: string;
  subject: string;
  lastMessageAt: string;
  linkedBy: string | null;
  owner: { id: string; fullName: string };
  case: { id: string; reference: string; title: string } | null;
  contact: { id: string; email: string; fullName: string | null } | null;
  messages: { fromEmail: string; fromName: string | null; snippet: string; sentAt: string; direction: 'INBOUND' | 'OUTBOUND' }[];
  _count: { messages: number };
}

export interface EmailMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  fromEmail: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  sentAt: string;
  attachments: { id: string; filename: string; size: number }[];
}

export interface ThreadDetail extends Omit<ThreadSummary, 'messages' | '_count' | 'contact'> {
  owner: { id: string; fullName: string; email: string };
  contact: { id: string; email: string; fullName: string | null; clientAccount: { id: string; name: string } | null } | null;
  messages: EmailMessage[];
}

export interface CaseSummary {
  id: string;
  reference: string;
  title: string;
  status: 'OPEN' | 'ON_HOLD' | 'CLOSED';
  clientAccount: { id: string; name: string } | null;
}
