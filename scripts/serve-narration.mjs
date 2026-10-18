// Local teaching-page preview without starting a Linux debugging session.
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';

const app = Fastify({ logger: true });
const port = Number(process.env.NARRATION_PORT || 13029);
await app.register(staticFiles, {
  root: path.resolve(import.meta.dirname, '../docs/animation'),
  prefix: '/animation/',
});
await app.listen({ host: '127.0.0.1', port });
