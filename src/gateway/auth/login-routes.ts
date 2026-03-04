/**
 * Login routes — email + password authentication (LastPass-style).
 *
 * POST /signup — create a new account (only if no users exist)
 * POST /login  — authenticate with email + password
 *
 * Separate from src/auth/oauth-routes.ts which handles source
 * connections (Gmail API, GitHub API).
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { hashSync, compareSync } from 'bcryptjs';
import type { DataStore } from '../../database/datastore.js';

interface LoginDeps {
  store: DataStore;
}

export function createLoginRoutes(deps: LoginDeps): Hono {
  const app = new Hono();

  app.post('/signup', async (c) => {
    const body = await c.req.json<{ email?: string; password?: string }>();
    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!email || !password) {
      return c.json({ ok: false, error: 'Email and password are required' }, 400);
    }

    if (password.length < 8) {
      return c.json({ ok: false, error: 'Password must be at least 8 characters' }, 400);
    }

    // Only allow signup if no users exist (first-user-claims)
    const userCount = await deps.store.getUserCount();
    if (userCount > 0) {
      return c.json({ ok: false, error: 'An account already exists. Please sign in.' }, 409);
    }

    const passwordHash = hashSync(password, 10);
    await deps.store.createUser(email, passwordHash);

    // Create session
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await deps.store.createSession(token, expiresAt);

    c.header('Set-Cookie', `pdh_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return c.json({ ok: true });
  });

  app.post('/login', async (c) => {
    const body = await c.req.json<{ email?: string; password?: string }>();
    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!email || !password) {
      return c.json({ ok: false, error: 'Email and password are required' }, 400);
    }

    const user = await deps.store.getUserByEmail(email);
    if (!user || !compareSync(password, user.password_hash)) {
      return c.json({ ok: false, error: 'Invalid email or password' }, 401);
    }

    // Create session
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await deps.store.createSession(token, expiresAt);

    c.header('Set-Cookie', `pdh_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return c.json({ ok: true });
  });

  return app;
}
