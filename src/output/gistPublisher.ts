/**
 * GitHub Gist publisher.
 * Creates a gist containing generated connector files and returns shareable URLs.
 */

import * as https from "https";
import { log, logWarn } from "../logging/logger";

export interface GistFile {
  readonly filename: string;
  readonly content: string;
}

export interface GistResult {
  readonly gistUrl: string;
  readonly rawUrls: Record<string, string>;
  readonly gistId: string;
}

export const GIST_TOKEN_ENV_VAR = "GRAPH_CONNECTOR_GIST_TOKEN";
const LEGACY_GIST_TOKEN_ENV_VAR = "GIST_GITHUB_TOKEN";

export async function publishToGist(
  files: readonly GistFile[],
  description: string,
  isPublic: boolean,
  token: string
): Promise<GistResult | null> {
  if (!token) {
    logWarn("No GitHub token provided — skipping gist publish.");
    return null;
  }

  if (files.length === 0) {
    logWarn("No files to publish to gist.");
    return null;
  }

  const gistFiles: Record<string, { content: string }> = {};
  for (const f of files) {
    gistFiles[f.filename] = { content: f.content };
  }

  const payload = JSON.stringify({
    description,
    public: isPublic,
    files: gistFiles,
  });

  return new Promise<GistResult | null>((resolve) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: "/gists",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "graph-connector-factory",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");

          if (res.statusCode !== 201) {
            logWarn(`Gist creation failed (HTTP ${res.statusCode ?? "unknown"}): ${body.slice(0, 200)}`);
            resolve(null);
            return;
          }

          try {
            const data = JSON.parse(body) as {
              id: string;
              html_url: string;
              files: Record<string, { raw_url: string }>;
            };

            const rawUrls: Record<string, string> = {};
            for (const [name, info] of Object.entries(data.files)) {
              rawUrls[name] = info.raw_url;
            }

            log(`Gist created: ${data.html_url}`);
            resolve({
              gistUrl: data.html_url,
              rawUrls,
              gistId: data.id,
            });
          } catch {
            logWarn("Failed to parse gist API response.");
            resolve(null);
          }
        });
      }
    );

    req.on("error", (err) => {
      logWarn(`Gist publish error: ${err.message}`);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

export function getGitHubToken(): string | undefined {
  return process.env[GIST_TOKEN_ENV_VAR]
    ?? process.env[LEGACY_GIST_TOKEN_ENV_VAR]
    ?? undefined;
}
