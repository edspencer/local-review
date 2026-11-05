// Linux's linger (cli-contract SPEC §7): without it, systemd stops the user's manager, and the service with it, at
// their last logout, SSH sessions included. `service install` and `doctor` ask `loginctl`, and print the
// `sudo loginctl enable-linger` line only when it's off. Local Review never runs sudo itself, and says nothing when
// loginctl can't answer (no loginctl, no logind: a container).
import { execFile } from 'node:child_process';
import os from 'node:os';

/** `loginctl show-user <user> -p Linger`: true, false, or null when it can't say (no loginctl, no logind). */
export function lingerOf(user: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('loginctl', ['show-user', user, '-p', 'Linger'], { timeout: 5000 }, (err, stdout) => {
      const m = /^Linger=(yes|no)$/m.exec(String(stdout ?? ''));
      resolve(err || !m ? null : m[1] === 'yes');
    });
  });
}

/** Whose linger: $USER, else the account running this. */
export const lingerUser = (env: NodeJS.ProcessEnv): string => env.USER || os.userInfo().username;

/**
 * What `service install` prints for a linger that's off (from cli-contract reference/service/index.ts's
 * `lingerAdvice`): undefined when it's on, or when loginctl couldn't say.
 */
export function lingerAdvice(on: boolean | null, user: string): string | undefined {
  if (on !== false) return undefined;
  return `Linger is off for ${user}, so the service stops when you log out, SSH sessions included, and starts only when you log in. To keep Local Review running, once:\n    sudo loginctl enable-linger ${user}`;
}
