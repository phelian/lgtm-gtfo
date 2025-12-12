import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path/join";

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export type StoredToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

export type OAuthConfig = {
  clientId: string;
  clientName: string;
  scopes: string[];
  redirectUri: string;
  tokenFileName: string;
  useNativeRedirect: boolean;
};

const TENANT = "organizations";
const REDIRECT_PORT = 8400;

export const generateCodeVerifier = (): string => {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

export const generateCodeChallenge = async (
  verifier: string,
): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

export const getConfigDir = async (): Promise<string> => {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const configDir = join(home, ".config", "lgtm-gtfo");
  await ensureDir(configDir);
  return configDir;
};

export const loadStoredToken = async (
  tokenFileName: string,
): Promise<StoredToken | null> => {
  try {
    const configDir = await getConfigDir();
    const tokenPath = join(configDir, tokenFileName);
    const content = await Deno.readTextFile(tokenPath);
    return JSON.parse(content) as StoredToken;
  } catch {
    return null;
  }
};

export const saveToken = async (
  tokenFileName: string,
  token: StoredToken,
): Promise<void> => {
  const configDir = await getConfigDir();
  const tokenPath = join(configDir, tokenFileName);
  await Deno.writeTextFile(tokenPath, JSON.stringify(token, null, 2));
};

export const clearStoredToken = async (
  tokenFileName: string,
): Promise<void> => {
  try {
    const configDir = await getConfigDir();
    const tokenPath = join(configDir, tokenFileName);
    await Deno.remove(tokenPath);
    console.log("Stored token cleared.");
  } catch {
    // Token file doesn't exist, nothing to clear
  }
};

export const waitForAuthCode = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();

    console.log(
      `Listening on http://localhost:${REDIRECT_PORT} for callback...`,
    );

    const server = Deno.serve(
      { port: REDIRECT_PORT, signal: ac.signal, onListen: () => {} },
      (request) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");

        setTimeout(() => ac.abort(), 100);

        if (error) {
          reject(new Error(`Auth failed: ${errorDesc}`));
          return new Response(
            `<html><body><h1>Authentication Failed</h1><p>${errorDesc}</p></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!code) {
          reject(new Error("No authorization code received"));
          return new Response(
            "<html><body><h1>No code received</h1></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        resolve(code);
        return new Response(
          "<html><body><h1>Authentication Successful!</h1><p>You can close this window.</p></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
    );

    server.finished.catch(() => {});
  });
};

export const promptForAuthCode = async (): Promise<string> => {
  console.log(
    "\nAfter signing in, you'll be redirected to a page showing an authorization code.",
  );
  console.log("Copy and paste that code here:\n");

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    throw new Error("No input received");
  }
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
};

export const exchangeCodeForToken = async (
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> => {
  const response = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
        scope: config.scopes.join(" "),
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
};

export const refreshAccessToken = async (
  config: OAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> => {
  const response = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: config.scopes.join(" "),
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  return response.json();
};

export const buildAuthUrl = (
  config: OAuthConfig,
  codeChallenge: string,
): URL => {
  const authUrl = new URL(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
  );
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", config.redirectUri);
  authUrl.searchParams.set("scope", config.scopes.join(" "));
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  return authUrl;
};

export const openBrowser = (url: string): void => {
  const openCommand = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "start"
    : "xdg-open";
  const cmd = new Deno.Command(openCommand, { args: [url] });
  cmd.spawn();
};

export const getAccessToken = async (config: OAuthConfig): Promise<string> => {
  const stored = await loadStoredToken(config.tokenFileName);

  if (stored && stored.expiresAt > Date.now() + 60000) {
    return stored.accessToken;
  }

  if (stored?.refreshToken) {
    try {
      console.log("Refreshing access token...");
      const tokenResponse = await refreshAccessToken(
        config,
        stored.refreshToken,
      );
      const newToken: StoredToken = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? stored.refreshToken,
        expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      };
      await saveToken(config.tokenFileName, newToken);
      return newToken.accessToken;
    } catch (e) {
      console.log(`Token refresh failed: ${e}, starting new authentication`);
    }
  }

  console.log(
    `Starting interactive authentication (client: ${config.clientName})...`,
  );

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const authUrl = buildAuthUrl(config, codeChallenge);

  console.log("\nOpening browser for authentication...");
  console.log(`If browser doesn't open, visit:\n${authUrl.toString()}\n`);

  openBrowser(authUrl.toString());

  const code = config.useNativeRedirect
    ? await promptForAuthCode()
    : await waitForAuthCode();
  const tokenResponse = await exchangeCodeForToken(config, code, codeVerifier);

  const newToken: StoredToken = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
  };

  await saveToken(config.tokenFileName, newToken);
  console.log("Authentication successful!\n");

  return newToken.accessToken;
};
