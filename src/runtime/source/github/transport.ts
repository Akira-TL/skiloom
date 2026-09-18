import type {
  GitHubRepositoryTransport
} from "./repository.js";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_ACCEPT = "application/vnd.github+json";

export type GitHubFetchTransportOptions = Readonly<{
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  userAgent?: string;
}>;

export function createGitHubRepositoryFetchTransport(
  options: GitHubFetchTransportOptions = {}
): GitHubRepositoryTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = stripTrailingSlash(
    options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL
  );
  const userAgent = options.userAgent ?? "skiloom";

  return async (request) => {
    const url =
      apiBaseUrl +
      "/repos/" +
      encodeURIComponent(request.repository.owner) +
      "/" +
      encodeURIComponent(request.repository.repo);
    const headers: Record<string, string> = {
      Accept: GITHUB_ACCEPT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": userAgent
    };
    if (request.credential !== undefined) {
      headers.Authorization = "Bearer " + request.credential;
    }

    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "follow"
    });

    return {
      status: response.status,
      body: await readJsonBody(response)
    };
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
