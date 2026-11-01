export interface StoredUser {
  id: string;
  name: string;
  email: string;
  org_id: string;
  org_name: string;
  role: string;
}

const TOKEN_KEY = 'ai-delivery-token';
const USER_KEY = 'ai-delivery-user';

const storage = () => (typeof window === 'undefined' ? null : window.localStorage);

export const getToken = (): string | null => storage()?.getItem(TOKEN_KEY) ?? null;

export const getStoredUser = (): StoredUser | null => {
  const raw = storage()?.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
};

export const setAuth = (token: string, user: StoredUser) => {
  storage()?.setItem(TOKEN_KEY, token);
  storage()?.setItem(USER_KEY, JSON.stringify(user));
};

export const setStoredUser = (user: StoredUser) => {
  storage()?.setItem(USER_KEY, JSON.stringify(user));
};

export const clearAuth = () => {
  storage()?.removeItem(TOKEN_KEY);
  storage()?.removeItem(USER_KEY);
};

export const authHeaders = (): Record<string, string> => {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};
