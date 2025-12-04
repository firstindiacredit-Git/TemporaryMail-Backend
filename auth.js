// Simple frontend auth using localStorage (no real backend)

const STORAGE_KEY = 'tempMail_user';

export function getCurrentUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function login({ email, password }) {
  const existing = getCurrentUser();
  const user = { 
    email,
    password: password || existing?.password,
    avatar: existing?.avatar
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  return user;
}

export function signup({ email, password }) {
  const user = { email, password, avatar: null };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  return user;
}

export function updateUser(updates) {
  const current = getCurrentUser();
  if (!current) return null;
  const updated = { ...current, ...updates };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY);
}


