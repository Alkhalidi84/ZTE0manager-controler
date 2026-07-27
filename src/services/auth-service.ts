import type { GoformClient } from '@/api';
import { HiLinkClient } from '@/api/hilink-client';
import { sha256Upper, toBase64 } from '@/api/crypto';

/**
 * Native router login. ZTE firmwares use one of two password encodings:
 *
 *   modern (verified on the reference MC801A1):
 *     SHA256(x) returns UPPERCASE hex     (util.js: hex table flag d = 1)
 *     LD  = GET goform_get_cmd_process?cmd=LD    // per-attempt salt (uppercase)
 *     password = SHA256( SHA256(rawPassword) + LD )
 *   legacy:
 *     password = Base64(rawPassword)      // no LD/RD commands at all
 *
 * Scheme detection (verified against the LIVE reference device, 2026-07-27):
 * `WEB_ATTR_IF_SUPPORT_SHA256` reads EMPTY before login even on SHA-256
 * firmware, so the flag alone cannot decide. The real discriminator is the LD
 * salt itself — only the SHA-256 login has a salt command; legacy firmware
 * answers `""`. Flag `0` (explicit legacy) forces Base64.
 *
 * POST goformId=LOGIN, password=<encoded>. The post is sent with best-effort
 * RD/AD tokens ('try'): modern firmware accepts (and may expect) them, while
 * legacy firmware has no RD command at all — login there must go out unsigned
 * instead of dying on "Could not read RD token". Retries are disabled so a
 * wrong password is never hammered into the firmware's failed-attempt lockout;
 * only a heuristic scheme choice gets ONE fallback attempt with the other
 * encoding — at most two counted attempts per user click.
 *
 * Doing this in-app (instead of a separate router-login window) guarantees the
 * resulting session lives in the same request context that performs every other
 * call — which is why band/cell locks were failing before.
 *
 * Result codes (verified in service.js): "0"/"4" = success; "2" = another user
 * already logged in (duplicateUser); "3" = wrong password (badPassword);
 * "1" = login fail; "5" = not logged in. Legacy builds may answer plain
 * "failure" instead of a code.
 */

export interface LoginResult {
  ok: boolean;
  code: string | undefined;
  /** Transport/connection detail (set when code === 'unreachable'). */
  message?: string;
}

type LoginScheme = 'sha256-ld' | 'base64';

/** Scheme that actually worked for this client — skips any further fallback. */
const knownScheme = new WeakMap<GoformClient, LoginScheme>();
/** Clients that already spent their single Base64 fallback attempt. */
const fallbackSpent = new WeakSet<GoformClient>();

function isSuccessCode(code: string | undefined): boolean {
  return code === '0' || code === '4';
}

/** Codes that mean "the password was checked and rejected" (fallback-worthy). */
function isPasswordReject(code: string | undefined): boolean {
  if (code === undefined) return false;
  return code === '1' || code === '3' || /fail/i.test(code);
}

async function attemptLogin(
  client: GoformClient,
  scheme: LoginScheme,
  password: string,
  ld: string,
): Promise<string | undefined> {
  const encoded =
    scheme === 'sha256-ld' ? sha256Upper(sha256Upper(password) + ld) : toBase64(password);
  const res = await client.set({
    goformId: 'LOGIN',
    params: { password: encoded },
    retry: false,
    tokens: 'try',
  });
  return res.result;
}

export async function login(client: GoformClient, password: string): Promise<LoginResult> {
  // Huawei HiLink devices (5G CPE 5 / H155) use SCRAM instead of the ZTE flow.
  if (client instanceof HiLinkClient) return client.login(password);

  const flag = ((await client.getValue('WEB_ATTR_IF_SUPPORT_SHA256')) ?? '').trim();
  // LD is read as a SINGLE cmd, exactly like the stock login page does — the
  // shape verified against the live reference device. Its presence (not the
  // often-empty flag) is what tells SHA-256 firmware apart from legacy.
  const ld = flag === '0' ? '' : ((await client.getValue('LD')) ?? '').trim();
  const useSha = flag !== '0' && (flag !== '' || ld !== '');

  const remembered = knownScheme.get(client);
  const primary: LoginScheme = remembered ?? (useSha ? 'sha256-ld' : 'base64');
  const code = await attemptLogin(client, primary, password, ld);
  if (isSuccessCode(code)) {
    knownScheme.set(client, primary);
    return { ok: true, code };
  }

  // SHA-256 chosen heuristically (no explicit flag, or no salt to hash with)
  // → a definite reject earns ONE Base64 fallback per session, so a mistyped
  // password can never double-feed the firmware's failed-attempt lockout.
  // Explicit or proven choices are authoritative: a reject means the password
  // really is wrong.
  const heuristic =
    remembered === undefined && primary === 'sha256-ld' && (flag === '' || ld === '');
  if (heuristic && isPasswordReject(code) && !fallbackSpent.has(client)) {
    fallbackSpent.add(client);
    const second = await attemptLogin(client, 'base64', password, '');
    if (isSuccessCode(second)) {
      knownScheme.set(client, 'base64');
      return { ok: true, code: second };
    }
    return { ok: false, code: second ?? code };
  }
  return { ok: false, code };
}

export async function logout(client: GoformClient): Promise<void> {
  try {
    await client.set({ goformId: 'LOGOUT', retry: false, tokens: 'try' });
  } catch {
    /* best effort */
  }
}

const LOGIN_MESSAGES: Record<string, string> = {
  '1': 'Login failed',
  '2': 'Another user is already logged in (log out the router web page / other device first)',
  '3': 'Wrong password',
  '5': 'Session expired — try again',
  unreachable: 'Could not reach the router — check that you are on its Wi-Fi/network',
  // Huawei HiLink codes (5G CPE 5 / H155).
  '108006': 'Wrong password',
  '108007': 'Too many wrong attempts — wait a minute and try again',
  '108003': 'Another user is already logged in (log out the router web page / other device first)',
  '125003': 'Session conflict — close the router web page in other tabs/apps, then try again',
};

export function loginErrorMessage(code: string | undefined): string {
  return (code && LOGIN_MESSAGES[code]) || 'Login failed';
}
