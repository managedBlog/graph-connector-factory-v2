/**
 * Power Platform portal URL builders.
 *
 * Generates deep links into the make.powerapps.com portal for connector
 * testing, with fallback UI navigation paths for when URLs change format.
 * Portal host is configurable to support sovereign clouds.
 */

const DEFAULT_PORTAL_HOST = "make.powerapps.com";

export interface PortalUrl {
  /** Direct deep link URL. */
  readonly url: string;
  /** Fallback: human-readable UI navigation instructions. */
  readonly fallback: {
    readonly searchPath: string;
    readonly searchTerm: string;
  };
}

/**
 * Build the connector detail / test page URL.
 */
export function connectorPageUrl(
  environmentId: string,
  connectorId: string,
  displayName: string,
  portalHost: string = DEFAULT_PORTAL_HOST,
): PortalUrl {
  const url =
    `https://${portalHost}/environments/${environmentId}` +
    `/connections/available/${encodeURIComponent(connectorId)}`;

  return {
    url,
    fallback: {
      searchPath:
        `Open https://${portalHost} → select environment → ` +
        `Custom connectors → search for '${displayName}'`,
      searchTerm: displayName,
    },
  };
}

/**
 * Build the "create new connection" page URL for a connector.
 */
export function newConnectionUrl(
  environmentId: string,
  connectorId: string,
  displayName: string,
  portalHost: string = DEFAULT_PORTAL_HOST,
): PortalUrl {
  const url =
    `https://${portalHost}/environments/${environmentId}` +
    `/connections/available/${encodeURIComponent(connectorId)}/create`;

  return {
    url,
    fallback: {
      searchPath:
        `Open https://${portalHost} → select environment → ` +
        `Connections → New connection → search for '${displayName}'`,
      searchTerm: displayName,
    },
  };
}

/**
 * Build the connector test tab URL.
 * Power Platform exposes a "Test" tab on custom connectors for in-portal testing.
 */
export function connectorTestTabUrl(
  environmentId: string,
  connectorId: string,
  displayName: string,
  portalHost: string = DEFAULT_PORTAL_HOST,
): PortalUrl {
  const url =
    `https://${portalHost}/environments/${environmentId}` +
    `/customconnectors/${encodeURIComponent(connectorId)}/test`;

  return {
    url,
    fallback: {
      searchPath:
        `Open https://${portalHost} → select environment → ` +
        `Custom connectors → '${displayName}' → Edit → Test tab`,
      searchTerm: displayName,
    },
  };
}

/**
 * Build the connections list URL for the environment.
 */
export function connectionsListUrl(
  environmentId: string,
  portalHost: string = DEFAULT_PORTAL_HOST,
): string {
  return `https://${portalHost}/environments/${environmentId}/connections`;
}
