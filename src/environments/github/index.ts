// PURPOSE: Barrel export for the GitHub environment adapter
// PURPOSE: Re-exports adapter, types, and mapper utilities

export { GitHubEnvironment } from './adapter.js';
export type {
  GitHubEnvConfig, GitHubIssue, GitHubPullRequest, GitHubReview,
  ConcentrationMapper, PRConcentrationMapper, ReviewState,
} from './types.js';
export {
  defaultTypeMapper,
  defaultPayloadMapper,
  defaultConcentrationMapper,
  defaultDependencyMapper,
  defaultPRTypeMapper,
  defaultPRPayloadMapper,
  defaultPRConcentrationMapper,
  resolveReviewState,
  parseDependencyIds,
  computeFreshness,
  parseGolemBody,
} from './mapper.js';
export type { GolemBodySections } from './mapper.js';
