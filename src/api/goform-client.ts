import {
  GoformError,
  type GetCommandRequest,
  type GoformGetResult,
  type GoformSetResult,
  type SetCommandRequest,
} from '@/types';
import { GOFORM_GET_ENDPOINT, GOFORM_SET_ENDPOINT } from '@/reverse/knowledge/seed';
import { classicZteAuth, type AuthStrategy } from './auth';
import { httpRequest, type HttpResult } from './transport';

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
   * Base URL prefix. Empty string means "same origin" — the recommended mode,
   * where the Vite proxy (dev) or a reverse proxy (prod) forwards to the router
   * so requests stay same-origin and localhost-only. May be set to a direct
   * `http://192.168.0.1` if the router allows CORS (most do not).
   */
  baseUrl?: string;

  authStrategy?: AuthStrategy;

  /** Milliseconds before a request is aborted. */
  timeoutMs?: number;

  /** Optional sink for the developer-mode network logger. */
  onTraffic?: (event: GoformTrafficEvent) => void;
}

/**
 * The single choke point for all router traffic.
 *
 * Everything above this layer speaks in commands, never in URLs.
 *
 * Responsible for:
 *   - GET reads (single + multi),
 *   - authenticated POST actions,
 *   - fetching RD,
 *   - computing AD,
 *   - attaching authentication data,
 *   - caching the firmware identity strings used to sign requests.
 *
 * IMPORTANT:
 * BAND_SELECT on the verified G5B firmware uses RD internally to calculate
 * AD, but the original router JavaScript sends AD without including RD as a
 * POST parameter.
 */
export class GoformClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private authStrategy: AuthStrategy;
  private readonly onTraffic:
    | ((event: GoformTrafficEvent) => void)
    | undefined;

  private eventSeq = 0;

  /** Cached firmware identity used as auth inputs; read lazily. */
  private versionCache: {
    waInnerVersion: string;
    crVersion: string;
  } | null = null;

  constructor(config: GoformClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? '';
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.authStrategy = config.authStrategy ?? classicZteAuth;
    this.onTraffic = config.onTraffic;
  }

  private emit(
    event: Omit<GoformTrafficEvent, 'id' | 'timestamp'>,
  ): void {
    if (!this.onTraffic) return;

    this.onTraffic({
      ...event,
      id: `req-${Date.now()}-${this.eventSeq++}`,
      timestamp: Date.now(),
    });
  }

  setAuthStrategy(strategy: AuthStrategy): void {
    this.authStrategy = strategy;
    this.versionCache = null;
  }

  /**
   * Cheap protocol probe used by router auto-discovery.
   *
   * Does this host answer the goform GET endpoint with JSON?
   * Only ZTE firmware does — any other web server 404s or returns HTML,
   * which fails JSON parsing.
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

  /** Read one or more commands. Returns the raw string map from the firmware. */
  async get(request: GetCommandRequest): Promise<GoformGetResult> {
    const cmds = Array.isArray(request.cmd)
      ? request.cmd
      : [request.cmd];

    const multi = request.multi ?? cmds.length > 1;

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
      const res = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        throw new GoformError(
          `GET failed (${res.status})`,
          {
            endpoint: GOFORM_GET_ENDPOINT,
            command: cmds.join(','),
            status: res.status,
          },
        );
      }

      const data = this.parseJson<GoformGetResult>(
        res,
        GOFORM_GET_ENDPOINT,
        cmds.join(','),
      );

      this.emit({
        method: 'GET',
        endpoint: GOFORM_GET_ENDPOINT,
        label: cmds.join(','),
        params: {
          cmd: cmds.join(','),
          ...(multi ? { multi_data: '1' } : {}),
        },
        durationMs: Math.round(
          performance.now() - started,
        ),
        ok: true,
        status: res.status,
        responsePreview: JSON.stringify(data).slice(
          0,
          2000,
        ),
      });

      return data;
    } catch (err) {
      this.emit({
        method: 'GET',
        endpoint: GOFORM_GET_ENDPOINT,
        label: cmds.join(','),
        params: {
          cmd: cmds.join(','),
        },
        durationMs: Math.round(
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

  /** Convenience: read a single command and return just its value. */
  async getValue(cmd: string): Promise<string | null> {
    const result = await this.get({ cmd });
    return result[cmd] ?? null;
  }

  /**
   * Fire an action command, attaching authentication data unless disabled.
   *
   * Authentication behaviour:
   *
   *   1. Read the current RD.
   *   2. Calculate:
   *
   *        AD = MD5(MD5(wa_inner_version + cr_version) + RD)
   *
   *   3. Send AD with the POST.
   *
   * For BAND_SELECT specifically, the verified G5B firmware expects AD but
   * does NOT expect RD as a POST parameter. RD is therefore used only for
   * calculating AD.
   *
   * Other authenticated commands retain the existing AD + RD behaviour.
   *
   * The firmware rotates RD on reads, so a concurrent poll can invalidate
   * the signature between signing and sending. We therefore retry an
   * authenticated failure a few times, each with a fresh RD read immediately
   * before the POST.
   *
   * Idempotent lock commands make retries safe.
   */
  async set(
    request: SetCommandRequest,
  ): Promise<GoformSetResult> {
    const authenticated =
      request.authenticated ?? true;

    const maxAttempts =
      authenticated && request.retry !== false
        ? 4
        : 1;

    let last: GoformSetResult = {};

    for (
      let attempt = 0;
      attempt < maxAttempts;
      attempt += 1
    ) {
      last = await this.sendSet(
        request,
        authenticated,
      );

      const failed = /fail/i.test(
        last.result ?? '',
      );

      if (!authenticated || !failed) {
        break;
      }

      // Small backoff, then retry with a freshly-read RD.
      await new Promise((resolve) =>
        setTimeout(resolve, 250),
      );
    }

    return last;
  }

  private async sendSet(
    request: SetCommandRequest,
    authenticated: boolean,
  ): Promise<GoformSetResult> {
    const body = new URLSearchParams();

    body.set('isTest', 'false');
    body.set('goformId', request.goformId);

    for (const [key, value] of Object.entries(
      request.params ?? {},
    )) {
      body.set(key, String(value));
    }

    if (authenticated) {
      try {
        /**
         * IMPORTANT:
         *
         * buildTokens() still reads RD because RD is part of the
         * signature calculation.
         *
         * We deliberately do NOT remove RD from the authentication
         * calculation.
         */
        const { rd, ad } =
          await this.buildTokens();

        /**
         * AD is always required for the classic ZTE
         * authenticated request.
         */
        body.set('AD', ad);

        /**
         * Verified G5B behaviour:
         *
         * BAND_SELECT:
         *   POST contains AD
         *   POST does NOT contain RD
         *
         * Other authenticated commands:
         *   POST contains AD + RD
         */
        if (request.goformId !== 'BAND_SELECT') {
          body.set('RD', rd);
        }
      } catch (err) {
        /**
         * 'try' = best-effort signing (LOGIN):
         * older firmwares have no RD command, and login there
         * must simply go out unsigned.
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

    const started = performance.now();

    const loggedParams =
      Object.fromEntries(body.entries());

    try {
      const res =
        await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        });

      if (!res.ok) {
        throw new GoformError(
          `POST failed (${res.status})`,
          {
            endpoint: GOFORM_SET_ENDPOINT,
            goformId: request.goformId,
            status: res.status,
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
        endpoint: GOFORM_SET_ENDPOINT,
        label: request.goformId,
        params: loggedParams,
        durationMs: Math.round(
          performance.now() - started,
        ),
        ok: true,
        status: res.status,
        responsePreview: JSON.stringify(
          data,
        ).slice(0, 2000),
      });

      return data;
    } catch (err) {
      this.emit({
        method: 'POST',
        endpoint: GOFORM_SET_ENDPOINT,
        label: request.goformId,
        params: loggedParams,
        durationMs: Math.round(
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
   * Read a fresh RD nonce and derive the AD signature for it.
   *
   * Order matters:
   *
   *   1. Resolve firmware version strings.
   *   2. Read RD as the final GET.
   *   3. Calculate AD from that RD.
   *   4. Immediately perform the POST.
   *
   * This mirrors the stock ZTE web UI behaviour.
   *
   * RD itself is returned to sendSet() because some authenticated
   * commands still require RD in their POST body.
   *
   * BAND_SELECT uses the same RD internally but intentionally does
   * not transmit it as a POST parameter.
   */
  private async buildTokens(): Promise<{
    rd: string;
    ad: string;
  }> {
    const {
      waInnerVersion,
      crVersion,
    } = await this.loadVersions();

    const rd = await this.getValue('RD');

    if (!rd) {
      throw new GoformError(
        'Could not read RD token from router',
        {
          endpoint: GOFORM_GET_ENDPOINT,
          command: 'RD',
        },
      );
    }

    const ad =
      this.authStrategy.computeAd({
        rd,
        waInnerVersion,
        crVersion,
      });

    return {
      rd,
      ad,
    };
  }

  private async loadVersions(): Promise<{
    waInnerVersion: string;
    crVersion: string;
  }> {
    /**
     * cr_version is only non-empty once the session is
     * logged in, so we do NOT cache an incomplete result.
     *
     * Otherwise AD would stay wrong after login.
     */
    if (this.versionCache) {
      return this.versionCache;
    }

    const result = await this.get({
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
      this.versionCache = versions;
    }

    return versions;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit & {
      body?: string;
    },
  ): Promise<HttpResult> {
    try {
      return await httpRequest({
        method:
          (init.method as 'GET' | 'POST') ??
          'GET',
        url,
        headers:
          init.headers as
            | Record<string, string>
            | undefined,
        body: init.body,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw new GoformError(
        err instanceof Error
          ? err.message
          : 'Network error',
        {
          endpoint: url,
        },
      );
    }
  }

  private parseJson<T>(
    res: HttpResult,
    endpoint: string,
    command: string,
  ): T {
    try {
      /**
       * ZTE firmware sometimes returns text/html
       * content-type for JSON bodies.
       */
      return JSON.parse(res.text) as T;
    } catch {
      throw new GoformError(
        'Response was not valid JSON',
        {
          endpoint,
          command,
          body: res.text.slice(0, 500),
        },
      );
    }
  }
}
