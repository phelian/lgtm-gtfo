import {
  clearStoredToken,
  getAccessToken as getToken,
  type OAuthConfig,
} from "../shared/oauth.ts";

const CLIENT_IDS: Record<string, string> = {
  "azure-cli": "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
  "office": "d3590ed6-52b3-4102-aeff-aad2292ab01c",
  "teams": "1fec8e78-bce4-4aaf-ab1b-5451cc387264",
  "powershell": "1950a258-227b-4e31-a9cf-717495945fc2",
};

const REDIRECT_URIS: Record<string, string> = {
  "azure-cli": "http://localhost:8400",
  "office": "https://login.microsoftonline.com/common/oauth2/nativeclient",
  "teams": "https://login.microsoftonline.com/common/oauth2/nativeclient",
  "powershell": "http://localhost:8400",
};

const SCOPES = ["https://graph.microsoft.com/Mail.ReadWrite", "offline_access"];

const getClientName = (): string => Deno.env.get("MS_CLIENT_ID") ?? "azure-cli";

const getClientId = (): string => {
  const name = getClientName();
  return CLIENT_IDS[name] ?? name;
};

const getRedirectUri = (clientName: string): string =>
  REDIRECT_URIS[clientName] ?? "http://localhost:8400";

export const listClients = (): void => {
  console.log("Available client IDs (set via MS_CLIENT_ID env var):\n");
  for (const [name, id] of Object.entries(CLIENT_IDS)) {
    console.log(`  ${name}: ${id}`);
  }
  console.log("\nOr set MS_CLIENT_ID to a custom client ID directly.");
};

const getConfig = (): OAuthConfig => {
  const clientName = getClientName();
  const redirectUri = getRedirectUri(clientName);
  return {
    clientId: getClientId(),
    clientName,
    scopes: SCOPES,
    redirectUri,
    tokenFileName: "tokens.json",
    useNativeRedirect: redirectUri.includes("nativeclient"),
  };
};

export const getAccessToken = (): Promise<string> => getToken(getConfig());

export const clearGraphToken = (): Promise<void> =>
  clearStoredToken("tokens.json");
