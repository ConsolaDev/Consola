import { createRoute, z } from '@hono/zod-openapi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrontDoor, describeApi } from './frontDoor.js';

const WEB = 'http://localhost:5175';
const HOOKS = '/api/hooks';
/** An exempt prefix, as Better Auth's `/api/auth/` is. */
const SIGNED = '/api/signed/';

const NewThing = z.object({ name: z.string() });
const body = {
  body: { content: { 'application/json': { schema: NewThing } }, required: true },
};
const made = {
  content: { 'application/json': { schema: z.strictObject({ name: z.string() }) } },
  description: 'Made.',
};

const postThing = createRoute({
  method: 'post',
  path: '/api/things',
  request: body,
  responses: { 201: made },
});
const putThing = createRoute({
  method: 'put',
  path: '/api/things',
  request: body,
  responses: { 201: made },
});
const listThings = createRoute({
  method: 'get',
  path: '/api/things',
  responses: { 200: { description: 'Listed.' } },
});
const postHook = createRoute({
  method: 'post',
  path: HOOKS,
  responses: { 202: { description: 'Taken.' } },
});
const postBroken = createRoute({
  method: 'post',
  path: '/api/broken',
  responses: { 200: { description: 'Never.' } },
});

/** The front door with a few dummy routes behind it, as a part would register its own. */
function door() {
  const app = createFrontDoor({ publicUrl: WEB, originExempt: [HOOKS, SIGNED] });
  app.openapi(postThing, (c) => c.json({ name: c.req.valid('json').name }, 201));
  app.openapi(putThing, (c) => c.json({ name: c.req.valid('json').name }, 201));
  app.openapi(listThings, (c) => c.body(null, 200));
  app.openapi(postHook, (c) => c.body(null, 202));
  app.openapi(postBroken, () => {
    throw new Error('the route broke');
  });
  app.delete('/api/things', (c) => c.body(null, 204));
  app.patch('/api/things', (c) => c.body(null, 204));
  // Paths under the exempt prefix, and two beside it that are not under it.
  app.all('/api/signed/*', (c) => c.body(null, 202));
  app.all('/api/signed', (c) => c.body(null, 202));
  app.all('/api/signedout/x', (c) => c.body(null, 202));
  return app;
}

const fromWeb = { origin: WEB, 'content-type': 'application/json' };

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});

describe('the front door', () => {
  it('lets a change from the web app through to its route', async () => {
    const response = await door().request('/api/things', {
      method: 'POST',
      headers: fromWeb,
      body: JSON.stringify({ name: 'sprocket' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: 'sprocket' });
  });

  it('answers a body of the wrong shape 400 invalid_request', async () => {
    const response = await door().request('/api/things', {
      method: 'POST',
      headers: fromWeb,
      body: JSON.stringify({ name: 7 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('answers a body that is not JSON 400 invalid_request', async () => {
    const response = await door().request('/api/things', {
      method: 'POST',
      headers: fromWeb,
      body: '{ not json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('answers a body without a JSON content type 415 unsupported_media_type', async () => {
    const response = await door().request('/api/things', {
      method: 'POST',
      headers: { origin: WEB, 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'sprocket' }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'answers a %s from another origin, or none, 403 bad_origin before its route',
    async (method) => {
      for (const origin of ['http://localhost:3000', 'null', null]) {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (origin !== null) headers.set('origin', origin);
        // A body of the wrong shape too: the origin is refused before the body is read.
        const response = await door().request('/api/things', {
          method,
          headers,
          body: JSON.stringify({ name: 7 }),
        });
        expect(response.status, `${method} from ${origin}`).toBe(403);
        expect(await response.json()).toEqual({ error: 'bad_origin' });
      }
    },
  );

  it('lets a read from anywhere through', async () => {
    const response = await door().request('/api/things', {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.status).toBe(200);
  });

  it('lets a change to an exempt path through from anywhere, and only that path', async () => {
    const app = door();
    for (const origin of ['https://github.com', null]) {
      const headers = new Headers();
      if (origin !== null) headers.set('origin', origin);
      expect((await app.request(HOOKS, { method: 'POST', headers })).status).toBe(202);
    }
    const near = await app.request(`${HOOKS}/again`, { method: 'POST' });
    expect(near.status).toBe(403);
    expect(await near.json()).toEqual({ error: 'bad_origin' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'lets a %s to any path under an exempt prefix through from anywhere, and none beside it',
    async (method) => {
      const app = door();
      for (const path of [`${SIGNED}in`, `${SIGNED}callback/google`, `${SIGNED}a/b/c`]) {
        const response = await app.request(path, {
          method,
          headers: { origin: 'http://localhost:3000' },
        });
        expect(response.status, `${method} ${path}`).toBe(202);
      }
      for (const path of ['/api/signed', '/api/signedout/x']) {
        const response = await app.request(path, {
          method,
          headers: { origin: 'http://localhost:3000' },
        });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.json()).toEqual({ error: 'bad_origin' });
      }
    },
  );

  it('answers an error no route handled with a bare 500, and logs it', async () => {
    const response = await door().request('/api/broken', { method: 'POST', headers: fromWeb });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'the route broke' }));
  });

  it("describes the routes behind it in the app's document", () => {
    const document = describeApi(door());
    expect(document.info.title).toBe('Consola Cloud API');
    expect(Object.keys(document.paths ?? {})).toEqual(['/api/things', HOOKS, '/api/broken']);
  });
});
