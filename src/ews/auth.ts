import {
  clearStoredToken,
  getAccessToken as getToken,
  type OAuthConfig,
} from "../shared/oauth.ts";

const CLIENT_IDS: Record<string, string> = {
  "azure-cli": "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
  "powershell": "1950a258-227b-4e31-a9cf-717495945fc2",
};

const EWS_SCOPES = [
  "https://outlook.office365.com/EWS.AccessAsUser.All",
  "offline_access",
];

const getClientName = (): string => Deno.env.get("MS_CLIENT_ID") ?? "azure-cli";

const getClientId = (): string => {
  const name = getClientName();
  return CLIENT_IDS[name] ?? name;
};

export const listClients = (): void => {
  console.log("Available client IDs for EWS (set via MS_CLIENT_ID env var):\n");
  for (const [name, id] of Object.entries(CLIENT_IDS)) {
    console.log(`  ${name}: ${id}`);
  }
  console.log("\nOr set MS_CLIENT_ID to a custom client ID directly.");
};

const getConfig = (): OAuthConfig => {
  const clientName = getClientName();
  return {
    clientId: getClientId(),
    clientName,
    scopes: EWS_SCOPES,
    redirectUri: "http://localhost:8400",
    tokenFileName: "ews-tokens.json",
    useNativeRedirect: false,
  };
};

export const getEwsAccessToken = (): Promise<string> => getToken(getConfig());

export const clearEwsStoredToken = (): Promise<void> =>
  clearStoredToken("ews-tokens.json");
