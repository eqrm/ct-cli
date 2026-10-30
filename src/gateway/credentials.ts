import { askVisible } from "../ui/prompt.js";
import type { AwsCredentials } from "./proxy.js";

/**
 * Credentials for the gateway reader role: the AWS profile assumes the role with MFA, prompting for the
 * code on the terminal. Lazy-imports the AWS SDK so plain `ct` commands never load it. Each call runs a
 * fresh assume-role (and so a fresh MFA prompt); {@link cachingCredentials} decides when to call.
 */
export function profileCredentials(profile: string): () => Promise<AwsCredentials> {
  return async () => {
    const { fromIni } = await import("@aws-sdk/credential-providers");
    const provider = fromIni({
      profile,
      mfaCodeProvider: (serial: string) => askVisible(`MFA code for ${serial}: `).then((c) => c.trim()),
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
