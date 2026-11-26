import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

/** The methods that change something, which only the web app's origin may send. */
const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What the OpenAPI document says about the API, beside its routes. */
const DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Consola Cloud API',
    version: '0',
    description:
      'Who is signed in, their workspaces, and what each workspace holds. Sign-in itself is ' +
      'Better Auth’s, under /api/auth, and is not described here.',
  },
};

/**
 * The one HTTP app, with what stands in front of every route, before any part registers its
 * own. Every route sits under `/api`, which the web app proxies to this service.
 *
 * - A body of the wrong shape is 400 `invalid_request` unless its route says otherwise
 *   (`defaultHook`), never the validator's own answer, which is not in the contract.
 * - A body that is not JSON is 400 `invalid_request`, and one without a JSON content type 415
 *   `unsupported_media_type`: the validator throws on both before any route's hook sees them.
 *   Any other error is logged and is a bare 500.
 * - A change (POST, PUT, PATCH, DELETE) must come from the web app's origin (`publicUrl`), or it
 *   is 403 `bad_origin` before its route runs: the session cookie is SameSite=Lax, which another
 *   site on the same host (any other localhost port) would still be sent. Better Auth's own
 *   routes are behind it too, besides Better Auth's own origin check. Only the paths in
 *   `originExempt`, exactly as written, are outside it: a caller that signs what it sends
 *   instead of carrying a cookie (GitHub's webhooks).
 */
export function createFrontDoor(options: {
  publicUrl: string;
  originExempt: readonly string[];
}): OpenAPIHono {
  const { publicUrl } = options;
  const exempt = new Set(options.originExempt);

  const app = new OpenAPIHono({
    defaultHook: (result, c) =>
      result.success ? undefined : c.json({ error: 'invalid_request' } as const, 400),
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ error: 'invalid_request' } as const, 400);
    }
    if (error instanceof HTTPException && error.status === 415) {
      return c.json({ error: 'unsupported_media_type' } as const, 415);
    }
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return c.text('Internal Server Error', 500);
  });

  app.use('/api/*', async (c, next) => {
    if (!CHANGES.has(c.req.method) || exempt.has(c.req.path)) return next();
    if (c.req.header('origin') === publicUrl) return next();
    return c.json({ error: 'bad_origin' } as const, 403);
  });

  return app;
}

/** The OpenAPI document of the app's contract, as `openapi.json` holds it. */
export function describeApi(app: OpenAPIHono) {
  return app.getOpenAPI31Document(DOCUMENT);
}
