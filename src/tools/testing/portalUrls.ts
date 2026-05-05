/**
 * Power Platform portal navigation builders.
 *
 * Generates step-by-step UI navigation instructions for the CUA agent.
 * Deep-link URLs with environment IDs don't reliably resolve to the correct
 * pages, and the CUA reads the screen visually — it cannot match environment
 * IDs. Instead we provide the portal base URL and navigation-by-name steps.
 * Portal host is configurable to support sovereign clouds.
 */

const DEFAULT_PORTAL_HOST = "make.powerapps.com";

export interface PortalNavigation {
  /** Portal base URL to open. */
  readonly startUrl: string;
  /** Step-by-step navigation instructions using visible UI elements. */
  readonly navigation: string;
  /** The connector display name to search for. */
  readonly searchTerm: string;
}

/**
 * Build navigation instructions to reach the connector detail page.
 */
export function connectorPageNav(
  environmentName: string,
  displayName: string,
  portalHost: string = DEFAULT_PORTAL_HOST,
): PortalNavigation {
  return {
    startUrl: `https://${portalHost}`,
    navigation:
      `1. Open https://${portalHost}\n` +
      `2. Check the environment name in the top-right header\n` +
      `3. If it does not show "${environmentName}", click the environment picker and select "${environmentName}"\n` +
      `4. In the left navigation, click "More" then "Discover all"\n` +
      `5. Search for or select "Custom connectors"\n` +
      `6. Find the connector named "${displayName}"`,
    searchTerm: displayName,
  };
}

/**
 * Build navigation instructions to create a new connection for a connector.
 */
export function newConnectionNav(
  environmentName: string,
  displayName: string,
  portalHost: string = DEFAULT_PORTAL_HOST,
): PortalNavigation {
  return {
    startUrl: `https://${portalHost}`,
    navigation:
      `1. Open https://${portalHost}\n` +
      `2. Check the environment name in the top-right header\n` +
      `3. If it does not show "${environmentName}", click the environment picker and select "${environmentName}"\n` +
      `4. Navigate to Custom connectors\n` +
      `5. Find the connector named "${displayName}" and click Edit\n` +
      `6. Go to the "Test" tab\n` +
      `7. Click "+ New connection" to create a connection`,
    searchTerm: displayName,
  };
}

/**
 * Build navigation instructions to the connector test tab.
 */
export function connectorTestTabNav(
  environmentName: string,
  displayName: string,
  portalHost: string = DEFAULT_PORTAL_HOST,
): PortalNavigation {
  return {
    startUrl: `https://${portalHost}`,
    navigation:
      `1. Open https://${portalHost}\n` +
      `2. Check the environment name in the top-right header\n` +
      `3. If it does not show "${environmentName}", click the environment picker and select "${environmentName}"\n` +
      `4. Navigate to Custom connectors\n` +
      `5. Find the connector named "${displayName}" and click Edit\n` +
      `6. Go to the "Test" tab`,
    searchTerm: displayName,
  };
}

/**
 * Build the portal base URL (no deep links — CUA navigates by name).
 */
export function portalBaseUrl(
  portalHost: string = DEFAULT_PORTAL_HOST,
): string {
  return `https://${portalHost}`;
}
