import { askVisible } from "../ui/prompt.js";
import type { AwsCredentials } from "./proxy.js";

type FromIni = (init: {
  profile: string;
  mfaCodeProvider: (serial: string) => Promise<string>;
}) => () => Promise<AwsCredentials>;

export interface ProfileCredentialsDeps {
  /** Defaults to `fromIni` of the AWS SDK, lazy-imported so plain `ct` commands never load it. */
  fromIni?: FromIni;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
}

/**
 * Credentials for the gateway reader role: the AWS profile assumes the role. The normal profile has no
 * `mfa_serial`, so there is never a prompt and every refresh is silent. A profile that does have one
 * asks for the code on the terminal, and fails at once when there is no terminal to ask (a Claude Code
 * session, a launchd job) instead of hanging on stdin. Each call runs a fresh assume-role;
 * {@link cachingCredentials} decides when to call.
 */
export function profileCredentials(
  profile: string,
  deps: ProfileCredentialsDeps = {},
): () => Promise<AwsCredentials> {
  return async () => {
    const fromIni = deps.fromIni ?? ((await import("@aws-sdk/credential-providers")).fromIni as FromIni);
    const provider = fromIni({
      profile,
      mfaCodeProvider: (serial: string) => {
        if (!(deps.isTTY ?? Boolean(process.stdin.isTTY))) {
          return Promise.reject(
            new Error(
              `AWS profile "${profile}" requires MFA (${serial}); start \`ct gateway proxy\` in your own terminal.`,
            ),
          );
        }
        const ask = deps.ask ?? askVisible;
        return ask(`MFA code for ${serial}: `).then((c) => c.trim());
      },
    });
    const c = await provider();
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      expiration: c.expiration,
    };
  };
}
