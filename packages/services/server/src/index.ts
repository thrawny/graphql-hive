#!/usr/bin/env node
import * as fs from 'fs';
import got from 'got';
import { DocumentNode, GraphQLError, stripIgnoredCharacters } from 'graphql';
import 'reflect-metadata';
import { createRegistry, createTaskRunner, CryptoProvider, LogFn, Logger } from '@hive/api';
import { createArtifactRequestHandler } from '@hive/cdn-script/artifact-handler';
import { ArtifactStorageReader } from '@hive/cdn-script/artifact-storage-reader';
import { AwsClient } from '@hive/cdn-script/aws';
import { createIsKeyValid } from '@hive/cdn-script/key-validation';
import {
  createServer,
  registerShutdown,
  registerTRPC,
  reportReadiness,
  startMetrics,
  startSentryTransaction,
} from '@hive/service-common';
import { createConnectionString, createStorage as createPostgreSQLStorage } from '@hive/storage';
import { Dedupe, ExtraErrorData } from '@sentry/integrations';
import { captureException, init, Integrations, SeverityLevel } from '@sentry/node';
import { createServerAdapter } from '@whatwg-node/server';
import { createContext, internalApiRouter } from './api';
import { asyncStorage } from './async-storage';
import { env } from './environment';
import { graphqlHandler } from './graphql-handler';
import { clickHouseElapsedDuration, clickHouseReadDuration } from './metrics';

export async function main() {
  init({
    serverName: 'api',
    enabled: !!env.sentry,
    environment: env.environment,
    dsn: env.sentry?.dsn,
    enableTracing: true,
    tracesSampleRate: 1,
    ignoreTransactions: [
      'POST /graphql', // Transaction created for a cached response (@graphql-yoga/plugin-response-cache)
    ],
    release: env.release,
    integrations: [
      new Integrations.Http({ tracing: true }),
      new Integrations.ContextLines(),
      new Integrations.LinkedErrors(),
      new ExtraErrorData({
        depth: 2,
      }),
      new Dedupe(),
    ],
    maxBreadcrumbs: 5,
    defaultIntegrations: false,
    autoSessionTracking: false,
  });

  const server = await createServer({
    name: 'graphql-api',
    tracing: true,
    log: {
      level: env.log.level,
      requests: env.log.requests,
    },
  });

  server.addContentTypeParser(
    'application/graphql+json',
    { parseAs: 'string' },
    function parseApplicationGraphQLJsonPayload(_req, payload, done) {
      done(null, JSON.parse(payload as unknown as string));
    },
  );

  server.addContentTypeParser(
    'application/graphql',
    { parseAs: 'string' },
    function parseApplicationGraphQLPayload(_req, payload, done) {
      done(null, {
        query: payload,
      });
    },
  );

  const storage = await createPostgreSQLStorage(createConnectionString(env.postgres), 10);

  let dbPurgeTaskRunner: null | ReturnType<typeof createTaskRunner> = null;

  if (!env.hiveServices.usageEstimator) {
    server.log.debug('Usage estimation is disabled. Skip scheduling purge tasks.');
  } else {
    server.log.debug(
      `Usage estimation is enabled. Start scheduling purge tasks every ${env.hiveServices.usageEstimator.dateRetentionPurgeIntervalMinutes} minutes.`,
    );
    dbPurgeTaskRunner = createTaskRunner({
      async run() {
        const transaction = startSentryTransaction({
          op: 'db.purgeTaskRunner',
          name: 'Purge Task',
        });
        try {
          const result = await storage.purgeExpiredSchemaChecks({
            expiresAt: new Date(),
          });
          server.log.debug(
            'Finished running schema check purge task. (deletedSchemaCheckCount=%s deletedSdlStoreCount=%s)',
            result.deletedSchemaCheckCount,
            result.deletedSdlStoreCount,
          );
          transaction.setMeasurement('deletedSchemaCheckCount', result.deletedSchemaCheckCount, '');
          transaction.setMeasurement('deletedSdlStoreCount', result.deletedSdlStoreCount, '');
          transaction.setMeasurement(
            'deletedSchemaChangeApprovals',
            result.deletedSchemaChangeApprovalCount,
            '',
          );

          transaction.finish();
        } catch (error) {
          captureException(error);
          transaction.setStatus('internal_error');
          transaction.finish();
          throw error;
        }
      },
      interval: env.hiveServices.usageEstimator.dateRetentionPurgeIntervalMinutes * 60 * 1000,
      logger: server.log,
    });
    dbPurgeTaskRunner.start();
  }

  registerShutdown({
    logger: server.log,
    async onShutdown() {
      server.log.info('Stopping HTTP server listener...');
      await server.close();
      server.log.info('Stopping Storage handler...');
      await storage.destroy();
      if (dbPurgeTaskRunner) {
        server.log.info('Stopping expired schema check purge task...');
        await dbPurgeTaskRunner.stop();
      }
      server.log.info('Shutdown complete.');
    },
  });

  function createErrorHandler(level: SeverityLevel): LogFn {
    return (error: any, errorLike?: any, ...args: any[]) => {
      server.log.error(error, errorLike, ...args);

      const errorObj =
        error instanceof Error ? error : errorLike instanceof Error ? errorLike : null;

      if (errorObj instanceof GraphQLError) {
        return;
      }

      if (errorObj instanceof Error) {
        captureException(errorObj, {
          level,
          extra: {
            error,
            errorLike,
            rest: args,
          },
        });
      }
    };
  }

  function getRequestId() {
    const store = asyncStorage.getStore();

    return store?.requestId;
  }

  function wrapLogFn(fn: LogFn): LogFn {
    return (msg, ...args) => {
      const requestId = getRequestId();

      if (requestId) {
        fn(msg + ` - (requestId=${requestId})`, ...args);
      } else {
        fn(msg, ...args);
      }
    };
  }

  try {
    const errorHandler = createErrorHandler('error');
    const fatalHandler = createErrorHandler('fatal');

    // eslint-disable-next-line no-inner-declarations
    function createGraphQLLogger(binds: Record<string, any> = {}): Logger {
      return {
        error: wrapLogFn(errorHandler),
        fatal: wrapLogFn(fatalHandler),
        info: wrapLogFn(server.log.info.bind(server.log)),
        warn: wrapLogFn(server.log.warn.bind(server.log)),
        trace: wrapLogFn(server.log.trace.bind(server.log)),
        debug: wrapLogFn(server.log.debug.bind(server.log)),
        child(bindings) {
          return createGraphQLLogger({
            ...binds,
            ...bindings,
            requestId: getRequestId(),
          });
        },
      };
    }
    const logger = createGraphQLLogger();
    const registry = createRegistry({
      app: env.hiveServices.webApp
        ? {
            baseUrl: env.hiveServices.webApp.url,
          }
        : null,
      tokens: {
        endpoint: env.hiveServices.tokens.endpoint,
      },
      billing: {
        endpoint: env.hiveServices.billing ? env.hiveServices.billing.endpoint : null,
      },
      emailsEndpoint: env.hiveServices.emails ? env.hiveServices.emails.endpoint : undefined,
      webhooks: {
        endpoint: env.hiveServices.webhooks.endpoint,
      },
      schemaService: {
        endpoint: env.hiveServices.schema.endpoint,
      },
      usageEstimationService: {
        endpoint: env.hiveServices.usageEstimator ? env.hiveServices.usageEstimator.endpoint : null,
      },
      rateLimitService: {
        endpoint: env.hiveServices.rateLimit ? env.hiveServices.rateLimit.endpoint : null,
      },
      schemaPolicyService: {
        endpoint: env.hiveServices.schemaPolicy ? env.hiveServices.schemaPolicy.endpoint : null,
      },
      logger,
      storage,
      redis: {
        host: env.redis.host,
        port: env.redis.port,
        password: env.redis.password,
      },
      githubApp: env.github,
      clickHouse: {
        protocol: env.clickhouse.protocol,
        host: env.clickhouse.host,
        port: env.clickhouse.port,
        username: env.clickhouse.username,
        password: env.clickhouse.password,
        requestTimeout: env.clickhouse.requestTimeout,
        onReadEnd(query, timings) {
          clickHouseReadDuration.labels({ query }).observe(timings.totalSeconds);
          clickHouseElapsedDuration.labels({ query }).observe(timings.elapsedSeconds);
        },
      },
      cdn: env.cdn,
      s3: {
        accessKeyId: env.s3.credentials.accessKeyId,
        secretAccessKeyId: env.s3.credentials.secretAccessKey,
        sessionToken: env.s3.credentials.sessionToken,
        bucketName: env.s3.bucketName,
        endpoint: env.s3.endpoint,
      },
      encryptionSecret: env.encryptionSecret,
      feedback: {
        token: 'noop',
        channel: 'noop',
      },
      schemaConfig: env.hiveServices.webApp
        ? {
            schemaPublishLink(input) {
              let url = `${env.hiveServices.webApp!.url}/${input.organization.cleanId}/${
                input.project.cleanId
              }/${input.target.cleanId}`;

              if (input.version) {
                url += `/history/${input.version.id}`;
              }

              return url;
            },
            schemaCheckLink(input) {
              return `${env.hiveServices.webApp!.url}/${input.organization.cleanId}/${
                input.project.cleanId
              }/${input.target.cleanId}/checks/${input.schemaCheckId}`;
            },
          }
        : {},
      organizationOIDC: env.organizationOIDC,
      supportConfig: env.zendeskSupport,
    });

    let persistedOperations: Record<string, DocumentNode | string> | null = null;
    if (env.graphql.persistedOperationsPath) {
      persistedOperations = JSON.parse(
        fs.readFileSync(env.graphql.persistedOperationsPath, 'utf-8'),
      );
    }

    const graphqlPath = '/graphql';
    const port = env.http.port;
    const signature = Math.random().toString(16).substr(2);
    const graphql = graphqlHandler({
      graphiqlEndpoint: graphqlPath,
      registry,
      signature,
      supertokens: {
        connectionUri: env.supertokens.connectionURI,
        apiKey: env.supertokens.apiKey,
      },
      isProduction: env.environment === 'prod',
      release: env.release,
      hiveConfig: env.hive,
      logger: logger as any,
      persistedOperations,
    });

    server.route({
      method: ['GET', 'POST'],
      url: graphqlPath,
      handler: graphql,
    });

    const introspection = JSON.stringify({
      query: stripIgnoredCharacters(/* GraphQL */ `
        query readiness {
          __schema {
            queryType {
              name
            }
          }
        }
      `),
      operationName: 'readiness',
    });

    const crypto = new CryptoProvider(env.encryptionSecret);

    await registerTRPC(server, {
      router: internalApiRouter,
      createContext({ req }) {
        return createContext({ storage, crypto, req });
      },
    });

    server.route({
      method: ['GET', 'HEAD'],
      url: '/_health',
      async handler(req, res) {
        res.status(200).send(); // eslint-disable-line @typescript-eslint/no-floating-promises -- false positive, FastifyReply.then returns void
      },
    });

    server.route({
      method: ['GET', 'HEAD'],
      url: '/_readiness',
      async handler(req, res) {
        try {
          const [response, storageIsReady] = await Promise.all([
            got.post(`http://0.0.0.0:${port}${graphqlPath}`, {
              method: 'POST',
              body: introspection,
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-signature': signature,
              },
            }),
            storage.isReady(),
          ]);

          if (!storageIsReady) {
            req.log.error('Readiness check failed: failed to connect to Postgres');
          } else if (response.statusCode !== 200 || !response.body.includes('"__schema"')) {
            req.log.error(`Readiness check failed: [${response.statusCode}] ${response.body}`);
          } else {
            reportReadiness(true);
            res.status(200).send(); // eslint-disable-line @typescript-eslint/no-floating-promises -- false positive, FastifyReply.then returns void
            return;
          }
        } catch (error) {
          req.log.error(error);
        }

        reportReadiness(false);
        res.status(400).send(); // eslint-disable-line @typescript-eslint/no-floating-promises -- false positive, FastifyReply.then returns void
      },
    });

    if (env.cdn.providers.api !== null) {
      const s3 = {
        client: new AwsClient({
          accessKeyId: env.s3.credentials.accessKeyId,
          secretAccessKey: env.s3.credentials.secretAccessKey,
          service: 's3',
        }),
        endpoint: env.s3.endpoint,
        bucketName: env.s3.bucketName,
      };

      const artifactStorageReader = new ArtifactStorageReader(s3, env.s3.publicUrl, null);

      const artifactHandler = createArtifactRequestHandler({
        isKeyValid: createIsKeyValid({ s3, analytics: null, getCache: null, waitUntil: null }),
        async getArtifactAction(targetId, contractName, artifactType, eTag) {
          return artifactStorageReader.generateArtifactReadUrl(
            targetId,
            contractName,
            artifactType,
            eTag,
          );
        },
      });
      const artifactRouteHandler = createServerAdapter(
        // TODO: remove `as any` once the fallback logic in packages/services/cdn-worker/src/artifact-handler.ts is removed
        artifactHandler as any,
      );

      /** Artifacts API */
      server.route({
        method: ['GET'],
        url: '/artifacts/v1/*',
        async handler(req, reply) {
          const response = await artifactRouteHandler.handleNodeRequest(req);

          if (response === undefined) {
            void reply.status(404).send('Not found.');
            return reply;
          }

          response.headers.forEach((value, key) => {
            void reply.header(key, value);
          });

          void reply.status(response.status);

          const textResponse = await response.text();
          void reply.send(textResponse);
        },
      });
    }

    if (env.prometheus) {
      await startMetrics(env.prometheus.labels.instance);
    }

    await server.listen(port, '::');
  } catch (error) {
    server.log.fatal(error);
    captureException(error, {
      level: 'fatal',
    });
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
