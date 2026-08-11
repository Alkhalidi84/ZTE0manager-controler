import {
  GoformError,
  type GetCommandRequest,
  type GoformGetResult,
  type GoformSetResult,
  type SetCommandRequest,
} from '@/types';

import {
  GOFORM_GET_ENDPOINT,
  GOFORM_SET_ENDPOINT,
} from '@/reverse/knowledge/seed';

import {
  classicZteAuth,
  type AuthStrategy,
} from './auth';

import {
  httpRequest,
  type HttpResult,
} from './transport';

import {
  md5,
  sha256Upper,
} from './crypto';

/**
 * Observability event emitted for every request the client performs.
 */
export interface GoformTrafficEvent {
  id: string;
  timestamp: number;
  method: 'GET' | 'POST';
  endpoint: string;
  label: string;
  params: Record<string, string>;
  durationMs: number;
  ok: boolean;
  status?: number;
  responsePreview?: string;
  error?: string;
}

export interface GoformClientConfig {
  /**
   * Base URL prefix.
   *
   * Empty string means same-origin. This is the recommended mode
   * for Vite/Electron/local proxy operation.
   */
  baseUrl?: string;

  /**
   * Authentication/signature strategy.
   */
  authStrategy?: AuthStrategy;

  /**
   * Request timeout.
   */
  timeoutMs?: number;

  /**
   * Developer-mode traffic logger.
   */
  onTraffic?: (event: GoformTrafficEvent) => void;
}

/**
 * ZTE request hash family.
 *
 * Older ZTE firmware:
 *
 *   AD = MD5(MD5(version + cr) + RD)
 *
 * Newer firmware, including firmware families using SHA-256:
 *
 *   AD = SHA256(SHA256(version + cr) + RD)
 */
type AdHashMode = 'md5' | 'sha256';

/**
 * Detect the hash family from the firmware identity.
 *
 * MC888 / MC889 are known SHA-256 families.
 *
 * G5B is explicitly included because the live G5B request captured
 * from the stock WebUI produced a 64-character hexadecimal AD value.
 */
function getAdHashMode(
  waInnerVersion: string,
  crVersion: string,
): AdHashMode {
  const version = `${waInnerVersion} ${crVersion}`.toUpperCase();

  if (
    version.includes('MC888') ||
    version.includes('MC889') ||
    version.includes('G5B')
  ) {
    return 'sha256';
  }

  return 'md5';
}

/**
 * Calculate the ZTE AD token.
 *
 * IMPORTANT:
 *
 * The G5B stock WebUI request observed in Firefox contains:
 *
 *   isTest=false
 *   goformId=BAND_SELECT
 *   is_gw_band=0
 *   gw_band_mask=0
 *   is_lte_band=1
 *   lte_band_mask=<mask>
 *   AD=<64 hexadecimal characters>
 *
 * Therefore G5B must not use the old 32-character MD5 AD.
 */
function computeAd(
  mode: AdHashMode,
  rd: string,
  waInnerVersion: string,
  crVersion: string,
): string {
  const source = `${waInnerVersion}${crVersion}`;

  if (mode === 'sha256') {
    const first = sha256Upper(source);
    return sha256Upper(`${first}${rd}`);
  }

  const first = md5(source);
  return md5(`${first}${rd}`);
}

/**
 * The single choke point for all router traffic.
 */
export class GoformClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * Keep the selected authentication strategy.
   *
   * The strategy is used as the authoritative/default hash-family hint
   * when it exposes one. Firmware detection remains the fallback because
   * the G5B stock WebUI has been observed directly using SHA-256 AD.
   */
  private authStrategy: AuthStrategy;

  private readonly onTraffic:
    | ((event: GoformTrafficEvent) => void)
    | undefined;

  private eventSeq = 0;

  /**
   * Cached firmware identity.
   *
   * It is cached only after cr_version is available.
   */
  private versionCache: {
    waInnerVersion: string;
    crVersion: string;
  } | null = null;

  constructor(config: GoformClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? '';
    this.timeoutMs = config.timeoutMs ?? 10_000;

    this.authStrategy =
      config.authStrategy ?? classicZteAuth;

    this.onTraffic = config.onTraffic;
  }

  private emit(
    event: Omit<
      GoformTrafficEvent,
      'id' | 'timestamp'
    >,
  ): void {
    if (!this.onTraffic) return;

    this.onTraffic({
      ...event,
      id: `req-${Date.now()}-${this.eventSeq++}`,
      timestamp: Date.now(),
    });
  }

  setAuthStrategy(
    strategy: AuthStrategy,
  ): void {
    this.authStrategy = strategy;
    this.versionCache = null;
  }

  /**
   * Determine whether the currently selected auth strategy explicitly
   * requests SHA-256.
   *
   * The project has historically used classicZteAuth as the default
   * strategy. Some strategy implementations may expose a hash mode;
   * firmware detection remains authoritative for known hardware such
   * as G5B.
   */
  private getStrategyHashMode(): AdHashMode | null {
    const strategy = this.authStrategy as unknown as Record<
      string,
      unknown
    >;

    const candidates = [
      strategy.adHashMode,
      strategy.hashMode,
      strategy.mode,
    ];

    for (const value of candidates) {
      if (typeof value !== 'string') continue;

      const normalized = value.trim().toLowerCase();

      if (
        normalized === 'sha256' ||
        normalized === 'sha-256'
      ) {
        return 'sha256';
      }

      if (normalized === 'md5') {
        return 'md5';
      }
    }

    return null;
  }

  /**
   * Cheap ZTE protocol probe.
   */
  static async probe(
    baseUrl: string,
    timeoutMs = 4_000,
  ): Promise<boolean> {
    try {
      const client = new GoformClient({
        baseUrl,
        timeoutMs,
      });

      await client.get({
        cmd: [
          'model_name',
          'wa_inner_version',
          'modem_main_state',
          'signalbar',
        ],
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read one or more ZTE commands.
   */
  async get(
    request: GetCommandRequest,
  ): Promise<GoformGetResult> {
    const cmds = Array.isArray(request.cmd)
      ? request.cmd
      : [request.cmd];

    const multi =
      request.multi ?? cmds.length > 1;

    const params = new URLSearchParams();

    params.set('isTest', 'false');
    params.set('cmd', cmds.join(','));

    if (multi) {
      params.set('multi_data', '1');
    }

    const url =
      `${this.baseUrl}${GOFORM_GET_ENDPOINT}?${params.toString()}`;

    const started = performance.now();

    try {
      const res =
        await this.fetchWithTimeout(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });

      if (!res.ok) {
        throw new GoformError(
          `GET failed (${res.status})`,
          {
            endpoint:
              GOFORM_GET_ENDPOINT,
            command:
              cmds.join(','),
            status:
              res.status,
          },
        );
      }

      const data =
        this.parseJson<GoformGetResult>(
          res,
          GOFORM_GET_ENDPOINT,
          cmds.join(','),
        );

      this.emit({
        method: 'GET',
        endpoint:
          GOFORM_GET_ENDPOINT,
        label:
          cmds.join(','),
        params: {
          cmd: cmds.join(','),
          ...(multi
            ? { multi_data: '1' }
            : {}),
        },
        durationMs:
          Math.round(
            performance.now() - started,
          ),
        ok: true,
        status:
          res.status,
        responsePreview:
          JSON.stringify(data).slice(
            0,
            2000,
          ),
      });

      return data;
    } catch (err) {
      this.emit({
        method: 'GET',
        endpoint:
          GOFORM_GET_ENDPOINT,
        label:
          cmds.join(','),
        params: {
          cmd: cmds.join(','),
        },
        durationMs:
          Math.round(
            performance.now() - started,
          ),
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : String(err),
      });

      throw err;
    }
  }

  /**
   * Read one command.
   */
  async getValue(
    cmd: string,
  ): Promise<string | null> {
    const result =
      await this.get({ cmd });

    return result[cmd] ?? null;
  }

  /**
   * Send an authenticated action.
   *
   * Important G5B behavior:
   *
   * 1. Load wa_inner_version + cr_version.
   * 2. Read a fresh RD.
   * 3. Calculate AD immediately.
   * 4. Send POST.
   *
   * RD is NOT included in the POST body.
   *
   * Only AD is sent.
   */
  async set(
    request: SetCommandRequest,
  ): Promise<GoformSetResult> {
    const authenticated =
      request.authenticated ?? true;

    const maxAttempts =
      authenticated &&
      request.retry !== false
        ? 4
        : 1;

    let last: GoformSetResult = {};

    for (
      let attempt = 0;
      attempt < maxAttempts;
      attempt += 1
    ) {
      last =
        await this.sendSet(
          request,
          authenticated,
        );

      const failed =
        /fail/i.test(
          last.result ?? '',
        );

      if (
        !authenticated ||
        !failed
      ) {
        break;
      }

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 250),
      );
    }

    return last;
  }

  /**
   * Actually construct and send the POST.
   */
  private async sendSet(
    request: SetCommandRequest,
    authenticated: boolean,
  ): Promise<GoformSetResult> {
    const body =
      new URLSearchParams();

    /**
     * Match stock ZTE WebUI exactly.
     */
    body.set(
      'isTest',
      'false',
    );

    body.set(
      'goformId',
      request.goformId,
    );

    for (
      const [key, value]
      of Object.entries(
        request.params ?? {},
      )
    ) {
      body.set(
        key,
        String(value),
      );
    }

    if (authenticated) {
      try {
        const {
          ad,
        } =
          await this.buildTokens();

        /**
         * IMPORTANT:
         *
         * Send AD only.
         *
         * Do NOT send RD.
         */
        body.set(
          'AD',
          ad,
        );
      } catch (err) {
        /**
         * LOGIN on older firmware may not
         * support RD/AD.
         */
        if (
          (request.tokens ?? 'require') !==
          'try'
        ) {
          throw err;
        }
      }
    }

    const url =
      `${this.baseUrl}${GOFORM_SET_ENDPOINT}`;

    const started =
      performance.now();

    const loggedParams =
      Object.fromEntries(
        body.entries(),
      );

    try {
      const res =
        await this.fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded',
              Accept:
                'application/json',
            },
            body:
              body.toString(),
          },
        );

      if (!res.ok) {
        throw new GoformError(
          `POST failed (${res.status})`,
          {
            endpoint:
              GOFORM_SET_ENDPOINT,
            goformId:
              request.goformId,
            status:
              res.status,
          },
        );
      }

      const data =
        this.parseJson<GoformSetResult>(
          res,
          GOFORM_SET_ENDPOINT,
          request.goformId,
        );

      this.emit({
        method: 'POST',
        endpoint:
          GOFORM_SET_ENDPOINT,
        label:
          request.goformId,
        params:
          loggedParams,
        durationMs:
          Math.round(
            performance.now() - started,
          ),
        ok: true,
        status:
          res.status,
        responsePreview:
          JSON.stringify(data).slice(
            0,
            2000,
          ),
      });

      return data;
    } catch (err) {
      this.emit({
        method: 'POST',
        endpoint:
          GOFORM_SET_ENDPOINT,
        label:
          request.goformId,
        params:
          loggedParams,
        durationMs:
          Math.round(
            performance.now() - started,
          ),
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : String(err),
      });

      throw err;
    }
  }

  /**
   * Build fresh authentication tokens.
   *
   * Version strings are resolved first.
   * RD is intentionally the LAST GET.
   *
   * This is important because the firmware can rotate
   * RD when it is read.
   */
  private async buildTokens(): Promise<{
    rd: string;
    ad: string;
  }> {
    const {
      waInnerVersion,
      crVersion,
    } =
      await this.loadVersions();

    /**
     * RD must be the final GET immediately
     * before BAND_SELECT or another authenticated POST.
     */
    const rd =
      await this.getValue('RD');

    if (!rd) {
      throw new GoformError(
        'Could not read RD token from router',
        {
          endpoint:
            GOFORM_GET_ENDPOINT,
          command:
            'RD',
        },
      );
    }

    /**
     * Firmware detection is the primary mechanism because
     * G5B was directly observed using a 64-character AD.
     *
     * If a custom AuthStrategy explicitly provides a hash mode,
     * use it unless this is a known SHA-256 family.
     */
    const detectedMode =
      getAdHashMode(
        waInnerVersion,
        crVersion,
      );

    const strategyMode =
      this.getStrategyHashMode();

    const mode: AdHashMode =
      detectedMode === 'sha256'
        ? 'sha256'
        : strategyMode ?? detectedMode;

    /**
     * Use the router-family-specific hash
     * instead of blindly using MD5.
     *
     * G5B observed AD = 64 hex chars,
     * therefore SHA-256 is used for G5B.
     */
    const ad =
      computeAd(
        mode,
        rd,
        waInnerVersion,
        crVersion,
      );

    return {
      rd,
      ad,
    };
  }

  /**
   * Load firmware identity.
   *
   * cr_version is only useful after authentication,
   * therefore an incomplete result is never cached.
   */
  private async loadVersions(): Promise<{
    waInnerVersion: string;
    crVersion: string;
  }> {
    if (this.versionCache) {
      return this.versionCache;
    }

    const result =
      await this.get({
        cmd: [
          'wa_inner_version',
          'cr_version',
        ],
      });

    const versions = {
      waInnerVersion:
        result.wa_inner_version ?? '',
      crVersion:
        result.cr_version ?? '',
    };

    if (versions.crVersion) {
      this.versionCache =
        versions;
    }

    return versions;
  }

  /**
   * HTTP transport wrapper.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit & {
      body?: string;
    },
  ): Promise<HttpResult> {
    try {
      return await httpRequest({
        method:
          (init.method as
            | 'GET'
            | 'POST') ?? 'GET',
        url,
        headers:
          init.headers as
            | Record<string, string>
            | undefined,
        body:
          init.body,
        timeoutMs:
          this.timeoutMs,
      });
    } catch (err) {
      throw new GoformError(
        err instanceof Error
          ? err.message
          : 'Network error',
        {
          endpoint:
            url,
        },
      );
    }
  }

  /**
   * Parse router response.
   *
   * Some ZTE firmware reports
   * Content-Type: text/html while
   * the body is actually JSON.
   */
  private parseJson<T>(
    res: HttpResult,
    endpoint: string,
    command: string,
  ): T {
    try {
      return JSON.parse(
        res.text,
      ) as T;
    } catch {
      throw new GoformError(
        'Response was not valid JSON',
        {
          endpoint,
          command,
          body:
            res.text.slice(
              0,
              500,
            ),
        },
      );
    }
  }
}
