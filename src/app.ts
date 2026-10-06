import Fastify, { type FastifyInstance } from 'fastify';
import { AliasTakenError, InvalidAliasError, InvalidUrlError, type Link, type LinkService } from './links.js';
import { isSlug } from './slug.js';

export interface AppDeps {
  links: LinkService;
  baseUrl: string;
  logger?: boolean;
}

const createBody = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    alias: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** The HTTP API. Dependencies come in, so tests build it against their own database and cache. */
export function buildApp({ links, baseUrl, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger });
  const view = (link: Link) => ({ ...link, shortUrl: `${baseUrl}/${link.slug}` });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post<{ Body: { url: string; alias?: string } }>(
    '/links',
    { schema: { body: createBody } },
    async (request, reply) => {
      try {
        const link = await links.create(request.body.url, request.body.alias);
        return reply.code(201).send(view(link));
      } catch (err) {
        if (err instanceof InvalidUrlError) return reply.code(400).send({ error: err.message });
        if (err instanceof InvalidAliasError) return reply.code(400).send({ error: err.message });
        if (err instanceof AliasTakenError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get<{ Params: { slug: string } }>('/links/:slug', async (request, reply) => {
    const { slug } = request.params;
    const link = isSlug(slug) ? await links.get(slug) : null;
    if (!link) return reply.code(404).send({ error: 'Link not found' });
    return view(link);
  });

  app.get<{ Params: { slug: string } }>('/:slug', async (request, reply) => {
    const { slug } = request.params;
    const url = isSlug(slug) ? await links.resolve(slug) : null;
    if (!url) return reply.code(404).send({ error: 'Link not found' });
    return reply.redirect(url, 302);
  });

  return app;
}
