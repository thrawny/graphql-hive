import { parse, print } from 'graphql';
import { Inject, Injectable, Scope } from 'graphql-modules';
import lodash from 'lodash';
import promClient from 'prom-client';
import { z } from 'zod';
import { CriticalityLevel } from '@graphql-inspector/core';
import { SchemaChangeType, SchemaCheck } from '@hive/storage';
import * as Sentry from '@sentry/node';
import * as Types from '../../../__generated__/types';
import {
  hashSDL,
  Organization,
  Project,
  ProjectType,
  Schema,
  Target,
} from '../../../shared/entities';
import { HiveError } from '../../../shared/errors';
import { isGitHubRepositoryString } from '../../../shared/is-github-repository-string';
import { bolderize } from '../../../shared/markdown';
import { sentry } from '../../../shared/sentry';
import { AlertsManager } from '../../alerts/providers/alerts-manager';
import { AuthManager } from '../../auth/providers/auth-manager';
import { TargetAccessScope } from '../../auth/providers/target-access';
import { CdnProvider } from '../../cdn/providers/cdn.provider';
import {
  GitHubIntegrationManager,
  type GitHubCheckRun,
} from '../../integrations/providers/github-integration-manager';
import { OrganizationManager } from '../../organization/providers/organization-manager';
import { ProjectManager } from '../../project/providers/project-manager';
import { RateLimitProvider } from '../../rate-limit/providers/rate-limit.provider';
import { DistributedCache } from '../../shared/providers/distributed-cache';
import { Logger } from '../../shared/providers/logger';
import { Mutex } from '../../shared/providers/mutex';
import { Storage, type TargetSelector } from '../../shared/providers/storage';
import { TargetManager } from '../../target/providers/target-manager';
import { toGraphQLSchemaCheck } from '../to-graphql-schema-check';
import { ArtifactStorageWriter } from './artifact-storage-writer';
import type { SchemaModuleConfig } from './config';
import { SCHEMA_MODULE_CONFIG } from './config';
import { Contracts } from './contracts';
import { CompositeModel } from './models/composite';
import { CompositeLegacyModel } from './models/composite-legacy';
import {
  DeleteFailureReasonCode,
  formatPolicyError,
  getReasonByCode,
  PublishFailureReasonCode,
  SchemaCheckConclusion,
  SchemaCheckResult,
  SchemaCheckWarning,
  SchemaDeleteConclusion,
  SchemaPublishConclusion,
  SchemaPublishResult,
} from './models/shared';
import { SingleModel } from './models/single';
import { SingleLegacyModel } from './models/single-legacy';
import { ensureCompositeSchemas, ensureSingleSchema, SchemaHelper } from './schema-helper';
import { SchemaManager } from './schema-manager';

const schemaCheckCount = new promClient.Counter({
  name: 'registry_check_count',
  help: 'Number of schema checks',
  labelNames: ['model', 'projectType', 'conclusion'],
});

const schemaPublishCount = new promClient.Counter({
  name: 'registry_publish_count',
  help: 'Number of schema publishes',
  labelNames: ['model', 'projectType', 'conclusion'],
});

const schemaDeleteCount = new promClient.Counter({
  name: 'registry_delete_count',
  help: 'Number of schema deletes',
  labelNames: ['model', 'projectType'],
});

export type CheckInput = Omit<Types.SchemaCheckInput, 'project' | 'organization' | 'target'> &
  TargetSelector;

export type DeleteInput = Omit<Types.SchemaDeleteInput, 'project' | 'organization' | 'target'> &
  Omit<TargetSelector, 'target'> & {
    checksum: string;
    target: Target;
  };

export type PublishInput = Types.SchemaPublishInput &
  TargetSelector & {
    checksum: string;
    isSchemaPublishMissingUrlErrorSelected: boolean;
  };

type BreakPromise<T> = T extends Promise<infer U> ? U : never;

type PublishResult = BreakPromise<ReturnType<SchemaPublisher['internalPublish']>>;

function registryLockId(targetId: string) {
  return `registry:lock:${targetId}`;
}

function assertNonNull<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

@Injectable({
  scope: Scope.Operation,
})
export class SchemaPublisher {
  private logger: Logger;
  private models: {
    [ProjectType.SINGLE]: {
      modern: SingleModel;
      legacy: SingleLegacyModel;
    };
    [ProjectType.FEDERATION]: {
      modern: CompositeModel;
      legacy: CompositeLegacyModel;
    };
    [ProjectType.STITCHING]: {
      modern: CompositeModel;
      legacy: CompositeLegacyModel;
    };
  };

  constructor(
    logger: Logger,
    private authManager: AuthManager,
    private storage: Storage,
    private schemaManager: SchemaManager,
    private targetManager: TargetManager,
    private projectManager: ProjectManager,
    private organizationManager: OrganizationManager,
    private alertsManager: AlertsManager,
    private cdn: CdnProvider,
    private gitHubIntegrationManager: GitHubIntegrationManager,
    private distributedCache: DistributedCache,
    private helper: SchemaHelper,
    private artifactStorageWriter: ArtifactStorageWriter,
    private mutex: Mutex,
    private rateLimit: RateLimitProvider,
    private contracts: Contracts,
    @Inject(SCHEMA_MODULE_CONFIG) private schemaModuleConfig: SchemaModuleConfig,
    singleModel: SingleModel,
    compositeModel: CompositeModel,
    compositeLegacyModel: CompositeLegacyModel,
    singleLegacyModel: SingleLegacyModel,
  ) {
    this.logger = logger.child({ service: 'SchemaPublisher' });
    this.models = {
      [ProjectType.SINGLE]: {
        modern: singleModel,
        legacy: singleLegacyModel,
      },
      [ProjectType.FEDERATION]: {
        modern: compositeModel,
        legacy: compositeLegacyModel,
      },
      [ProjectType.STITCHING]: {
        modern: compositeModel,
        legacy: compositeLegacyModel,
      },
    };
  }

  @sentry('SchemaPublisher.check')
  async check(input: CheckInput) {
    this.logger.info('Checking schema (input=%o)', lodash.omit(input, ['sdl']));

    await this.authManager.ensureTargetAccess({
      target: input.target,
      project: input.project,
      organization: input.organization,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const [
      target,
      project,
      organization,
      latestVersion,
      latestComposableVersion,
      latestSchemaVersion,
      latestComposableSchemaVersion,
    ] = await Promise.all([
      this.targetManager.getTarget({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
      this.projectManager.getProject({
        organization: input.organization,
        project: input.project,
      }),
      this.organizationManager.getOrganization({
        organization: input.organization,
      }),
      this.schemaManager.getLatestSchemas({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
      this.schemaManager.getLatestSchemas({
        organization: input.organization,
        project: input.project,
        target: input.target,
        onlyComposable: true,
      }),
      this.schemaManager.getMaybeLatestVersion({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
      this.schemaManager.getMaybeLatestValidVersion({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
    ]);

    const projectModelVersion = project.legacyRegistryModel ? 'legacy' : 'modern';

    function increaseSchemaCheckCountMetric(conclusion: 'rejected' | 'accepted') {
      schemaCheckCount.inc({
        model: projectModelVersion,
        projectType: project.type,
        conclusion,
      });
    }

    if (
      (project.type === ProjectType.FEDERATION || project.type === ProjectType.STITCHING) &&
      input.service == null
    ) {
      this.logger.debug('No service name provided (type=%s)', project.type, projectModelVersion);
      increaseSchemaCheckCountMetric('rejected');
      return {
        __typename: 'SchemaCheckError',
        valid: false,
        changes: [],
        warnings: [],
        errors: [
          {
            message: 'Missing service name',
          },
        ],
      } as const;
    }

    let githubCheckRun: GitHubCheckRun | null = null;

    {
      let github: null | {
        repository: `${string}/${string}`;
        sha: string;
      } = null;

      if (input.github) {
        if (input.github.repository) {
          if (!isGitHubRepositoryString(input.github.repository)) {
            this.logger.debug(
              'Invalid github repository name provided (repository=%s)',
              input.github.repository,
            );
            increaseSchemaCheckCountMetric('rejected');
            return {
              __typename: 'GitHubSchemaCheckError' as const,
              message: 'Invalid github repository name provided.',
            };
          }
          github = {
            repository: input.github.repository,
            sha: input.github.commit,
          };
        } else if (project.gitRepository == null) {
          this.logger.debug(
            'Git repository is not configured for this project (project=%s)',
            project.id,
          );
          increaseSchemaCheckCountMetric('rejected');
          return {
            __typename: 'GitHubSchemaCheckError' as const,
            message: 'Git repository is not configured for this project.',
          };
        } else {
          github = {
            repository: project.gitRepository,
            sha: input.github.commit,
          };
        }
      }

      if (github != null) {
        const result = await this.createGithubCheckRunStartForSchemaCheck({
          organization,
          project,
          target,
          serviceName: input.service ?? null,
          github: {
            owner: github.repository.split('/')[0],
            repository: github.repository.split('/')[1],
            sha: github.sha,
          },
        });

        if (result.success === false) {
          increaseSchemaCheckCountMetric('rejected');
          return {
            __typename: 'GitHubSchemaCheckError' as const,
            message: result.error,
          };
        }

        githubCheckRun = result.data;
      }
    }

    let contextId: string | null = null;

    if (input.contextId !== undefined) {
      const result = SchemaCheckContextIdModel.safeParse(input.contextId);
      if (!result.success) {
        return {
          __typename: 'SchemaCheckError',
          valid: false,
          changes: [],
          warnings: [],
          errors: [
            {
              message: result.error.errors[0].message,
            },
          ],
        } as const;
      }
      contextId = result.data;
    } else if (input.github?.repository && input.github.pullRequestNumber) {
      contextId = `${input.github.repository}#${input.github.pullRequestNumber}`;
    }

    await this.schemaManager.completeGetStartedCheck({
      organization: project.orgId,
      step: 'checkingSchema',
    });

    const baseSchema = await this.schemaManager.getBaseSchema({
      organization: input.organization,
      project: input.project,
      target: input.target,
    });

    const selector = {
      organization: input.organization,
      project: input.project,
      target: input.target,
    };

    const sdl = tryPrettifySDL(input.sdl);

    let checkResult: SchemaCheckResult;

    const approvedSchemaChanges = new Map<string, SchemaChangeType>();

    if (contextId !== null) {
      const changes = await this.storage.getApprovedSchemaChangesForContextId({
        targetId: target.id,
        contextId,
      });
      for (const change of changes) {
        approvedSchemaChanges.set(change.id, change);
      }
    }

    const contracts =
      project.type === ProjectType.FEDERATION
        ? await this.contracts.loadContractsWithLatestValidContractVersionsByTargetId({
            targetId: target.id,
          })
        : null;

    switch (project.type) {
      case ProjectType.SINGLE:
        this.logger.debug('Using SINGLE registry model (version=%s)', projectModelVersion);
        checkResult = await this.models[ProjectType.SINGLE][projectModelVersion].check({
          input,
          selector,
          latest: latestVersion
            ? {
                isComposable: latestVersion.valid,
                sdl: latestSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: [ensureSingleSchema(latestVersion.schemas)],
              }
            : null,
          latestComposable: latestComposableVersion
            ? {
                isComposable: latestComposableVersion.valid,
                sdl: latestComposableSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: [ensureSingleSchema(latestComposableVersion.schemas)],
              }
            : null,
          baseSchema,
          project,
          organization,
          approvedChanges: approvedSchemaChanges,
        });
        break;
      case ProjectType.FEDERATION:
      case ProjectType.STITCHING:
        this.logger.debug(
          'Using %s registry model (version=%s)',
          project.type,
          projectModelVersion,
        );

        if (!input.service) {
          throw new Error('Guard for TypeScript limitations on inferring types. :)');
        }

        checkResult = await this.models[project.type][projectModelVersion].check({
          input: {
            sdl,
            serviceName: input.service,
          },
          selector,
          latest: latestVersion
            ? {
                isComposable: latestVersion.valid,
                sdl: latestSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: ensureCompositeSchemas(latestVersion.schemas),
              }
            : null,
          latestComposable: latestComposableVersion
            ? {
                isComposable: latestComposableVersion.valid,
                sdl: latestComposableSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: ensureCompositeSchemas(latestComposableVersion.schemas),
              }
            : null,
          baseSchema,
          project,
          organization,
          approvedChanges: approvedSchemaChanges,
          contracts,
        });
        break;
      default:
        this.logger.debug('Unsupported project type (type=%s)', project.type);
        throw new HiveError(`${project.type} project (${projectModelVersion}) not supported`);
    }

    let schemaCheck: null | SchemaCheck = null;

    const retention = await this.rateLimit.getRetention({ targetId: target.id });
    const expiresAt = retention ? new Date(Date.now() + retention * millisecondsPerDay) : null;

    if (checkResult.conclusion === SchemaCheckConclusion.Failure) {
      schemaCheck = await this.storage.createSchemaCheck({
        schemaSDL: sdl,
        schemaSDLHash: createSDLHash(sdl),
        serviceName: input.service ?? null,
        meta: input.meta ?? null,
        targetId: target.id,
        schemaVersionId: latestVersion?.version ?? null,
        isSuccess: false,
        breakingSchemaChanges: checkResult.state.schemaChanges?.breaking ?? null,
        safeSchemaChanges: checkResult.state.schemaChanges?.safe ?? null,
        schemaPolicyWarnings: checkResult.state.schemaPolicy?.warnings ?? null,
        schemaPolicyErrors: checkResult.state.schemaPolicy?.errors ?? null,
        ...(checkResult.state.composition.errors
          ? {
              schemaCompositionErrors: checkResult.state.composition.errors,
              compositeSchemaSDL: null,
              compositeSchemaSDLHash: null,
              supergraphSDL: null,
              supergraphSDLHash: null,
            }
          : {
              schemaCompositionErrors: null,
              compositeSchemaSDL: checkResult.state.composition.compositeSchemaSDL,
              compositeSchemaSDLHash: createSDLHash(
                checkResult.state.composition.compositeSchemaSDL,
              ),
              supergraphSDL: checkResult.state.composition.supergraphSDL,
              supergraphSDLHash: checkResult.state.composition.supergraphSDL
                ? createSDLHash(checkResult.state.composition.supergraphSDL)
                : null,
            }),
        isManuallyApproved: false,
        manualApprovalUserId: null,
        githubCheckRunId: githubCheckRun?.id ?? null,
        githubRepository: githubCheckRun
          ? githubCheckRun.owner + '/' + githubCheckRun.repository
          : null,
        githubSha: githubCheckRun?.commit ?? null,
        expiresAt,
        contextId,
        contracts:
          checkResult.state.contracts?.map(contract => ({
            contractId: contract.contractId,
            contractName: contract.contractName,
            isSuccess: contract.isSuccessful,
            compositeSchemaSdl: contract.composition.compositeSchemaSDL,
            compositeSchemaSdlHash: contract.composition.compositeSchemaSDL
              ? createSDLHash(contract.composition.compositeSchemaSDL)
              : null,
            supergraphSchemaSdl: contract.composition.supergraphSDL,
            supergraphSchemaSdlHash: contract.composition.supergraphSDL
              ? createSDLHash(contract.composition.supergraphSDL)
              : null,
            schemaCompositionErrors: contract.composition.errors ?? null,
            breakingSchemaChanges: contract.schemaChanges?.breaking ?? null,
            safeSchemaChanges: contract.schemaChanges?.safe ?? null,
          })) ?? null,
      });
    }

    if (checkResult.conclusion === SchemaCheckConclusion.Success) {
      let composition = checkResult.state?.composition ?? null;
      // in case of a skip this is null
      if (composition === null) {
        if (latestVersion == null || latestSchemaVersion == null) {
          throw new Error(
            'Composition yielded no composite schema SDL but there is no latest version to fall back to.',
          );
        }

        if (latestSchemaVersion.compositeSchemaSDL) {
          composition = {
            compositeSchemaSDL: latestSchemaVersion.compositeSchemaSDL,
            supergraphSDL: latestSchemaVersion.supergraphSDL,
          };
        } else {
          // LEGACY CASE if the schema version record has no sdl
          // -> we need to do manual composition
          const orchestrator = this.schemaManager.matchOrchestrator(project.type);

          const result = await orchestrator.composeAndValidate(
            latestVersion.schemas.map(s => this.helper.createSchemaObject(s)),
            {
              external: project.externalComposition,
              native: this.schemaManager.checkProjectNativeFederationSupport({
                project,
                organization,
              }),
              contracts: null,
            },
          );

          if (result.sdl == null) {
            throw new Error('Manual composition yielded no composite schema SDL.');
          }

          composition = {
            compositeSchemaSDL: result.sdl,
            supergraphSDL: result.supergraph,
          };
        }
      }

      schemaCheck = await this.storage.createSchemaCheck({
        schemaSDL: sdl,
        schemaSDLHash: createSDLHash(sdl),
        serviceName: input.service ?? null,
        meta: input.meta ?? null,
        targetId: target.id,
        schemaVersionId: latestVersion?.version ?? null,
        isSuccess: true,
        breakingSchemaChanges: checkResult.state?.schemaChanges?.breaking ?? null,
        safeSchemaChanges: checkResult.state?.schemaChanges?.safe ?? null,
        schemaPolicyWarnings: checkResult.state?.schemaPolicyWarnings ?? null,
        schemaPolicyErrors: null,
        schemaCompositionErrors: null,
        compositeSchemaSDL: composition.compositeSchemaSDL,
        compositeSchemaSDLHash: createSDLHash(composition.compositeSchemaSDL),
        supergraphSDL: composition.supergraphSDL,
        supergraphSDLHash: composition.supergraphSDL
          ? createSDLHash(composition.supergraphSDL)
          : null,
        isManuallyApproved: false,
        manualApprovalUserId: null,
        githubCheckRunId: githubCheckRun?.id ?? null,
        githubRepository: githubCheckRun
          ? githubCheckRun.owner + '/' + githubCheckRun.repository
          : null,
        githubSha: githubCheckRun?.commit ?? null,
        expiresAt,
        contextId,
        contracts:
          checkResult.state?.contracts?.map(contract => ({
            contractId: contract.contractId,
            contractName: contract.contractName,
            isSuccess: contract.isSuccessful,
            compositeSchemaSdl: contract.composition.compositeSchemaSDL,
            compositeSchemaSdlHash: contract.composition.compositeSchemaSDL
              ? createSDLHash(contract.composition.compositeSchemaSDL)
              : null,
            supergraphSchemaSdl: contract.composition.supergraphSDL,
            supergraphSchemaSdlHash: contract.composition.supergraphSDL
              ? createSDLHash(contract.composition.supergraphSDL)
              : null,
            schemaCompositionErrors: null,
            breakingSchemaChanges: contract.schemaChanges?.breaking ?? null,
            safeSchemaChanges: contract.schemaChanges?.safe ?? null,
          })) ?? null,
      });
    }

    if (githubCheckRun) {
      if (checkResult.conclusion === SchemaCheckConclusion.Success) {
        increaseSchemaCheckCountMetric('accepted');
        return await this.updateGithubCheckRunForSchemaCheck({
          project,
          target,
          organization,
          conclusion: checkResult.conclusion,
          changes: checkResult.state?.schemaChanges?.all ?? null,
          breakingChanges: checkResult.state?.schemaChanges?.breaking ?? null,
          warnings: checkResult.state?.schemaPolicyWarnings ?? null,
          compositionErrors: null,
          errors: null,
          schemaCheckId: schemaCheck?.id ?? null,
          githubCheckRun: githubCheckRun,
        });
      }

      increaseSchemaCheckCountMetric('rejected');
      return await this.updateGithubCheckRunForSchemaCheck({
        project,
        target,
        organization,
        conclusion: checkResult.conclusion,
        changes: [
          ...(checkResult.state.schemaChanges?.breaking ?? []),
          ...(checkResult.state.schemaChanges?.safe ?? []),
        ],
        breakingChanges: checkResult.state.schemaChanges?.breaking ?? [],
        compositionErrors: checkResult.state.composition.errors ?? [],
        warnings: checkResult.state.schemaPolicy?.warnings ?? [],
        errors: checkResult.state.schemaPolicy?.errors?.map(formatPolicyError) ?? [],
        schemaCheckId: schemaCheck?.id ?? null,
        githubCheckRun: githubCheckRun,
      });
    }

    if (schemaCheck == null) {
      throw new Error('Invalid state. Schema check can not be null at this point.');
    }

    const schemaCheckSelector = {
      organizationId: target.orgId,
      projectId: target.projectId,
    };

    if (checkResult.conclusion === SchemaCheckConclusion.Success) {
      increaseSchemaCheckCountMetric('accepted');
      return {
        __typename: 'SchemaCheckSuccess',
        valid: true,
        changes: checkResult.state?.schemaChanges?.all ?? [],
        warnings: checkResult.state?.schemaPolicyWarnings ?? [],
        initial: latestVersion == null,
        schemaCheck: toGraphQLSchemaCheck(schemaCheckSelector, schemaCheck),
      } as const;
    }

    increaseSchemaCheckCountMetric('rejected');

    return {
      __typename: 'SchemaCheckError',
      valid: false,
      changes: checkResult.state.schemaChanges?.all ?? [],
      warnings: checkResult.state.schemaPolicy?.warnings ?? [],
      errors: [
        ...(checkResult.state.schemaChanges?.breaking?.filter(
          breaking => breaking.approvalMetadata == null && breaking.isSafeBasedOnUsage === false,
        ) ?? []),
        ...(checkResult.state.schemaPolicy?.errors?.map(formatPolicyError) ?? []),
        ...(checkResult.state.composition.errors ?? []),
        ...(checkResult.state.contracts?.flatMap(contract => [
          ...(contract.composition.errors?.map(error => ({
            message: `[${contract.contractName}] ${error.message}`,
            source: error.source,
          })) ?? []),
        ]) ?? []),
      ],
      schemaCheck: toGraphQLSchemaCheck(schemaCheckSelector, schemaCheck),
    } as const;
  }

  @sentry('SchemaPublisher.publish')
  async publish(input: PublishInput, signal: AbortSignal): Promise<PublishResult> {
    this.logger.debug(
      'Schema publication (checksum=%s, organization=%s, project=%s, target=%s)',
      input.checksum,
      input.organization,
      input.project,
      input.target,
    );
    return this.mutex.perform(
      registryLockId(input.target),
      {
        signal,
      },
      async () => {
        await this.authManager.ensureTargetAccess({
          target: input.target,
          project: input.project,
          organization: input.organization,
          scope: TargetAccessScope.REGISTRY_WRITE,
        });
        return this.distributedCache.wrap({
          key: `schema:publish:${input.checksum}`,
          ttlSeconds: 15,
          executor: () => this.internalPublish(input),
        });
      },
    );
  }

  public async updateVersionStatus(input: TargetSelector & { version: string; valid: boolean }) {
    const updateResult = await this.schemaManager.updateSchemaVersionStatus(input);

    if (updateResult.isComposable === true) {
      // Now, when fetching the latest valid version, we should be able to detect
      // if it's the version we just updated or not.
      // Why?
      // Because we change its status to valid
      // and `getLatestValidVersion` calls for fresh data from DB
      const latestVersion = await this.schemaManager.getLatestValidVersion(input);

      // if it is the latest version, we should update the CDN
      if (latestVersion.id === updateResult.id) {
        this.logger.info('Version is now promoted to latest valid (version=%s)', latestVersion.id);
        const [organization, project, target, schemas] = await Promise.all([
          this.organizationManager.getOrganization({
            organization: input.organization,
          }),
          this.projectManager.getProject({
            organization: input.organization,
            project: input.project,
          }),
          this.targetManager.getTarget({
            organization: input.organization,
            project: input.project,
            target: input.target,
          }),
          this.schemaManager.getSchemasOfVersion({
            organization: input.organization,
            project: input.project,
            target: input.target,
            version: latestVersion.id,
            includeMetadata: true,
          }),
        ]);

        const orchestrator = this.schemaManager.matchOrchestrator(project.type);
        const schemaObjects = schemas.map(s => this.helper.createSchemaObject(s));
        const compositionResult = await orchestrator.composeAndValidate(schemaObjects, {
          external: project.externalComposition,
          native: this.schemaManager.checkProjectNativeFederationSupport({
            project,
            organization,
          }),
          contracts: null,
        });

        this.logger.info(
          'Deploying version to CDN (reason="status_change" version=%s)',
          latestVersion.id,
        );

        await this.publishToCDN({
          target,
          project,
          supergraph: compositionResult.supergraph,
          schemas,
          fullSchemaSdl: compositionResult.sdl!,
        });
      }
    }

    return updateResult;
  }

  @sentry('SchemaPublisher.delete')
  async delete(input: DeleteInput, signal: AbortSignal) {
    this.logger.info('Deleting schema (input=%o)', input);

    return this.mutex.perform(
      registryLockId(input.target.id),
      {
        signal,
      },
      async () => {
        await this.authManager.ensureTargetAccess({
          organization: input.organization,
          project: input.project,
          target: input.target.id,
          scope: TargetAccessScope.REGISTRY_WRITE,
        });
        const [
          project,
          organization,
          latestVersion,
          latestComposableVersion,
          baseSchema,
          latestSchemaVersion,
          latestComposableSchemaVersion,
        ] = await Promise.all([
          this.projectManager.getProject({
            organization: input.organization,
            project: input.project,
          }),
          this.organizationManager.getOrganization({
            organization: input.organization,
          }),
          this.schemaManager.getLatestSchemas({
            organization: input.organization,
            project: input.project,
            target: input.target.id,
          }),
          this.schemaManager.getLatestSchemas({
            organization: input.organization,
            project: input.project,
            target: input.target.id,
            onlyComposable: true,
          }),
          this.schemaManager.getBaseSchema({
            organization: input.organization,
            project: input.project,
            target: input.target.id,
          }),
          this.schemaManager.getMaybeLatestVersion({
            organization: input.organization,
            project: input.project,
            target: input.target.id,
          }),
          this.schemaManager.getMaybeLatestValidVersion({
            organization: input.organization,
            project: input.project,
            target: input.target.id,
          }),
        ]);

        const modelVersion = project.legacyRegistryModel ? 'legacy' : 'modern';

        schemaDeleteCount.inc({ model: modelVersion, projectType: project.type });

        if (project.type !== ProjectType.FEDERATION && project.type !== ProjectType.STITCHING) {
          throw new HiveError(`${project.type} project (${modelVersion}) not supported`);
        }

        if (modelVersion === 'legacy') {
          throw new HiveError(
            'Please upgrade your project to the new registry model to use this feature. See https://the-guild.dev/blog/graphql-hive-improvements-in-schema-registry',
          );
        }

        if (!latestVersion || latestVersion.schemas.length === 0) {
          throw new HiveError('Registry is empty');
        }

        const schemas = ensureCompositeSchemas(latestVersion.schemas);
        this.logger.debug(`Found ${latestVersion?.schemas.length ?? 0} most recent schemas`);
        this.logger.debug(
          'Using %s registry model (version=%s, featureFlags=%o)',
          project.type,
          modelVersion,
          organization.featureFlags,
        );

        const serviceExists = schemas.some(s => s.service_name === input.serviceName);

        if (!serviceExists) {
          return {
            __typename: 'SchemaDeleteError',
            valid: latestVersion.valid,
            errors: [
              {
                message: `Service "${input.serviceName}" not found`,
              },
            ],
          } as const;
        }

        const deleteResult = await this.models[project.type][modelVersion].delete({
          input: {
            serviceName: input.serviceName,
          },
          latest: {
            isComposable: latestVersion.valid,
            sdl: latestSchemaVersion?.compositeSchemaSDL ?? null,
            schemas,
          },
          latestComposable: latestComposableVersion
            ? {
                isComposable: latestComposableVersion.valid,
                sdl: latestComposableSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: ensureCompositeSchemas(latestComposableVersion.schemas),
              }
            : null,
          baseSchema,
          project,
          organization,
          selector: {
            target: input.target.id,
            project: input.project,
            organization: input.organization,
          },
        });

        if (deleteResult.conclusion === SchemaDeleteConclusion.Accept) {
          this.logger.debug('Delete accepted');
          if (input.dryRun !== true) {
            const schemaVersion = await this.storage.deleteSchema({
              organization: input.organization,
              project: input.project,
              target: input.target.id,
              serviceName: input.serviceName,
              composable: deleteResult.state.composable,
              changes: deleteResult.state.changes,
              ...(deleteResult.state.fullSchemaSdl
                ? {
                    compositeSchemaSDL: deleteResult.state.fullSchemaSdl,
                    supergraphSDL: deleteResult.state.supergraph,
                    schemaCompositionErrors: null,
                    tags: deleteResult.state.tags,
                  }
                : {
                    compositeSchemaSDL: null,
                    supergraphSDL: null,
                    schemaCompositionErrors: deleteResult.state.compositionErrors ?? [],
                    tags: null,
                  }),
              actionFn: async () => {
                if (deleteResult.state.composable) {
                  await this.publishToCDN({
                    target: input.target,
                    project,
                    supergraph: deleteResult.state.supergraph,
                    fullSchemaSdl: deleteResult.state.fullSchemaSdl,
                    // pass all schemas except the one we are deleting
                    schemas: schemas.filter(s => s.service_name !== input.serviceName),
                  });
                }
              },
            });

            const changes = deleteResult.state.changes ?? [];
            const errors = [
              ...(deleteResult.state.compositionErrors ?? []),
              ...(deleteResult.state.breakingChanges ?? []).map(change => ({
                message: change.message,
                // triggerSchemaChangeNotifications.errors accepts only path as array
                path: change.path ? [change.path] : undefined,
              })),
            ];

            if ((Array.isArray(changes) && changes.length > 0) || errors.length > 0) {
              void this.alertsManager
                .triggerSchemaChangeNotifications({
                  organization,
                  project,
                  target: input.target,
                  schema: {
                    id: schemaVersion.versionId,
                    commit: schemaVersion.id,
                    valid: deleteResult.state.composable,
                  },
                  changes,
                  messages: [],
                  errors,
                  initial: false,
                })
                .catch(err => {
                  this.logger.error('Failed to trigger schema change notifications', err);
                });
            }
          }

          return {
            __typename: 'SchemaDeleteSuccess',
            valid: deleteResult.state.composable,
            changes: deleteResult.state.changes,
            errors: [
              ...(deleteResult.state.compositionErrors ?? []),
              ...(deleteResult.state.breakingChanges ?? []),
            ],
          } as const;
        }

        this.logger.debug('Delete rejected');

        const errors = [];

        const compositionErrors = getReasonByCode(
          deleteResult.reasons,
          DeleteFailureReasonCode.CompositionFailure,
        )?.compositionErrors;

        if (getReasonByCode(deleteResult.reasons, DeleteFailureReasonCode.MissingServiceName)) {
          errors.push({
            message: 'Service name is required',
          });
        }

        if (compositionErrors?.length) {
          errors.push(...compositionErrors);
        }

        return {
          __typename: 'SchemaDeleteError',
          valid: false,
          errors,
        } as const;
      },
    );
  }

  private async internalPublish(input: PublishInput) {
    const [organizationId, projectId, targetId] = [input.organization, input.project, input.target];
    this.logger.info('Publishing schema (input=%o)', {
      ...lodash.omit(input, ['sdl', 'organization', 'project', 'target', 'metadata']),
      organization: organizationId,
      project: projectId,
      target: targetId,
      sdl: input.sdl.length,
      checksum: input.checksum,
      experimental_accept_breaking_changes: input.experimental_acceptBreakingChanges === true,
      metadata: !!input.metadata,
    });

    const [
      organization,
      project,
      target,
      latestVersion,
      latestComposable,
      baseSchema,
      latestSchemaVersion,
      latestComposableSchemaVersion,
    ] = await Promise.all([
      this.organizationManager.getOrganization({
        organization: organizationId,
      }),
      this.projectManager.getProject({
        organization: organizationId,
        project: projectId,
      }),
      this.targetManager.getTarget({
        organization: organizationId,
        project: projectId,
        target: targetId,
      }),
      this.schemaManager.getLatestSchemas({
        organization: organizationId,
        project: projectId,
        target: targetId,
      }),
      this.schemaManager.getLatestSchemas({
        organization: organizationId,
        project: projectId,
        target: targetId,
        onlyComposable: true,
      }),
      this.schemaManager.getBaseSchema({
        organization: organizationId,
        project: projectId,
        target: targetId,
      }),
      this.schemaManager.getMaybeLatestVersion({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
      this.schemaManager.getMaybeLatestValidVersion({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
    ]);

    const modelVersion = project.legacyRegistryModel ? 'legacy' : 'modern';

    function increaseSchemaPublishCountMetric(conclusion: 'rejected' | 'accepted' | 'ignored') {
      schemaPublishCount.inc({
        model: modelVersion,
        projectType: project.type,
        conclusion,
      });
    }

    let github: null | {
      repository: `${string}/${string}`;
      sha: string;
    } = null;

    if (input.gitHub != null) {
      if (!isGitHubRepositoryString(input.gitHub.repository)) {
        this.logger.debug(
          'Invalid github repository name provided (repository=%s)',
          input.gitHub.repository,
        );
        increaseSchemaPublishCountMetric('rejected');
        return {
          __typename: 'GitHubSchemaPublishError' as const,
          message: 'Invalid github repository name provided.',
        } as const;
      }

      github = {
        repository: input.gitHub.repository,
        sha: input.gitHub.commit,
      };
    } else if (input.github === true) {
      if (!project.gitRepository) {
        this.logger.debug(
          'Git repository is not configured for this project (project=%s)',
          project.id,
        );
        increaseSchemaPublishCountMetric('rejected');
        return {
          __typename: 'GitHubSchemaPublishError',
          message: 'Git repository is not configured for this project.',
        } as const;
      }
      github = {
        repository: project.gitRepository,
        sha: input.commit,
      };
    }

    let githubCheckRun: GitHubCheckRun | null = null;

    if (github) {
      const result = await this.createGithubCheckRunForSchemaPublish({
        organizationId: organization.id,
        github: {
          owner: github.repository.split('/')[0],
          repository: github.repository.split('/')[1],
          sha: github.sha,
        },
      });

      if (result.success === false) {
        increaseSchemaPublishCountMetric('rejected');
        return {
          __typename: 'GitHubSchemaPublishError',
          message: result.error,
        } as const;
      }

      githubCheckRun = result.data;
    }

    await this.schemaManager.completeGetStartedCheck({
      organization: project.orgId,
      step: 'publishingSchema',
    });

    this.logger.debug(`Found ${latestVersion?.schemas.length ?? 0} most recent schemas`);

    const contracts =
      project.type === ProjectType.FEDERATION
        ? await this.contracts.loadContractsWithLatestValidContractVersionsByTargetId({
            targetId: target.id,
          })
        : null;

    const contractIdToLatestValidContractVersionId = new Map<string, string | null>();
    for (const contract of contracts ?? []) {
      contractIdToLatestValidContractVersionId.set(
        contract.contract.id,
        contract.latestValidVersion?.id ?? null,
      );
    }

    let publishResult: SchemaPublishResult;

    switch (project.type) {
      case ProjectType.SINGLE:
        this.logger.debug(
          'Using SINGLE registry model (version=%s, featureFlags=%o)',
          modelVersion,
          organization.featureFlags,
        );
        publishResult = await this.models[ProjectType.SINGLE][modelVersion].publish({
          input,
          latest: latestVersion
            ? {
                isComposable: latestVersion.valid,
                sdl: latestSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: [ensureSingleSchema(latestVersion.schemas)],
              }
            : null,
          latestComposable: latestComposable
            ? {
                isComposable: latestComposable.valid,
                sdl: latestComposableSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: [ensureSingleSchema(latestComposable.schemas)],
              }
            : null,
          organization,
          project,
          target,
          baseSchema,
        });
        break;
      case ProjectType.FEDERATION:
      case ProjectType.STITCHING:
        this.logger.debug(
          'Using %s registry model (version=%s, featureFlags=%o)',
          project.type,
          modelVersion,
          organization.featureFlags,
        );
        publishResult = await this.models[project.type][modelVersion].publish({
          input,
          latest: latestVersion
            ? {
                isComposable: latestVersion.valid,
                sdl: latestSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: ensureCompositeSchemas(latestVersion.schemas),
              }
            : null,
          latestComposable: latestComposable
            ? {
                isComposable: latestComposable.valid,
                sdl: latestComposableSchemaVersion?.compositeSchemaSDL ?? null,
                schemas: ensureCompositeSchemas(latestComposable.schemas),
              }
            : null,
          organization,
          project,
          target,
          baseSchema,
          contracts,
        });
        break;
      default: {
        this.logger.debug('Unsupported project type (type=%s)', project.type);
        throw new HiveError(`${project.type} project (${modelVersion}) not supported`);
      }
    }

    if (publishResult.conclusion === SchemaPublishConclusion.Ignore) {
      this.logger.debug('Publish ignored (reasons=%s)', publishResult.reason);

      increaseSchemaPublishCountMetric('ignored');

      const linkToWebsite =
        typeof this.schemaModuleConfig.schemaPublishLink === 'function'
          ? this.schemaModuleConfig.schemaPublishLink({
              organization: {
                cleanId: organization.cleanId,
              },
              project: {
                cleanId: project.cleanId,
              },
              target: {
                cleanId: target.cleanId,
              },
              version: latestVersion ? { id: latestVersion.version } : undefined,
            })
          : null;

      if (githubCheckRun) {
        return this.updateGithubCheckRunForSchemaPublish({
          githubCheckRun,
          force: false,
          initial: false,
          valid: true,
          changes: [],
          errors: [],

          organizationId: organization.id,
          detailsUrl: linkToWebsite,
        });
      }

      return {
        __typename: 'SchemaPublishSuccess',
        initial: false,
        valid: true,
        changes: [],
        linkToWebsite,
      } as const;
    }

    if (publishResult.conclusion === SchemaPublishConclusion.Reject) {
      this.logger.debug(
        'Publish rejected (reasons=%s)',
        publishResult.reasons.map(r => r.code).join(', '),
      );

      increaseSchemaPublishCountMetric('rejected');

      if (getReasonByCode(publishResult.reasons, PublishFailureReasonCode.MissingServiceName)) {
        return {
          __typename: 'SchemaPublishMissingServiceError' as const,
          message: 'Missing service name',
        } as const;
      }

      if (getReasonByCode(publishResult.reasons, PublishFailureReasonCode.MissingServiceUrl)) {
        return {
          __typename: 'SchemaPublishMissingUrlError' as const,
          message: 'Missing service url',
        } as const;
      }

      const changes =
        getReasonByCode(publishResult.reasons, PublishFailureReasonCode.BreakingChanges)?.changes ??
        [];
      const errors = (
        [] as Array<{
          message: string;
        }>
      ).concat(
        getReasonByCode(publishResult.reasons, PublishFailureReasonCode.BreakingChanges)?.changes ??
          [],
        getReasonByCode(publishResult.reasons, PublishFailureReasonCode.CompositionFailure)
          ?.compositionErrors ?? [],
        getReasonByCode(publishResult.reasons, PublishFailureReasonCode.MetadataParsingFailure)
          ? [
              {
                message: 'Failed to parse metadata',
              },
            ]
          : [],
      );

      if (githubCheckRun) {
        return this.updateGithubCheckRunForSchemaPublish({
          githubCheckRun,
          force: false,
          initial: false,
          valid: false,
          changes,
          errors,
          organizationId: organization.id,
          detailsUrl: null,
        });
      }

      return {
        __typename: 'SchemaPublishError' as const,
        valid: false,
        changes,
        errors,
      };
    }

    const errors = (
      [] as Array<{
        message: string;
      }>
    ).concat(
      publishResult.state.compositionErrors ?? [],
      publishResult.state.breakingChanges ?? [],
    );

    this.logger.debug('Publishing new version');

    const composable = publishResult.state.composable;
    const fullSchemaSdl = publishResult.state.fullSchemaSdl;

    if (composable && !fullSchemaSdl) {
      throw new Error('Version is composable but the full schema SDL is missing');
    }

    increaseSchemaPublishCountMetric('accepted');

    const changes = publishResult.state.changes ?? [];
    const messages = publishResult.state.messages ?? [];
    const initial = publishResult.state.initial;
    const pushedSchema = publishResult.state.schema;
    const schemas = [...publishResult.state.schemas];
    const schemaLogIds = schemas
      .filter(s => s.id !== pushedSchema.id) // do not include the incoming schema
      .map(s => s.id);

    const supergraph = publishResult.state.supergraph ?? null;

    this.logger.debug(`Assigning ${schemaLogIds.length} schemas to new version`);

    const schemaVersion = await this.schemaManager.createVersion({
      valid: composable,
      organization: organizationId,
      project: project.id,
      target: target.id,
      commit: input.commit,
      logIds: schemaLogIds,
      service: input.service,
      schema: input.sdl,
      author: input.author,
      url: input.url,
      base_schema: baseSchema,
      metadata: input.metadata ?? null,
      projectType: project.type,
      github,
      actionFn: async () => {
        if (composable && fullSchemaSdl) {
          await this.publishToCDN({
            target,
            project,
            supergraph,
            fullSchemaSdl,
            schemas,
          });
        }
      },
      changes,
      previousSchemaVersion: latestVersion?.version ?? null,
      ...(fullSchemaSdl
        ? {
            compositeSchemaSDL: fullSchemaSdl,
            supergraphSDL: supergraph,
            schemaCompositionErrors: null,
            tags: publishResult.state?.tags ?? null,
            contracts:
              publishResult.state.contracts?.map(contract => ({
                contractId: contract.contractId,
                contractName: contract.contractName,
                lastContractVersionId:
                  contractIdToLatestValidContractVersionId.get(contract.contractId) ?? null,
                compositeSchemaSDL: contract.fullSchemaSdl,
                supergraphSDL: contract.supergraph,
                schemaCompositionErrors: contract.compositionErrors,
                changes: contract.changes,
              })) ?? null,
          }
        : {
            compositeSchemaSDL: null,
            supergraphSDL: null,
            schemaCompositionErrors: assertNonNull(
              publishResult.state.compositionErrors,
              "Can't be null",
            ),
            tags: null,
            contracts: null,
          }),
    });

    if (changes.length > 0 || errors.length > 0) {
      void this.alertsManager
        .triggerSchemaChangeNotifications({
          organization,
          project,
          target,
          schema: {
            id: schemaVersion.id,
            commit: schemaVersion.actionId,
            valid: schemaVersion.isComposable,
          },
          changes,
          messages,
          errors,
          initial,
        })
        .catch(err => {
          this.logger.error('Failed to trigger schema change notifications', err);
        });
    }

    const linkToWebsite =
      typeof this.schemaModuleConfig.schemaPublishLink === 'function'
        ? this.schemaModuleConfig.schemaPublishLink({
            organization: {
              cleanId: organization.cleanId,
            },
            project: {
              cleanId: project.cleanId,
            },
            target: {
              cleanId: target.cleanId,
            },
            version: latestVersion
              ? {
                  id: schemaVersion.id,
                }
              : undefined,
          })
        : null;

    if (githubCheckRun) {
      return this.updateGithubCheckRunForSchemaPublish({
        githubCheckRun,
        force: false,
        initial: publishResult.state.initial,
        valid: publishResult.state.composable,
        changes: publishResult.state.changes ?? [],
        errors,
        messages: publishResult.state.messages ?? [],
        organizationId: organization.id,
        detailsUrl: linkToWebsite,
      });
    }

    return {
      __typename: 'SchemaPublishSuccess' as const,
      initial: publishResult.state.initial,
      valid: publishResult.state.composable,
      changes: modelVersion === 'legacy' ? publishResult.state.changes ?? [] : null,
      message: (publishResult.state.messages ?? []).join('\n'),
      linkToWebsite,
    };
  }

  /**
   * Returns `null` in case the check-run could not be created, which most likely indicates
   * missing permission for the GitHub App to access the GitHub repository.
   */
  private async createGithubCheckRunStartForSchemaCheck(args: {
    project: {
      orgId: string;
      cleanId: string;
      name: string;
      useProjectNameInGithubCheck: boolean;
    };
    target: Target;
    organization: Organization;
    serviceName: string | null;
    github: {
      owner: string;
      repository: string;
      sha: string;
    };
  }) {
    return await this.gitHubIntegrationManager.createCheckRun({
      name: buildGitHubActionCheckName({
        projectName: args.project.name,
        targetName: args.target.name,
        serviceName: args.serviceName,
        includeProjectName: args.project.useProjectNameInGithubCheck,
      }),
      sha: args.github.sha,
      organization: args.project.orgId,
      repositoryOwner: args.github.owner,
      repositoryName: args.github.repository,
      output: {
        title: 'Started schema check',
        summary: 'The schema check is on progress. Please wait until the result is reported.',
      },
      detailsUrl: null,
    });
  }

  private async updateGithubCheckRunForSchemaCheck({
    conclusion,
    changes,
    breakingChanges,
    compositionErrors,
    errors,
    warnings,
    schemaCheckId,
    ...args
  }: {
    organization: Organization;
    project: {
      orgId: string;
      cleanId: string;
      name: string;
      useProjectNameInGithubCheck: boolean;
    };
    target: Target;
    githubCheckRun: {
      owner: string;
      repository: string;
      id: number;
    };
    conclusion: SchemaCheckConclusion;
    warnings: SchemaCheckWarning[] | null;
    changes: Array<SchemaChangeType> | null;
    breakingChanges: Array<SchemaChangeType> | null;
    compositionErrors: Array<{
      message: string;
    }> | null;
    errors: Array<{
      message: string;
    }> | null;
    schemaCheckId: string | null;
  }) {
    try {
      let title: string;
      let summary: string;

      if (conclusion === SchemaCheckConclusion.Success) {
        if (!changes || changes.length === 0) {
          title = 'No changes';
          summary = 'No changes detected';
        } else {
          title = 'No breaking changes';
          summary = this.changesToMarkdown(changes);
        }
      } else {
        const total =
          (compositionErrors?.length ?? 0) + (breakingChanges?.length ?? 0) + (errors?.length ?? 0);

        title = `Detected ${total} error${total === 1 ? '' : 's'}`;
        summary = [
          errors ? this.errorsToMarkdown(errors) : null,
          warnings ? this.warningsToMarkdown(warnings) : null,
          compositionErrors ? this.errorsToMarkdown(compositionErrors) : null,
          breakingChanges ? this.errorsToMarkdown(breakingChanges) : null,
          changes ? this.changesToMarkdown(changes) : null,
        ]
          .filter(Boolean)
          .join('\n\n');
      }

      const checkRun = await this.gitHubIntegrationManager.updateCheckRun({
        organizationId: args.project.orgId,
        conclusion: conclusion === SchemaCheckConclusion.Success ? 'success' : 'failure',
        githubCheckRun: args.githubCheckRun,
        output: {
          title,
          summary: summary.length > 60_000 ? summary.slice(0, 60_000) + '...' : summary,
        },
        detailsUrl:
          (schemaCheckId &&
            this.schemaModuleConfig.schemaCheckLink?.({
              project: args.project,
              target: args.target,
              organization: args.organization,
              schemaCheckId,
            })) ||
          null,
      });

      return {
        __typename: 'GitHubSchemaCheckSuccess' as const,
        message: 'Check-run created',
        checkRun,
      };
    } catch (error: any) {
      Sentry.captureException(error);
      return {
        __typename: 'GitHubSchemaCheckError' as const,
        message: `Failed to create the check-run`,
      };
    }
  }

  @sentry('SchemaPublisher.publishToCDN')
  private async publishToCDN({
    target,
    project,
    supergraph,
    fullSchemaSdl,
    schemas,
  }: {
    target: Target;
    project: Project;
    supergraph: string | null;
    fullSchemaSdl: string;
    schemas: readonly Schema[];
  }) {
    const publishMetadata = async () => {
      const metadata: Array<Record<string, any>> = [];
      for (const schema of schemas) {
        if (typeof schema.metadata === 'string') {
          metadata.push(JSON.parse(schema.metadata));
        }
      }

      if (metadata.length > 0) {
        await this.artifactStorageWriter.writeArtifact({
          targetId: target.id,
          // SINGLE project can have only one metadata, we need to pass it as an object,
          // COMPOSITE projects can have multiple metadata, we need to pass it as an array
          artifact: project.type === ProjectType.SINGLE ? metadata[0] : metadata,
          artifactType: 'metadata',
        });
      }
    };

    const publishCompositeSchema = async () => {
      const compositeSchema = ensureCompositeSchemas(schemas);

      await Promise.all([
        await this.artifactStorageWriter.writeArtifact({
          targetId: target.id,
          artifactType: 'services',
          artifact: compositeSchema.map(s => ({
            name: s.service_name,
            sdl: s.sdl,
            url: s.service_url,
          })),
        }),
        this.artifactStorageWriter.writeArtifact({
          targetId: target.id,
          artifactType: 'sdl',
          artifact: fullSchemaSdl,
        }),
      ]);
    };

    const publishSingleSchema = async () => {
      await this.artifactStorageWriter.writeArtifact({
        targetId: target.id,
        artifactType: 'sdl',
        artifact: fullSchemaSdl,
      });
    };

    const actions = [
      project.type === ProjectType.SINGLE ? publishSingleSchema() : publishCompositeSchema(),
      publishMetadata(),
    ];

    if (project.type === ProjectType.FEDERATION) {
      if (supergraph) {
        this.logger.debug('Publishing supergraph to CDN');

        actions.push(
          this.artifactStorageWriter.writeArtifact({
            targetId: target.id,
            artifactType: 'supergraph',
            artifact: supergraph,
          }),
        );
      }
    }

    await Promise.all(actions);
  }

  private async createGithubCheckRunForSchemaPublish(args: {
    organizationId: string;
    github: {
      owner: string;
      repository: string;
      sha: string;
    };
  }) {
    return await this.gitHubIntegrationManager.createCheckRun({
      name: 'GraphQL Hive - schema:publish',
      sha: args.github.sha,
      organization: args.organizationId,
      repositoryOwner: args.github.owner,
      repositoryName: args.github.repository,
      output: {
        title: 'Started schema check',
        summary: 'The schema check is on progress. Please wait until the result is reported.',
      },
      detailsUrl: null,
    });
  }

  private async updateGithubCheckRunForSchemaPublish({
    initial,
    force,
    valid,
    changes,
    errors,
    messages,
    organizationId,
    githubCheckRun,
    detailsUrl,
  }: {
    organizationId: string;
    githubCheckRun: {
      owner: string;
      repository: string;
      id: number;
    };
    initial: boolean;
    force?: boolean | null;
    valid: boolean;
    changes: Array<SchemaChangeType>;
    errors: readonly Types.SchemaError[];
    messages?: string[];
    detailsUrl: string | null;
  }) {
    try {
      let title: string;
      let summary: string;

      if (valid) {
        if (initial) {
          title = 'Schema published';
          summary = 'Initial Schema published';
        } else if (changes.length === 0) {
          title = 'No changes';
          summary = 'No changes detected';
        } else {
          title = 'No breaking changes';
          summary = this.changesToMarkdown(changes);
        }
      } else {
        title = `Detected ${errors.length} error${errors.length === 1 ? '' : 's'}`;
        summary = [
          errors ? this.errorsToMarkdown(errors) : null,
          changes ? this.changesToMarkdown(changes) : null,
        ]
          .filter(Boolean)
          .join('\n\n');
      }

      if (messages?.length) {
        summary += `\n\n${messages.map(val => `- ${val}`).join('\n')}`;
      }

      if (valid === false && force === true) {
        title += ' (forced)';
      }

      await this.gitHubIntegrationManager.updateCheckRun({
        githubCheckRun,
        conclusion: valid ? 'success' : force ? 'neutral' : 'failure',
        organizationId,
        output: {
          title,
          summary,
        },
        detailsUrl,
      });
      return {
        __typename: 'GitHubSchemaPublishSuccess',
        message: title,
      } as const;
    } catch (error: unknown) {
      Sentry.captureException(error);
      return {
        __typename: 'GitHubSchemaPublishError',
        message: `Failed to create the check-run`,
      } as const;
    }
  }

  private errorsToMarkdown(errors: ReadonlyArray<{ message: string }>): string {
    return ['', ...errors.map(error => `- ${bolderize(error.message)}`)].join('\n');
  }

  private warningsToMarkdown(warnings: SchemaCheckWarning[]): string {
    return [
      '',
      ...warnings.map(warning => {
        const details = [warning.source ? `source: ${warning.source}` : undefined]
          .filter(Boolean)
          .join(', ');

        return `- ${bolderize(warning.message)}${details ? ` (${details})` : ''}`;
      }),
    ].join('\n');
  }

  private changesToMarkdown(changes: ReadonlyArray<SchemaChangeType>): string {
    const breakingChanges = changes.filter(filterChangesByLevel(CriticalityLevel.Breaking));
    const dangerousChanges = changes.filter(filterChangesByLevel(CriticalityLevel.Dangerous));
    const safeChanges = changes.filter(filterChangesByLevel(CriticalityLevel.NonBreaking));

    const lines: string[] = [
      `## Found ${changes.length} change${changes.length > 1 ? 's' : ''}`,
      '',
    ];

    if (breakingChanges.length) {
      lines.push(`Breaking: ${breakingChanges.length}`);
    }

    if (dangerousChanges.length) {
      lines.push(`Dangerous: ${dangerousChanges.length}`);
    }

    if (safeChanges.length) {
      lines.push(`Safe: ${safeChanges.length}`);
    }

    writeChanges('Breaking', breakingChanges, lines);
    writeChanges('Dangerous', dangerousChanges, lines);
    writeChanges('Safe', safeChanges, lines);

    return lines.join('\n');
  }
}

function filterChangesByLevel(level: CriticalityLevel) {
  return (change: SchemaChangeType) => change.criticality === level;
}

function writeChanges(
  type: string,
  changes: ReadonlyArray<{ message: string }>,
  lines: string[],
): void {
  if (changes.length > 0) {
    lines.push(
      ...['', `### ${type} changes`].concat(
        changes.map(change => ` - ${bolderize(change.message)}`),
      ),
    );
  }
}

function buildGitHubActionCheckName(input: {
  targetName: string;
  projectName: string;
  serviceName: string | null;
  includeProjectName: boolean;
}) {
  const path = [
    input.includeProjectName ? input.projectName : null,
    input.targetName,
    input.serviceName,
  ].filter((val): val is string => typeof val === 'string');

  return `GraphQL Hive > schema:check > ${path.join(' > ')}`;
}

function tryPrettifySDL(sdl: string): string {
  try {
    return print(parse(sdl));
  } catch {
    return sdl;
  }
}

const millisecondsPerDay = 60 * 60 * 24 * 1000;

const SchemaCheckContextIdModel = z
  .string()
  .min(1, {
    message: 'Context ID must be at least 1 character long.',
  })
  .max(200, {
    message: 'Context ID cannot exceed length of 200 characters.',
  });

function createSDLHash(sdl: string): string {
  return hashSDL(
    parse(sdl, {
      noLocation: true,
    }),
  );
}
