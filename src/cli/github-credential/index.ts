export type GitHubCredentialEnvironment = Readonly<{
  GH_TOKEN?: string;
  GITHUB_TOKEN?: string;
}>;

export function resolveGitHubCredentialEnvironment(
  environment: GitHubCredentialEnvironment
): string | undefined {
  for (const value of [
    environment.GH_TOKEN,
    environment.GITHUB_TOKEN
  ]) {
    const credential = value?.trim();
    if (credential !== undefined && credential.length > 0) {
      return credential;
    }
  }
  return undefined;
}
